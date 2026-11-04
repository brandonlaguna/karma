import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { embedText } from "../knowledge/embeddings.js";
import { searchKnowledgeBase } from "../knowledge/qdrant.js";
import { getEscalationMatrix } from "../db/escalation.js";
import { findDevice } from "../db/devices.js";
import * as opmanager from "../tools/opmanager.js";
import * as epistech from "../tools/epistech.js";

/**
 * Arma un McpServer con las tools registradas. Se crea uno NUEVO por
 * cada request a /mcp (modo stateless) -- mismo patrón que el ejemplo
 * oficial del SDK (examples/server/simpleStatelessStreamableHttp.js).
 * No hay sesión que mantener entre llamadas: cada POST /mcp es
 * independiente, más simple de razonar para un servicio interno como
 * este y sin estado colgado si el proceso se reinicia a medio camino.
 *
 * Agregar una tool nueva = un registerTool() más acá. No hace falta
 * tocar nada en ai-backend -- las tools se descubren en vivo vía
 * client.listTools() (ver backend/src/mcp/client.js).
 */
/**
 * Fuentes (vendors) cuyas tools se exponen al modelo, desde ENABLED_VENDORS (separadas por coma, ej. "zabbix" o
 * "opmanager,zabbix"). Vacío = todas. Cada despliegue monitorea SU stack (Fusionet solo Zabbix, Atento OpManager):
 * mostrarle al modelo tools de una fuente que no existe en ese cliente lo lleva a ofrecerlas y a fallar al usarlas,
 * y además cada tool listada cuesta tokens en CADA mensaje.
 */
export function isVendorEnabled(vendor: string, raw: string | undefined = process.env.ENABLED_VENDORS): boolean {
  const list = (raw ?? "").trim().toLowerCase();
  if (!list) return true;
  return list.split(",").map((item) => item.trim()).includes(vendor);
}

export function buildServer() {
  const server = new McpServer({
    name: "epistech-ai-lab-mcp",
    version: "1.0.0",
  });

  // Igual que server.registerTool, pero solo si la fuente está habilitada en este despliegue (ENABLED_VENDORS).
  const registerForVendor = (vendor: string, ...args: Parameters<typeof server.registerTool>) => {
    if (isVendorEnabled(vendor)) server.registerTool(...args);
  };

  // Con más de una fuente activa (Atento: OpManager + Zabbix) el resultado de un resumen o ranking lleva escrita su fuente
  // y su alcance: el modelo ignoraba la regla del prompt y presentaba la cifra de Zabbix como total del monitoreo. Con una
  // sola fuente (Fusionet) la respuesta no cambia.
  const withSourceScope = <T>(source: string, others: string, result: T): T | (Record<string, unknown> & T) => {
    const multiSource = isVendorEnabled("zabbix") && isVendorEnabled("opmanager");
    if (!multiSource || !result || typeof result !== "object" || Array.isArray(result)) return result;
    return {
      fuente: source,
      alcance: `Estas cifras son SOLO de ${source}. No incluyen ${others}. Al responder, di siempre "en ${source} hay…" y aclara que lo de ${others} no está incluido.`,
      ...result,
    };
  };

  server.registerTool(
    "get_current_time",
    {
      title: "Hora actual",
      description: "Obtiene la hora actual del servidor en formato ISO 8601.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    })
  );

  server.registerTool(
    "get_system_info",
    {
      title: "Información del sistema",
      description: "Obtiene información básica del entorno donde corre el MCP server.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            hostname: "ai-lab",
            environment: process.env.NODE_ENV || "development",
            status: "running",
          }),
        },
      ],
    })
  );

  // Tool de ejemplo con parámetros -- deja el patrón listo para cuando
  // agreguemos las tools reales de Epistech (consultar alerta por id,
  // ping a un host, etc). El shape de zod define el inputSchema que ve
  // el modelo; MCP lo convierte solo a JSON Schema.
  server.registerTool(
    "echo",
    {
      title: "Echo (prueba)",
      description: "Repite el texto que se le pasa. Sirve para probar que el paso de argumentos funciona end-to-end.",
      inputSchema: {
        text: z.string().describe("Texto a repetir"),
      },
    },
    async ({ text }) => ({
      content: [{ type: "text", text }],
    })
  );

  // RAG sobre la base de conocimiento organizacional (políticas ITIL,
  // contactos, matriz de escalamiento, procedimientos -- lo que se haya
  // cargado vía knowledge-base/ + `pnpm run ingest`). Búsqueda por
  // similitud semántica contra Qdrant, no texto exacto.
  server.registerTool(
    "search_knowledge_base",
    {
      title: "Buscar en la base de conocimiento",
      description:
        "Busca por similitud semántica en los documentos reales cargados (políticas ITIM, políticas de gestión de alertamiento, procedimientos, nomenclatura de dispositivos, y lo que se vaya agregando en knowledge-base/). Úsala para cualquier pregunta sobre QUÉ DICE un documento/política/procedimiento -- incluye preguntas de responsabilidad/RACI documentada (ej. \"¿quién es responsable de la capa de infraestructura?\", \"¿qué dice la política de X?\") aunque la pregunta use la palabra 'responsable' o 'escalar'. Para eso NO uses 'get_escalation_matrix' -- esa es una tabla de contactos aparte (Postgres), no el contenido de las políticas.",
      inputSchema: {
        query: z.string().describe("Pregunta o tema a buscar en la base de conocimiento"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Cantidad máxima de resultados a devolver (default 5)"),
      },
    },
    async ({ query, limit }) => {
      const vector = await embedText(query);
      const results = await searchKnowledgeBase(vector, limit || 5);

      if (!results.length) {
        return {
          content: [
            {
              type: "text",
              text: "No se encontró nada relevante en la base de conocimiento para esa consulta. Puede que todavía no se haya cargado (ver knowledge-base/README.md).",
            },
          ],
        };
      }

      const text = results
        .map((r, i) => {
          const sourceLabel = r.payload?.heading
            ? `${r.payload?.source ?? "desconocida"} > ${r.payload.heading}`
            : (r.payload?.source ?? "desconocida");
          return `[${i + 1}] (fuente: ${sourceLabel}, similitud: ${r.score.toFixed(3)})\n${r.payload?.text ?? ""}`;
        })
        .join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // Matriz RACI de escalamiento (Postgres propia de ai-lab, separada de
  // la MariaDB de Epistech). Resuelve el país por código ISO o por el
  // ID de sonda de OpManager que generó la alerta -- si hay una regla
  // específica de país, esa tiene prioridad sobre la regla global.
  server.registerTool(
    "get_escalation_matrix",
    {
      title: "Matriz de escalamiento (contactos)",
      description:
        "Consulta la matriz de CONTACTOS de escalamiento de incidentes (tabla estructurada en Postgres, NO documentación/políticas): a quién llamar/notificar en cada nivel (0=contacto inicial, 1/2/3=escalamiento creciente hasta crisis) para un área/equipo dado (ej. 'Redes', 'Servidores', 'BBDD', 'Infraestructura Royal'). Úsala SOLO para \"¿a quién contacto/escalo esto?\" -- NO para preguntas sobre qué dice una política, de quién es la responsabilidad de una capa/proceso según un documento, o cualquier cosa que suene a estar definida en un procedimiento escrito (eso es 'search_knowledge_base', que busca sobre las políticas/procedimientos reales cargados). Se le puede pasar el código de país (ISO, ej. 'CO') o el ID de la sonda de OpManager que generó la alerta para resolver automáticamente el país y sus reglas específicas. Para acotar a un área específica, PREFIERE 'resolverGroupCode' (el customField 'Grupo Resolutor' de get_device_notes, ej. 'CO-REDES') o 'siteCode' (el customField 'Site', ej. 'ROYAL', para las áreas de infraestructura por sede) -- son match exacto. 'teamName' es solo un respaldo por nombre difuso si no se tiene ninguno de los dos códigos.",
      inputSchema: {
        countryCode: z.string().optional().describe("Código de país ISO 3166-1 alpha-2, ej. 'CO', 'PE', 'EC'"),
        opmanagerProbeId: z.string().optional().describe("ID de la sonda de OpManager que generó la alerta, para resolver el país automáticamente"),
        levelNumber: z.number().int().optional().describe("Filtrar por nivel de escalamiento específico (0, 1, 2 o 3). Si se omite, devuelve todos los niveles."),
        resolverGroupCode: z.string().optional().describe("Código exacto del customField 'Grupo Resolutor' de get_device_notes, ej. 'CO-REDES', 'CO-SERVIDORES'. Preferido sobre teamName."),
        siteCode: z.string().optional().describe("Código exacto del customField 'Site' de get_device_notes, ej. 'ROYAL'. Para áreas de infraestructura ligadas a una sede."),
        teamName: z.string().optional().describe("Área/equipo a consultar por nombre (ej. 'Redes', 'BBDD') -- respaldo difuso si no se tiene resolverGroupCode ni siteCode. Si se omite todo, trae todas las áreas."),
      },
    },
    async ({ countryCode, opmanagerProbeId, levelNumber, resolverGroupCode, siteCode, teamName }) => {
      const { resolvedCountry, rows } = await getEscalationMatrix({
        countryCode,
        opmanagerProbeId,
        levelNumber,
        resolverGroupCode,
        siteCode,
        teamName,
      });

      if (!rows.length) {
        return {
          content: [
            {
              type: "text",
              text: "No hay matriz de escalamiento cargada todavía (tablas vacías). Hay que insertar los niveles, equipos/contactos y reglas RACI en Postgres.",
            },
          ],
        };
      }

      const header = resolvedCountry
        ? `País resuelto: ${resolvedCountry.name} (${resolvedCountry.iso_code})\n\n`
        : countryCode || opmanagerProbeId
        ? "No se pudo resolver el país indicado; mostrando solo reglas globales.\n\n"
        : "";

      const text =
        header +
        rows
          .map((r) => {
            const who = r.contact_name
              ? `${r.contact_name}${r.team_name ? ` (${r.team_name})` : ""}${r.contact_email ? `, ${r.contact_email}` : ""}${r.contact_phone ? `, ${r.contact_phone}` : ""}`
              : r.team_name ?? "sin asignar";
            const scope = r.is_country_override ? "[regla específica de país]" : "[regla global]";
            const extra = [
              r.schedule ? `Horario: ${r.schedule}` : null,
              r.response_time ? `Tiempo de respuesta: ${r.response_time}` : null,
            ]
              .filter(Boolean)
              .join(" | ");
            return `Nivel ${r.level_number} - ${r.level_name} ${scope}\n  Rol RACI: ${r.raci_role} -> ${who}${
              extra ? `\n  ${extra}` : ""
            }${r.raci_description ? `\n  Nota: ${r.raci_description}` : ""}`;
          })
          .join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // Inventario propio de dispositivos (Postgres) -- catalogado a mano
  // desde los Excel de NOC. Respaldo cuando get_device_notes no trae
  // customFields completos: si el dispositivo ya está catalogado acá,
  // resuelve país/ciudad/sede/grupo de soporte por lookup exacto, sin
  // depender de parsear el nombre.
  server.registerTool(
    "search_device_inventory",
    {
      title: "Inventario propio de dispositivos",
      description:
        "Busca un dispositivo por nombre en el inventario propio (catalogado desde los Excel de NOC), para resolver país/ciudad/sede/grupo de soporte cuando get_device_notes no trae customFields completos. Úsala como respaldo, no como primera opción -- primero intenta con get_device_notes.",
      inputSchema: {
        deviceName: z.string().describe("Nombre completo o parcial del dispositivo a buscar"),
      },
    },
    async ({ deviceName }) => {
      const result = await findDevice(deviceName);

      if (!result || (Array.isArray(result) && !result.length)) {
        return {
          content: [
            {
              type: "text",
              text: `No se encontró "${deviceName}" en el inventario propio. Si tienes la nomenclatura del nombre, consulta search_knowledge_base para decodificarla manualmente.`,
            },
          ],
        };
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ------------------------------------------------------------------
  // Alerta centralizada de Epistech -- SIEMPRE la primera tool del
  // flujo de triage. El mensaje inicial de la conversación solo trae el
  // ID interno de la alerta (no el JSON completo, para no mandar un
  // payload pesado desde el frontend); esta tool trae el detalle real
  // desde `alerts`, incluyendo el JSON crudo del vendor (json_result)
  // que necesitan las demás tools de OpManager más abajo.
  // ------------------------------------------------------------------

  server.registerTool(
    "get_alert_by_id",
    {
      title: "Alerta de Epistech por ID",
      description:
        "Trae el detalle completo de una alerta desde la tabla centralizada de Epistech (alerts), discriminada por vendor (Zabbix, OpManager, etc), a partir de su ID interno. SIEMPRE es la PRIMERA tool a llamar en una conversación de triage de alerta -- el mensaje inicial del usuario solo trae ese ID, no la alerta completa. La respuesta incluye: message, severity, source, vendor_name, status_name/status_color (estado actual), status_history (historial de transiciones), acknowledge_name, notified_at/resolved_at, y json_result (el JSON crudo tal cual lo mandó el vendor -- ahí están los identificadores que piden las demás tools: probeid, entity, elementid, etc).",
      inputSchema: {
        alertId: z
          .union([z.string(), z.number()])
          .describe("ID interno de la alerta en Epistech (alerts.id -- el autoincremental propio, NO el alert_id del vendor)"),
      },
    },
    async ({ alertId }) => {
      const result = await epistech.getAlertById({ alertId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ------------------------------------------------------------------
  // Alertas de ZABBIX -- reusan los endpoints /api/insights de
  // EpistechBackend (mismo patrón que las demás tools: no le hablan a
  // Zabbix directo). Los hechos (conteos, duraciones, recurrencia,
  // concurrencia) salen de consultas exactas; el modelo solo los
  // interpreta.
  // ------------------------------------------------------------------

  server.registerTool(
    "find_alert_by_alert_id",
    {
      title: "Buscar una alerta por el Alert ID que se ve en pantalla",
      description:
        "Resuelve el \"Alert ID\" que el usuario ve en la columna de la pantalla de Management (el número que genera el VENDOR: evento de Zabbix, alarma de OpManager, etc.) a la alerta de EPISTECH y a su FUENTE, deduciendo el vendor de la base de datos en vez de suponerlo. Úsala SIEMPRE que el usuario te dé un número de alerta y no tengas la certeza de su fuente o de que sea el id interno. Cada coincidencia trae el \"id\" interno, la fuente, el mensaje, la severidad y un \"siguientePaso\" con la herramienta que corresponde. IMPORTANTE: el mismo número puede existir en dos fuentes distintas (\"ambigua\": true): en ese caso NO elijas por tu cuenta, muestra las opciones con su fuente y pregunta de cuál se trata. Si no hay coincidencias, dilo tal cual, sin inventar.",
      inputSchema: {
        alertId: z
          .union([z.string(), z.number()])
          .describe('El "Alert ID" tal como lo ve el usuario en la pantalla de Management (número del vendor, NO el id interno)'),
      },
    },
    async ({ alertId }) => {
      const result = await epistech.findAlertByVendorId({ alertId });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  registerForVendor(
    "zabbix",
    "get_zabbix_alert_insight",
    {
      title: "Detalle e histórico de una alerta de Zabbix",
      description:
        "Detalle enriquecido de UNA alerta de ZABBIX: (1) contexto EN VIVO -- equipo, disparador con su condición y notas, estado actual, otros problemas abiertos en el mismo equipo y estado del ping; (2) HISTÓRICO del disparador -- cuántas veces ocurrió en las últimas 24 h / 7 d / 30 d / 90 d, duración promedio, mediana y máxima, horarios y días más frecuentes, cuántas veces se recuperó en menos de 5 min (intermitencia), y qué otros problemas del mismo equipo coinciden en el tiempo (posible causa común). Úsala para \"¿por qué pasa esto?\", \"¿cuántas veces se ha repetido?\", \"¿cada cuándo?\", \"¿es recurrente o nuevo?\", \"dame más detalle\" y para analizar cualquier alerta de Zabbix. NO sirve para alertas de OpManager (para esas usa las tools de OpManager). Identifica la alerta con EXACTAMENTE UNO de dos parámetros, sin mezclarlos: \"eventoZabbix\" si el usuario te da el \"Alert ID\" que ve en la pantalla de Management (es el número de evento de Zabbix, p. ej. 42558970), o \"alertId\" si tienes el ID INTERNO (alerts.id, el que trae el listado de get_zabbix_active_overview en el campo \"id\" y el que se usa en get_alert_by_id). Si dudas cuál es, pregúntale al usuario; confundirlos analiza OTRA alerta. Los datos son exactos: cítalos tal cual con su ventana y NO inventes causas que no se desprendan de ellos; si dice que el contexto no está disponible, dilo en vez de suponerlo. Si \"yaRecuperadaEnZabbix\" es true, la alerta ya se resolvió en Zabbix.",
      inputSchema: {
        eventoZabbix: z
          .union([z.string(), z.number()])
          .optional()
          .describe('El "Alert ID" que el usuario ve en la pantalla de Management (número de evento de Zabbix). Usa ESTE o alertId, no ambos.'),
        alertId: z
          .union([z.string(), z.number()])
          .optional()
          .describe("ID INTERNO de la alerta en Epistech (alerts.id; el campo \"id\" del listado de alertas activas). Usa ESTE o eventoZabbix, no ambos."),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Ventana del histórico en días (default 90, máximo 365). Normalmente se omite."),
      },
    },
    async ({ alertId, eventoZabbix, days }) => {
      const result = await epistech.getZabbixAlertInsight({ alertId, eventoZabbix, days });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  registerForVendor(
    "zabbix",
    "find_zabbix_host",
    {
      title: "Buscar un equipo de Zabbix por nombre",
      description:
        "Busca un EQUIPO de Zabbix por su nombre (p. ej. \"RTR-Cartago\") y devuelve, de cada candidato: cliente, sede, criticidad, cuántas alertas tiene abiertas (con su detalle y su id), y cuántos problemas ha tenido en 7 y 30 días (indicador de qué tan \"ruidoso\" es). Úsala SIEMPRE que el usuario mencione un equipo por su nombre, ANTES de analizarlo o de compararlo, y para preguntas como \"¿cómo está RTR-X?\", \"¿tiene muchas alertas?\" o \"compáralo con otros\". REGLA CRÍTICA: equipos de nombre parecido son equipos DISTINTOS (por ejemplo RTR-Cartago y RTR-CCCartago). Si la respuesta trae \"coincidenciaExacta\", usa ESE equipo y no mezcles los parecidos. Si \"requiereConfirmacion\" es true (no hay coincidencia exacta), muestra los candidatos con su sede y pregunta de cuál se trata: NUNCA elijas el que más se parece. Si no hay candidatos, dilo tal cual. Para profundizar en una alerta abierta del equipo usa get_zabbix_alert_insight con el \"id\" que trae.",
      inputSchema: {
        name: z
          .string()
          .min(2)
          .describe('Nombre del equipo tal como lo escribió el usuario, completo o parcial (p. ej. "RTR-Cartago", "Cartago"). Se busca por subcadena, sin distinguir mayúsculas.'),
      },
    },
    async ({ name }) => {
      const result = await epistech.findZabbixHost({ name });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  registerForVendor(
    "zabbix",
    "get_zabbix_active_overview",
    {
      title: "Resumen de alertas activas de Zabbix",
      description:
        "Resumen de las alertas ACTIVAS (abiertas) de Zabbix: total, conteo por severidad, POR CLIENTE (\"porCliente\": es el dato a usar cuando pregunten por clientes; \"Sin cliente asignado\" son equipos cuyo grupo no está registrado como cliente), por grupo de equipos de Zabbix (secundario, puede incluir grupos genéricos), por equipo, y el listado de las más graves con su id interno y su cliente. Úsala para \"¿qué alertas hay activas ahora?\", \"¿cuántas críticas hay?\", \"¿qué cliente tiene más alertas?\", \"¿qué equipos son los más ruidosos?\". Cada alerta se VERIFICA contra Zabbix: solo cuenta como activa si Zabbix confirma que sigue abierta. EPISTECH puede conservar abiertas alertas que en Zabbix ya se recuperaron o ya no existen; esas NO se cuentan y se informan en \"excluidas\" (cítalas aparte si el usuario pregunta por diferencias de cifras). Para solo las graves usa minSeverity=4 (4 = Alta, 5 = Desastre). También trae \"porTipoDeAlerta\" (qué problemas predominan, por su texto), \"porAntiguedad\" (cuánto llevan abiertas, en cuatro grupos que NO se superponen y suman el total) e \"inicioDeAlertasPorHoraUTC\" (cuántas empezaron en cada hora de las últimas 24, en UTC), calculados sobre TODAS las alertas abiertas: úsalos para hablar de patrones, picos u \"oleadas\". Para comparar un equipo con los demás usa get_zabbix_noisiest_hosts. El listado detallado (\"alertas\") cubre solo las más graves hasta el límite: NUNCA extrapoles de él al total ni afirmes fechas o tipos de las que no aparecen ahí. Para profundizar en una alerta del listado usa get_zabbix_alert_insight con su \"id\".",
      inputSchema: {
        minSeverity: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe("Severidad mínima a contar (0 = todas, 3 = Media o más, 4 = Alta o Desastre). Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Cuántas alertas listar, de las más graves a las menos (default 20, máximo 100)."),
      },
    },
    async ({ minSeverity, limit }) => {
      const result = await epistech.getZabbixActiveOverview({ minSeverity, limit });
      return { content: [{ type: "text", text: JSON.stringify(withSourceScope("Zabbix", "OpManager", result)) }] };
    }
  );

  registerForVendor(
    "opmanager",
    "get_opmanager_active_overview",
    {
      title: "Resumen de alertas activas de OpManager",
      description:
        "Resumen de las alertas ABIERTAS de OpManager: total, conteo por severidad, POR PAÍS (\"porPais\"), POR PROBE (\"porProbe\"), por sede, por área, por criticidad del equipo, por tipo de alerta, por equipo, y el listado de las más recientes con su id interno. Úsala para \"¿qué alertas hay activas en OpManager?\", \"¿qué probe o país tiene más alertas?\", \"¿cuántas alertas hay en Perú?\", \"¿qué equipos tienen más alertas?\", \"¿qué tipo de alerta predomina?\". Para acotar a un lugar usa los filtros pais, probe, sede o area (por ejemplo pais=\"Perú\"): los totales y los rankings se calculan solo sobre ese lugar. \"Sin dato\" agrupa las alertas cuyo equipo no tiene ese campo diligenciado en OpManager (no es un lugar real): dilo así, sin inventar a quién pertenecen. También trae \"porTipoDeAlerta\" (familias como equipo sin respuesta, utilización de interfaz, respaldos NCM), \"porAntiguedad\" (cuánto llevan abiertas, en cuatro grupos que NO se superponen y suman el total) e \"inicioDeAlertasPorHoraUTC\", calculados sobre TODAS las abiertas: úsalos para hablar de patrones, picos o antigüedad. IMPORTANTE: el estado \"abierta\" es el que tiene EPISTECH y no se verifica en vivo contra OpManager (lee \"fuenteDelEstado\"): si casi todas llevan más de 7 días, avisa que puede haber alertas ya restablecidas que EPISTECH no ha cerrado. El listado detallado (\"alertas\") cubre solo las más recientes hasta el límite: NUNCA extrapoles de él al total. Para profundizar en una alerta usa get_alert_by_id con su \"id\" y las herramientas de OpManager.",
      inputSchema: {
        pais: z.string().min(2).optional().describe('Solo alertas de ese país (subcadena, sin importar mayúsculas ni tildes), p. ej. "Perú" o "colombia".'),
        probe: z.string().min(2).optional().describe('Solo alertas de ese probe (subcadena), p. ej. "Probe Colombia" o "Azure".'),
        sede: z.string().min(2).optional().describe('Solo alertas de esa sede (subcadena), p. ej. "La Molina".'),
        area: z.string().min(2).optional().describe('Solo alertas de esa área (subcadena), p. ej. "REDES" o "SERVIDORES".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Cuántas alertas listar, de las más recientes hacia atrás (default 20, máximo 100)."),
      },
    },
    async ({ pais, probe, sede, area, limit }) => {
      const result = await epistech.getOpmanagerActiveOverview({ pais, probe, sede, area, limit });
      return { content: [{ type: "text", text: JSON.stringify(withSourceScope("OpManager", "Zabbix", result)) }] };
    }
  );

  registerForVendor(
    "zabbix",
    "get_zabbix_noisiest_hosts",
    {
      title: "Ranking de equipos de Zabbix por ruido",
      description:
        "Ranking de los equipos de CLIENTES de Zabbix por cantidad de problemas (abiertos o ya recuperados) en un período, con el promedio, la mediana, el percentil 90 y el máximo de todos los equipos. Con \"equipo\" indica además en qué POSICIÓN queda ese equipo frente al resto (\"posicion\" de \"de\", cuántas veces la mediana, y a qué porcentaje de equipos supera). Es la herramienta para \"¿es normal que RTR-X tenga tantas alertas?\", \"compáralo con otros equipos\", \"¿cuáles son los equipos más ruidosos?\" o \"¿hay otros equipos igual de ruidosos?\": responde con la posición real, no con una suposición. Distinta de get_zabbix_active_overview, que solo cuenta las alertas ABIERTAS ahora; esta cuenta todos los problemas del período. Si pasas \"equipo\", usa el nombre exacto que te confirmó find_zabbix_host; con un nombre ambiguo no calcula la posición y lo avisa. Los datos son exactos: cítalos con su período y NO inventes una causa de por qué un equipo es más ruidoso.",
      inputSchema: {
        equipo: z
          .string()
          .min(2)
          .optional()
          .describe('Nombre exacto del equipo cuya posición se quiere conocer (p. ej. "RTR-Cartago"). Se omite para solo ver el top.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("Período en días (default 7, máximo 30)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("Cuántos equipos listar en el top (default 10, máximo 30)."),
      },
    },
    async ({ equipo, days, limit }) => {
      const result = await epistech.getZabbixNoisiestHosts({ equipo, days, limit });
      return { content: [{ type: "text", text: JSON.stringify(withSourceScope("Zabbix", "OpManager", result)) }] };
    }
  );

  // ------------------------------------------------------------------
  // Investigación de alertas OpManager -- reusan las rutas que ya
  // existen en EpistechBackend (no le hablan a OpManager directo). El
  // flujo típico: get_device_info primero para resolver "probeID" a
  // partir del nombre del dispositivo, y con eso (como "eeProbeID") ya
  // se pueden pedir notas, gráficas de interfaz o traceroute.
  // ------------------------------------------------------------------

  registerForVendor(
    "opmanager",
    "get_device_info",
    {
      title: "Info del dispositivo (OpManager)",
      description:
        "Información básica de un dispositivo de OpManager a partir de su nombre (incluye su probeID). Solo para preguntas sobre un dispositivo SIN alerta de por medio: para investigar una alerta no hace falta, porque get_device_notes, get_interface_graphs y get_trace_response reciben el \"entity\" de la alerta y resuelven solas el dispositivo.",
      inputSchema: {
        deviceName: z.string().describe("Nombre del dispositivo (displayName de la alerta de OpManager)"),
      },
    },
    async ({ deviceName }) => {
      const result = await opmanager.getDeviceInfo({ deviceName });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  registerForVendor(
    "opmanager",
    "get_alarm_properties",
    {
      title: "Propiedades/historial de la alarma (OpManager)",
      description:
        "Detalle y estado actual de una alarma de OpManager: tipo (ej. Interface Down, Device Down, Threshold), severidad ACTUAL (si sigue caída o se restableció), dispositivo, quién la reconoció, y los eventos más recientes (el más reciente primero) para ver si hay caídas constantes. Si la alarma es de una interfaz, trae su nombre exacto en alarma.interfaz; si es de dispositivo, alarma.interfaz es null.",
      inputSchema: {
        entity: z.string().describe("Campo \"entity\" de la alerta cruda (json_result), tal cual"),
      },
    },
    async ({ entity }) => {
      const result = await opmanager.getAlarmsProperties({ entity });
      return { content: [{ type: "text", text: JSON.stringify(opmanager.compactAlarmProperties(result)) }] };
    }
  );

  registerForVendor(
    "opmanager",
    "get_device_notes",
    {
      title: "Notas/customFields del dispositivo (OpManager)",
      description:
        "Obtiene los customFields del dispositivo: país, ciudad, sede, área resolutora, criticidad, etc. Pásale solo el \"entity\" de la alerta cruda: la tool consulta a OpManager el probeID y el nombre del dispositivo, no los armes tú. Devuelve { campos: { nombre: valor } } solo con los campos que tienen valor. Ojo: \"Rol\" es la función del dispositivo en la red (ej. HRSP), NO la sede -- la sede es \"Site\"; \"Grupo Resolutor\" es el código que se pasa a get_escalation_matrix.",
      inputSchema: {
        entity: z
          .string()
          .optional()
          .describe('Campo "entity" de la alerta cruda (json_result), tal cual. Es lo normal: la tool obtiene de OpManager el probeID y el nombre del dispositivo.'),
        name: z.string().optional().describe('Solo si NO tienes el "entity": el "source" de la alerta (formato "{ip}.{probeID}")'),
        eeProbeID: z.string().optional().describe('Solo si NO tienes el "entity": probeID del dispositivo'),
      },
    },
    async ({ entity, name, eeProbeID }) => {
      const target = entity ? await opmanager.resolveAlarmDevice({ entity }) : { eeProbeID, source: name };
      if (!target.eeProbeID) throw new Error('Indica el "entity" de la alerta, o bien "eeProbeID".');
      const result = await opmanager.getDeviceNotes({ name: target.source, eeProbeID: target.eeProbeID });
      return { content: [{ type: "text", text: JSON.stringify(opmanager.compactDeviceNotes(result)) }] };
    }
  );

  registerForVendor(
    "opmanager",
    "get_interface_graphs",
    {
      title: "Gráficas de interfaz (OpManager)",
      description:
        "Tráfico de una interfaz específica -- solo aplica cuando la alerta es sobre una interfaz puntual (no el dispositivo completo). Pásale solo el \"entity\" de la alerta cruda: la tool consulta a OpManager el nombre exacto de la interfaz y el probeID, no los armes tú. Si la alarma no es de una interfaz (alerta de dispositivo) responde con un error que lo indica. La respuesta ya viene resumida: resumenOpManager (valor actual, mínimo, máximo, promedio y percentil 95 de Rx/Tx) y, por serie, estadísticas del período más una muestra de ~12 puntos para ver la tendencia -- no trae todos los puntos.",
      inputSchema: {
        entity: z
          .string()
          .optional()
          .describe('Campo "entity" de la alerta cruda (json_result), tal cual -- ej. "IF-172.21.49.4.50000000001-7_Poll" o "IF_UTIL_50000027344". Es lo normal: con esto basta.'),
        eeProbeID: z.string().optional().describe('Solo si NO tienes el "entity": probeID del dispositivo'),
        interfaceName: z.string().optional().describe('Solo si NO tienes el "entity": nombre exacto de la interfaz (ej. "IF-{source}-{indice}")'),
        graphName: z.string().optional().describe('Nombre de la gráfica -- normalmente se omite (por defecto "traffic")'),
        isFluidic: z.boolean().optional().describe("Normalmente se omite (por defecto true)"),
        graphFilterType: z.string().optional().describe('Agregación -- normalmente se omite (por defecto "avg")'),
        period: z.string().optional().describe('Ventana de tiempo -- normalmente se omite (por defecto "Today")'),
      },
    },
    async ({ entity, eeProbeID, interfaceName, graphName, isFluidic, graphFilterType, period }) => {
      const target = await opmanager.resolveInterface({ entity, eeProbeID, interfaceName });
      const result = await opmanager.getInterfaceGraphs({ ...target, graphName, isFluidic, graphFilterType, period });

      return { content: [{ type: "text", text: JSON.stringify(opmanager.summarizeInterfaceGraphs(result)) }] };
    }
  );

  registerForVendor(
    "opmanager",
    "get_trace_response",
    {
      title: "Traceroute al dispositivo (OpManager)",
      description:
        "Traza de red (traceroute) hacia el dispositivo alertado, para ver si hay conectividad y por dónde se corta. Pásale solo el \"entity\" de la alerta cruda: la tool consulta a OpManager el dispositivo y su probeID. Si la alarma es un Device Down que sigue activa, no ejecuta el traceroute (tardaría ~60 s y fallaría) y lo indica en la respuesta.",
      inputSchema: {
        entity: z
          .string()
          .optional()
          .describe('Campo "entity" de la alerta cruda (json_result), tal cual. Es lo normal.'),
        deviceName: z.string().optional().describe('Solo si NO tienes el "entity": el "source" de la alerta (formato "{ip}.{probeID}"); con el nombre para mostrar o la IP OpManager no lo resuelve'),
        eeProbeID: z.string().optional().describe('Solo si NO tienes el "entity": probeID del dispositivo'),
      },
    },
    async ({ entity, deviceName, eeProbeID }) => {
      const target = entity ? await opmanager.resolveAlarmDevice({ entity }) : { eeProbeID, source: deviceName };
      if (!target.eeProbeID || !target.source) throw new Error('Indica el "entity" de la alerta, o bien "deviceName" y "eeProbeID".');

      // Un traceroute a un equipo que sigue caído hace esperar ~60 s y OpManager lo corta con un 504 sin dar datos.
      if (entity && target.tipo === "Device Down" && !/^clear$/i.test(target.severidadActual ?? "")) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                omitido: true,
                motivo:
                  "La alarma es Device Down y sigue activa: el dispositivo no responde, así que no hay conectividad hacia él. " +
                  "No se ejecutó el traceroute (a un equipo caído tarda ~60 s y OpManager lo corta con un error 504 sin dar información).",
              }),
            },
          ],
        };
      }
      const result = await opmanager.getTraceResponse({ deviceName: target.source, eeProbeID: target.eeProbeID });

      // OpManager responde 200 aunque no resuelva el nombre; se avisa como error para que no se lea como un resultado.
      const details = String(result?.response?.TraceResponse?.Details ?? "");
      if (/^\s*Unable to resolve/i.test(details)) {
        throw new Error(`OpManager no pudo resolver el dispositivo para el traceroute: ${details.trim()}`);
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  return server;
}

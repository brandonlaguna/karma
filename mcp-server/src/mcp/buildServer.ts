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
export function buildServer() {
  const server = new McpServer({
    name: "epistech-ai-lab-mcp",
    version: "1.0.0",
  });

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
  // Investigación de alertas OpManager -- reusan las rutas que ya
  // existen en EpistechBackend (no le hablan a OpManager directo). El
  // flujo típico: get_device_info primero para resolver "probeID" a
  // partir del nombre del dispositivo, y con eso (como "eeProbeID") ya
  // se pueden pedir notas, gráficas de interfaz o traceroute.
  // ------------------------------------------------------------------

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

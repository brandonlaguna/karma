import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { embedText } from "./knowledge/embeddings.js";
import { searchKnowledgeBase } from "./knowledge/qdrant.js";
import { getEscalationMatrix } from "./db/escalation.js";
import { findDevice } from "./db/devices.js";
import * as opmanager from "./tools/opmanager.js";
import * as epistech from "./tools/epistech.js";

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
function buildServer() {
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

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
        "Resuelve información básica de un dispositivo de OpManager a partir de su nombre, incluyendo 'probeID' -- necesario para llamar get_device_notes, get_interface_graphs y get_trace_response (como 'eeProbeID'). Úsala primero cuando investigues una alerta y no tengas ya el probeID.",
      inputSchema: {
        deviceName: z.string().describe("Nombre del dispositivo (displayName de la alerta de OpManager)"),
      },
    },
    async ({ deviceName }) => {
      const result = await opmanager.getDeviceInfo({ deviceName });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_alarm_properties",
    {
      title: "Propiedades/historial de la alarma (OpManager)",
      description:
        "Consulta el historial de eventos de una alarma de OpManager: si se restableció, si sigue caída, o si hay caídas constantes en una ventana de tiempo. El evento más reciente viene primero en la lista.",
      inputSchema: {
        entity: z.string().describe("ID de la entidad/alarma en OpManager (viene en la alerta cruda)"),
      },
    },
    async ({ entity }) => {
      const result = await opmanager.getAlarmsProperties({ entity });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_device_notes",
    {
      title: "Notas/customFields del dispositivo (OpManager)",
      description:
        "Obtiene los customFields del dispositivo: país, ciudad, sede, área resolutora, criticidad, etc. Requiere el probeID -- si la alerta cruda ya trae un campo \"probeid\"/\"probeID\", úsalo directo como eeProbeID sin llamar a get_device_info. El nombre del dispositivo es opcional: si la alerta trae un campo \"source\" (formato \"{ip}.{probeID}\"), pásalo tal cual como \"name\"; si no está, omite el parámetro.",
      inputSchema: {
        name: z.string().optional().describe("Nombre del dispositivo, si ya se conoce -- ej. el campo \"source\" de la alerta cruda (opcional)"),
        eeProbeID: z.string().describe("probeID del dispositivo -- de get_device_info, o directo del campo \"probeid\"/\"probeID\" de la alerta cruda si ya viene ahí"),
      },
    },
    async ({ name, eeProbeID }) => {
      const result = await opmanager.getDeviceNotes({ name, eeProbeID });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_interface_graphs",
    {
      title: "Gráficas de interfaz (OpManager)",
      description:
        "Estado y tráfico de una interfaz específica del dispositivo -- solo aplica cuando la alerta es sobre una interfaz puntual (no el dispositivo completo). Requiere el probeID -- si la alerta cruda ya trae \"probeid\", úsalo directo. El campo graphData de la respuesta viene reducido a una muestra de pocos puntos (no el detalle completo) para no saturar la respuesta.",
      inputSchema: {
        eeProbeID: z.string().describe("probeID del dispositivo (de get_device_info, o directo del campo \"probeid\" de la alerta cruda)"),
        interfaceName: z
          .string()
          .describe(
            'Nombre de la interfaz en formato "IF-{source}-{elementid}", ej. "IF-172.23.103.18.50000000001-50000013652" -- constrúyelo con el campo "source" y el campo "elementid" de la alerta cruda, no hace falta resolverlo con otra tool.'
          ),
        graphName: z.string().optional().describe("Nombre de la gráfica a consultar"),
        isFluidic: z.boolean().optional(),
        graphFilterType: z.string().optional(),
        period: z.string().optional().describe("Ventana de tiempo de la gráfica"),
      },
    },
    async ({ eeProbeID, interfaceName, graphName, isFluidic, graphFilterType, period }) => {
      const result = await opmanager.getInterfaceGraphs({ eeProbeID, interfaceName, graphName, isFluidic, graphFilterType, period });

      if (Array.isArray(result?.response?.graphData)) {
        const totalPoints = result.response.graphData.length;
        result.response.graphData = opmanager.sampleGraphData(result.response.graphData, 5);
        result.response.graphDataNote = `Se redujo de ${totalPoints} a ${result.response.graphData.length} puntos (muestra uniforme en el tiempo) para no saturar la respuesta.`;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_trace_response",
    {
      title: "Traceroute al dispositivo (OpManager)",
      description: "Traza de red (traceroute) hacia el dispositivo alertado. Requiere el probeID (get_device_info primero).",
      inputSchema: {
        deviceName: z.string().describe("Nombre del dispositivo"),
        eeProbeID: z.string().describe("probeID del dispositivo (de get_device_info)"),
      },
    },
    async ({ deviceName, eeProbeID }) => {
      const result = await opmanager.getTraceResponse({ deviceName, eeProbeID });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * Endpoint MCP real (protocolo Streamable HTTP / JSON-RPC). Reemplaza
 * las rutas REST ad hoc que había antes (/tools/current-time,
 * /tools/system-info) -- los clientes MCP (ai-backend) hablan el
 * protocolo acá, no HTTP plano hecho a mano.
 */
app.post("/mcp", async (req, res) => {
  const server = buildServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error manejando request MCP:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Modo stateless: no hay sesión que reanudar ni que cerrar por fuera de
// POST /mcp (mismo comportamiento que el ejemplo oficial del SDK).
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.listen(4100, "0.0.0.0", () => {
  console.log("MCP Server (protocolo real) escuchando en :4100");
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://mcp-server:4100/mcp";

/**
 * Abre una conexión MCP nueva, corre `fn(client)`, y siempre la cierra
 * al terminar (haya error o no). El mcp-server corre en modo stateless
 * (ver mcp-server/src/index.ts), así que no hay beneficio real en
 * mantener una conexión persistente entre requests -- una conexión por
 * operación es más simple y no deja nada colgado si el proceso se
 * reinicia a medio camino.
 */
async function withMcpClient(fn) {
  const client = new Client({ name: "epistech-ai-lab-backend", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));

  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Cache en memoria de la lista de tools -- se pedía al mcp-server (una
// conexión MCP completa: connect + initialize + listTools + close) en
// CADA mensaje del chat, aunque las tools casi nunca cambian. Con esto
// se refresca cada 5 min en vez de en cada request, ahorrando un
// round-trip completo por mensaje.
const TOOLS_CACHE_TTL_MS = (Number(process.env.TOOLS_CACHE_TTL_MINUTES) || 5) * 60 * 1000;
let toolsCache = null; // { tools, fetchedAt }

/**
 * Lista las tools que expone el mcp-server, ya convertidas al formato
 * `tools` que espera la API de chat completions (OpenAI-compatible --
 * es la misma forma que habla Ollama). Antes esta lista vivía
 * hardcodeada y duplicada a mano en tools/index.js; ahora se descubre
 * en vivo, así que agregar una tool nueva en el mcp-server no requiere
 * tocar nada acá.
 */
export async function listToolsForLLM() {
  const now = Date.now();

  if (toolsCache && now - toolsCache.fetchedAt < TOOLS_CACHE_TTL_MS) {
    return toolsCache.tools;
  }

  const tools = await withMcpClient(async (client) => {
    const { tools } = await client.listTools();

    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  });

  toolsCache = { tools, fetchedAt: now };
  return tools;
}

/**
 * Ejecuta una tool por nombre contra el mcp-server. Devuelve el
 * resultado ya "aplanado" a texto plano cuando se puede -- el LLM
 * espera texto/JSON en el mensaje role:"tool", no la forma completa de
 * CallToolResult (bloques content con type/text/etc).
 */
export async function callMcpTool(name, args = {}) {
  return withMcpClient(async (client) => {
    const result = await client.callTool({ name, arguments: args });

    if (result.isError) {
      throw new Error(`Tool "${name}" devolvió error: ${JSON.stringify(result.content)}`);
    }

    const textParts = (result.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text);

    return textParts.length ? textParts.join("\n") : result.content;
  });
}

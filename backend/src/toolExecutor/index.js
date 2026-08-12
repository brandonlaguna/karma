import { callMcpTool } from "../mcp/client.js";

/**
 * Puente entre el loop de chat y el cliente MCP real. Antes esto era un
 * switch/case con URLs hardcodeadas a mcp-server:4100/tools/xxx -- ahora
 * cualquier tool que registre el mcp-server se puede llamar acá sin
 * tocar este archivo, el nombre y los argumentos se resuelven vía
 * protocolo MCP (ver mcp-server/src/index.ts y mcp/client.js).
 */
export async function executeTool(toolName, args = {}) {
  return callMcpTool(toolName, args);
}

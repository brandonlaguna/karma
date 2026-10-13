import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../mcp/buildServer.js";

const router = Router();

/**
 * Endpoint MCP real (protocolo Streamable HTTP / JSON-RPC). Reemplaza
 * las rutas REST ad hoc que había antes (/tools/current-time,
 * /tools/system-info) -- los clientes MCP (ai-backend) hablan el
 * protocolo acá, no HTTP plano hecho a mano.
 */
router.post("/", async (req, res) => {
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
const methodNotAllowed = (_req: unknown, res: any) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};

router.get("/", methodNotAllowed);
router.delete("/", methodNotAllowed);

export default router;

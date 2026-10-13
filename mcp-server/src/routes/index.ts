import type { Express } from "express";
import healthRouter from "./health.routes.js";
import escalationMatrixRouter from "./escalationMatrix.routes.js";
import escalationAdminRouter from "./escalationAdmin.routes.js";
import mcpRouter from "./mcp.routes.js";

export function registerRoutes(app: Express) {
  app.use("/health", healthRouter);

  // Lectura (GET /) y escritura comparten prefijo: la lectura va primero
  // porque no lleva auth; el router de escritura aplica el JWT de EPISTECH
  // a todo lo que le llegue (hoy en modo permisivo, ver auth/jwtMiddleware.js).
  app.use("/api/escalation-matrix", escalationMatrixRouter);
  app.use("/api/escalation-matrix", escalationAdminRouter);

  app.use("/mcp", mcpRouter);
}

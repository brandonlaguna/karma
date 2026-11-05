import express from "express";
import { registerRoutes } from "./routes/index.js";

const app = express();
// 5 MB: la importación masiva de la matriz RACI manda miles de filas en un solo JSON (el límite por omisión es 100 KB).
app.use(express.json({ limit: "5mb" }));

registerRoutes(app);

app.listen(4100, "0.0.0.0", () => {
  console.log("MCP Server (protocolo real) escuchando en :4100");
});

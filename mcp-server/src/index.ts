import express from "express";
import { registerRoutes } from "./routes/index.js";

const app = express();
app.use(express.json());

registerRoutes(app);

app.listen(4100, "0.0.0.0", () => {
  console.log("MCP Server (protocolo real) escuchando en :4100");
});

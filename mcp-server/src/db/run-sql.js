import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "./pool.js";

/**
 * Corre un archivo .sql cualquiera contra la Postgres de ai-lab, vía el
 * mismo pool de "pg" que ya usan las tools -- evita depender de psql,
 * que no viene instalado en la imagen node:22-alpine de mcp-server.
 *
 * Uso: pnpm run seed src/db/seed.colombia.sql
 */
const fileArg = process.argv[2];

if (!fileArg) {
  console.error("Uso: pnpm run seed <ruta-al-archivo.sql>");
  process.exit(1);
}

async function run() {
  const filePath = path.resolve(process.cwd(), fileArg);
  const sql = readFileSync(filePath, "utf-8");

  console.log(`Ejecutando ${filePath}...`);
  await pool.query(sql);
  console.log("Listo.");

  await pool.end();
}

run().catch((err) => {
  console.error("Error ejecutando el archivo SQL:", err);
  process.exit(1);
});

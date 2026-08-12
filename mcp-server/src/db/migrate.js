import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const sql = readFileSync(path.join(__dirname, "schema.sql"), "utf-8");

  console.log("Aplicando schema.sql a Postgres...");
  await pool.query(sql);
  console.log("Listo -- tablas creadas/verificadas (countries, opmanager_probes, teams, contacts, escalation_levels, escalation_raci).");

  await pool.end();
}

migrate().catch((err) => {
  console.error("Error aplicando el schema:", err);
  process.exit(1);
});

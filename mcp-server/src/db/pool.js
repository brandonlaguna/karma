import pg from "pg";

/**
 * Pool de conexión a la Postgres PROPIA de ai-lab (contactos, matriz de
 * escalamiento, sondas OpManager por país). Separada por diseño de la
 * MariaDB de Epistech -- ver decisión en project_ai_lab_noc_assistant.
 */
export const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT) || 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
});

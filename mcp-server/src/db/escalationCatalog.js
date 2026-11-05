import { pool } from "./pool.js";

/**
 * Listados de la matriz de escalamiento para la pantalla de administración de EPISTECH (países, equipos, niveles,
 * contactos, asignaciones RACI y auditoría). Son lecturas planas, sin LLM: lo que se ve en pantalla es lo que hay en la
 * base. La consulta que usa el chat para decidir a quién escalar sigue siendo escalation.js (con su fallback país -> global).
 */

const MAX_LIMIT = 5000;

const clampLimit = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, MAX_LIMIT) : fallback;
};

export async function listCountries() {
  const { rows } = await pool.query(
    `SELECT c.iso_code, c.name,
            (SELECT count(*)::int FROM teams t WHERE t.country_id = c.id) AS teams
     FROM countries c
     ORDER BY c.name`
  );
  return rows;
}

export async function listTeams({ countryCode } = {}) {
  const params = [];
  let where = "";
  if (countryCode) {
    params.push(countryCode.toUpperCase());
    where = "WHERE c.iso_code = $1";
  }
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.resolver_group_code, t.site_code, t.description,
            c.iso_code AS country_code, c.name AS country_name,
            (SELECT count(*)::int FROM escalation_raci r WHERE r.team_id = t.id) AS assignments
     FROM teams t
     LEFT JOIN countries c ON c.id = t.country_id
     ${where}
     ORDER BY c.iso_code NULLS FIRST, t.name`,
    params
  );
  return rows;
}

export async function listLevels() {
  const { rows } = await pool.query(
    `SELECT l.level_number, l.name, l.trigger_description, l.response_sla_minutes, l.resolution_sla_minutes,
            (SELECT count(*)::int FROM escalation_raci r WHERE r.escalation_level_id = l.id) AS assignments
     FROM escalation_levels l
     ORDER BY l.level_number`
  );
  return rows;
}

export async function listContacts({ q, limit } = {}) {
  const params = [];
  let where = "";
  if (q) {
    params.push(`%${q}%`);
    where = "WHERE ct.name ILIKE $1 OR ct.email ILIKE $1 OR ct.phone ILIKE $1";
  }
  params.push(clampLimit(limit, 1000));
  const { rows } = await pool.query(
    `SELECT ct.id, ct.name, ct.email, ct.phone, ct.active,
            (SELECT count(*)::int FROM escalation_raci r WHERE r.contact_id = ct.id) AS assignments
     FROM contacts ct
     ${where}
     ORDER BY ct.name
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Asignaciones RACI ya "aplanadas" (con país, equipo, nivel y contacto) para pintarlas en una tabla. Una asignación sin
 * país es una regla global (aplica a cualquier país que no tenga la suya).
 */
export async function listAssignments({ countryCode, levelNumber, teamId, q, limit } = {}) {
  const params = [];
  const where = [];
  const add = (condition, value) => {
    params.push(value);
    where.push(condition.replace("?", `$${params.length}`));
  };
  if (countryCode) add("c.iso_code = ?", countryCode.toUpperCase());
  if (levelNumber !== undefined && levelNumber !== null) add("l.level_number = ?", levelNumber);
  if (teamId) add("r.team_id = ?", teamId);
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(
      `(t.name ILIKE ${p} OR t.resolver_group_code ILIKE ${p} OR t.site_code ILIKE ${p} OR ct.name ILIKE ${p} OR ct.email ILIKE ${p} OR r.description ILIKE ${p})`
    );
  }
  params.push(clampLimit(limit, 2000));

  const { rows } = await pool.query(
    `SELECT r.id, r.raci_role, r.description, r.schedule, r.response_time,
            l.level_number, l.name AS level_name,
            c.iso_code AS country_code, c.name AS country_name,
            t.id AS team_id, t.name AS team_name, t.resolver_group_code, t.site_code,
            ct.id AS contact_id, ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone,
            ct.active AS contact_active,
            count(*) OVER()::int AS total
     FROM escalation_raci r
     JOIN escalation_levels l ON l.id = r.escalation_level_id
     LEFT JOIN countries c ON c.id = r.country_id
     LEFT JOIN teams t ON t.id = r.team_id
     LEFT JOIN contacts ct ON ct.id = r.contact_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY c.iso_code NULLS FIRST, t.name, l.level_number, r.raci_role
     LIMIT $${params.length}`,
    params
  );
  return { total: rows[0]?.total ?? 0, rows: rows.map(({ total, ...row }) => row) };
}

/** Últimos cambios a la matriz (quién, qué y cuándo): esta matriz decide a quién se llama en un incidente. */
export async function listAudit({ limit } = {}) {
  const { rows } = await pool.query(
    `SELECT id, occurred_at, actor_id, actor_name, authenticated, action, entity, entity_id, payload
     FROM escalation_audit_log
     ORDER BY id DESC
     LIMIT $1`,
    [clampLimit(limit, 100)]
  );
  return rows;
}

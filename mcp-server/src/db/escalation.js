import { pool } from "./pool.js";

/**
 * Resuelve la matriz RACI de escalamiento para un nivel dado, con
 * fallback país -> global: si existe una fila con country_id = X para
 * ese rol, esa manda; si no, se usa la fila global (country_id NULL).
 *
 * Acepta country_code (ISO 3166-1 alpha-2, ej. "CO") o opmanager_probe_id
 * (para resolver el país automáticamente a partir de la sonda que
 * generó la alerta) -- basta con pasar uno de los dos.
 */
export async function getEscalationMatrix({
  countryCode,
  opmanagerProbeId,
  levelNumber,
  teamName,
  resolverGroupCode,
  siteCode,
} = {}) {
  let countryId = null;
  let resolvedCountry = null;

  if (opmanagerProbeId) {
    const probeResult = await pool.query(
      `SELECT p.country_id, c.iso_code, c.name AS country_name
       FROM opmanager_probes p
       JOIN countries c ON c.id = p.country_id
       WHERE p.opmanager_probe_id = $1`,
      [opmanagerProbeId]
    );
    if (probeResult.rows[0]) {
      countryId = probeResult.rows[0].country_id;
      resolvedCountry = { iso_code: probeResult.rows[0].iso_code, name: probeResult.rows[0].country_name };
    }
  } else if (countryCode) {
    const countryResult = await pool.query(
      `SELECT id, iso_code, name FROM countries WHERE iso_code = $1`,
      [countryCode.toUpperCase()]
    );
    if (countryResult.rows[0]) {
      countryId = countryResult.rows[0].id;
      resolvedCountry = { iso_code: countryResult.rows[0].iso_code, name: countryResult.rows[0].name };
    }
  }

  const params = [];
  let levelFilter = "";
  if (levelNumber !== undefined && levelNumber !== null) {
    params.push(levelNumber);
    levelFilter = `AND lvl.level_number = $${params.length}`;
  }

  // resolverGroupCode/siteCode son match EXACTO (vienen tal cual de
  // customFields de OpManager) -- se prefieren sobre teamName, que es
  // una búsqueda difusa por si no se tiene el código a mano.
  let teamFilter = "";
  if (resolverGroupCode) {
    params.push(resolverGroupCode);
    teamFilter = `AND t.resolver_group_code = $${params.length}`;
  } else if (siteCode) {
    params.push(siteCode);
    teamFilter = `AND t.site_code = $${params.length}`;
  } else if (teamName) {
    params.push(teamName);
    teamFilter = `AND t.name ILIKE $${params.length}`;
  }

  params.push(countryId);
  const countryParamIndex = params.length;

  const query = `
    SELECT
      lvl.level_number,
      lvl.name AS level_name,
      lvl.trigger_description,
      lvl.response_sla_minutes,
      lvl.resolution_sla_minutes,
      raci.raci_role,
      raci.description AS raci_description,
      raci.schedule,
      raci.response_time,
      raci.country_id IS NOT NULL AS is_country_override,
      t.name AS team_name,
      c.name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM escalation_raci raci
    JOIN escalation_levels lvl ON lvl.id = raci.escalation_level_id
    LEFT JOIN teams t ON t.id = raci.team_id
    LEFT JOIN contacts c ON c.id = raci.contact_id
    WHERE (raci.country_id = $${countryParamIndex} OR raci.country_id IS NULL)
    ${levelFilter}
    ${teamFilter}
    ORDER BY lvl.level_number ASC, raci.raci_role ASC, is_country_override DESC
  `;

  const result = await pool.query(query, params);

  return {
    resolvedCountry,
    rows: result.rows
  };
}

import { pool } from "./pool.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// El Excel de origen trae saltos de línea y prefijos sueltos ("++57", "+57 3");
// se limpia lo seguro (formato) sin adivinar números.
export function normalizePhone(phone) {
  if (phone == null) return null;
  const cleaned = phone
    .replace(/\s*[\r\n]+\s*/g, " / ")
    .replace(/\s+/g, " ")
    .replace(/^\+\+/, "+")
    .trim();
  return cleaned || null;
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function audit(client, actor, action, entity, entityId, payload) {
  await client.query(
    `INSERT INTO escalation_audit_log (actor_id, actor_name, authenticated, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.id, actor.name, actor.authenticated, action, entity, entityId, JSON.stringify(payload)]
  );
}

async function findCountry(client, isoCode) {
  const { rows } = await client.query("SELECT id, iso_code, name FROM countries WHERE iso_code = $1", [
    isoCode.toUpperCase(),
  ]);
  if (!rows[0]) throw new HttpError(404, `El país "${isoCode}" no existe -- créalo primero con POST /countries`);
  return rows[0];
}

async function findTeam(client, country, { resolverGroupCode, siteCode, teamName }) {
  let result;
  let label;

  if (resolverGroupCode) {
    label = `resolverGroupCode "${resolverGroupCode}"`;
    result = await client.query("SELECT id, name, country_id FROM teams WHERE resolver_group_code = $1", [resolverGroupCode]);
  } else if (siteCode) {
    label = `siteCode "${siteCode}"`;
    result = await client.query("SELECT id, name, country_id FROM teams WHERE site_code = $1", [siteCode]);
  } else {
    label = `teamName "${teamName}" en ${country.iso_code}`;
    result = await client.query("SELECT id, name, country_id FROM teams WHERE lower(name) = lower($1) AND country_id = $2", [
      teamName,
      country.id,
    ]);
  }

  const team = result.rows[0];
  if (!team) throw new HttpError(404, `No existe un equipo con ${label} -- créalo primero con POST /teams`);
  if (team.country_id !== country.id) {
    throw new HttpError(400, `El equipo con ${label} no pertenece al país ${country.iso_code}`);
  }
  return team;
}

async function upsertContact(client, { name, email, phone }) {
  const normalizedPhone = normalizePhone(phone);

  // El índice único de email distingue mayúsculas (hay correos como
  // "redes.Colombia@atento.com"), así que la búsqueda es insensible a ellas
  // para no duplicar a la misma persona.
  const existing = email
    ? await client.query("SELECT id FROM contacts WHERE lower(email) = lower($1)", [email])
    : await client.query("SELECT id FROM contacts WHERE email IS NULL AND name = $1", [name]);

  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await client.query("UPDATE contacts SET name = $2, phone = COALESCE($3, phone), active = true WHERE id = $1", [
      id,
      name,
      normalizedPhone,
    ]);
    return id;
  }

  const inserted = await client.query("INSERT INTO contacts (name, email, phone) VALUES ($1, $2, $3) RETURNING id", [
    name,
    email ?? null,
    normalizedPhone,
  ]);
  return inserted.rows[0].id;
}

export function upsertCountry({ isoCode, name }, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO countries (iso_code, name) VALUES ($1, $2)
       ON CONFLICT (iso_code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, iso_code, name`,
      [isoCode.toUpperCase(), name]
    );
    await audit(client, actor, "upsert", "country", rows[0].id, { isoCode, name });
    return rows[0];
  });
}

export function upsertTeam({ countryCode, name, resolverGroupCode, siteCode, description }, actor) {
  return withTransaction(async (client) => {
    const country = await findCountry(client, countryCode);
    const { rows } = await client.query(
      `INSERT INTO teams (name, country_id, resolver_group_code, site_code, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name, country_id) DO UPDATE SET
         resolver_group_code = COALESCE(EXCLUDED.resolver_group_code, teams.resolver_group_code),
         site_code = COALESCE(EXCLUDED.site_code, teams.site_code),
         description = COALESCE(EXCLUDED.description, teams.description)
       RETURNING id, name, resolver_group_code, site_code, description`,
      [name, country.id, resolverGroupCode ?? null, siteCode ?? null, description ?? null]
    );
    await audit(client, actor, "upsert", "team", rows[0].id, { countryCode, name, resolverGroupCode, siteCode, description });
    return { ...rows[0], country_code: country.iso_code };
  });
}

export function upsertLevel({ levelNumber, name, triggerDescription, responseSlaMinutes, resolutionSlaMinutes }, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO escalation_levels (level_number, name, trigger_description, response_sla_minutes, resolution_sla_minutes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (level_number) DO UPDATE SET
         name = EXCLUDED.name,
         trigger_description = EXCLUDED.trigger_description,
         response_sla_minutes = EXCLUDED.response_sla_minutes,
         resolution_sla_minutes = EXCLUDED.resolution_sla_minutes
       RETURNING level_number, name, trigger_description, response_sla_minutes, resolution_sla_minutes`,
      [levelNumber, name, triggerDescription ?? null, responseSlaMinutes ?? null, resolutionSlaMinutes ?? null]
    );
    await audit(client, actor, "upsert", "level", levelNumber, rows[0]);
    return rows[0];
  });
}

export function createAssignment(input, actor) {
  const { countryCode, levelNumber, raciRole, contact, schedule, responseTime, description, replace } = input;

  return withTransaction(async (client) => {
    const country = await findCountry(client, countryCode);
    const team = await findTeam(client, country, input);

    const level = (await client.query("SELECT id, name FROM escalation_levels WHERE level_number = $1", [levelNumber])).rows[0];
    if (!level) throw new HttpError(404, `El nivel ${levelNumber} no existe -- créalo primero con PUT /levels/${levelNumber}`);

    const contactId = await upsertContact(client, contact);

    let replaced = [];
    if (replace) {
      const removed = await client.query(
        `DELETE FROM escalation_raci
         WHERE escalation_level_id = $1 AND country_id = $2 AND team_id = $3 AND raci_role = $4
         RETURNING id, contact_id`,
        [level.id, country.id, team.id, raciRole]
      );
      replaced = removed.rows;
    }

    const { rows } = await client.query(
      `INSERT INTO escalation_raci (escalation_level_id, country_id, team_id, contact_id, raci_role, description, schedule, response_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (escalation_level_id, country_id, team_id, contact_id, raci_role) DO UPDATE SET
         description = COALESCE(EXCLUDED.description, escalation_raci.description),
         schedule = COALESCE(EXCLUDED.schedule, escalation_raci.schedule),
         response_time = COALESCE(EXCLUDED.response_time, escalation_raci.response_time)
       RETURNING id`,
      [
        level.id,
        country.id,
        team.id,
        contactId,
        raciRole,
        description ?? `${team.name} - ${level.name}`,
        schedule ?? null,
        responseTime ?? null,
      ]
    );

    const assignmentId = rows[0].id;
    await audit(client, actor, "upsert", "assignment", assignmentId, { ...input, contactId, teamId: team.id, replaced });
    return { assignmentId, contactId, teamId: team.id, countryCode: country.iso_code, levelNumber, replaced: replaced.length };
  });
}

export function deleteAssignment(id, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query("DELETE FROM escalation_raci WHERE id = $1 RETURNING *", [id]);
    if (!rows[0]) throw new HttpError(404, `No existe la asignación ${id}`);
    await audit(client, actor, "delete", "assignment", id, rows[0]);
    return { deleted: id };
  });
}

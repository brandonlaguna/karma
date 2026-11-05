import { pool } from "./pool.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

import { normalizePhone } from "./phone.js";

// Se reexporta: otros módulos ya lo importan desde aquí.
export { normalizePhone };

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

export async function audit(client, actor, action, entity, entityId, payload) {
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

export function upsertTeam(input, actor) {
  return withTransaction((client) => upsertTeamOn(client, input, actor));
}

// Variante que trabaja sobre una conexión/transacción ya abierta: la usa la importación masiva para meter todo en una sola.
export function upsertTeamOn(client, { countryCode, name, resolverGroupCode, siteCode, description }, actor) {
  return (async () => {
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
  })();
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
  return withTransaction((client) => createAssignmentOn(client, input, actor));
}

// Variante que trabaja sobre una conexión/transacción ya abierta (ver upsertTeamOn).
export function createAssignmentOn(client, input, actor) {
  const { countryCode, levelNumber, raciRole, contact, schedule, responseTime, description, replace } = input;

  return (async () => {
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
  })();
}

export function deleteAssignment(id, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query("DELETE FROM escalation_raci WHERE id = $1 RETURNING *", [id]);
    if (!rows[0]) throw new HttpError(404, `No existe la asignación ${id}`);
    await audit(client, actor, "delete", "assignment", id, rows[0]);
    return { deleted: id };
  });
}

const asignaciones = (n) => `${n} ${n === 1 ? "asignación" : "asignaciones"} RACI`;

// En las actualizaciones parciales, un campo que NO viene se conserva y uno que viene en null se borra.
const pick = (input, key, current) => (Object.prototype.hasOwnProperty.call(input, key) ? input[key] : current);

/**
 * Edita una asignación existente: su nivel, rol, equipo, contacto (uno ya existente por contactId, o uno nuevo/por
 * correo con `contact`), horario, tiempo de respuesta y descripción. Si cambia el equipo, el país pasa a ser el del equipo.
 * Una combinación nivel + país + equipo + contacto + rol que ya existe se rechaza (409 por el índice único).
 */
export function updateAssignment(id, input, actor) {
  return withTransaction(async (client) => {
    const current = (await client.query("SELECT * FROM escalation_raci WHERE id = $1", [id])).rows[0];
    if (!current) throw new HttpError(404, `No existe la asignación ${id}`);

    let levelId = current.escalation_level_id;
    if (input.levelNumber !== undefined) {
      const level = (await client.query("SELECT id FROM escalation_levels WHERE level_number = $1", [input.levelNumber])).rows[0];
      if (!level) throw new HttpError(404, `El nivel ${input.levelNumber} no existe`);
      levelId = level.id;
    }

    let teamId = current.team_id;
    let countryId = current.country_id;
    if (input.teamId !== undefined) {
      const team = (await client.query("SELECT id, country_id FROM teams WHERE id = $1", [input.teamId])).rows[0];
      if (!team) throw new HttpError(404, `No existe el equipo ${input.teamId}`);
      teamId = team.id;
      countryId = team.country_id ?? countryId;
    }

    let contactId = current.contact_id;
    if (input.contactId !== undefined) {
      const contact = (await client.query("SELECT id FROM contacts WHERE id = $1", [input.contactId])).rows[0];
      if (!contact) throw new HttpError(404, `No existe el contacto ${input.contactId}`);
      contactId = contact.id;
    } else if (input.contact) {
      contactId = await upsertContact(client, input.contact);
    }

    const { rows } = await client.query(
      `UPDATE escalation_raci
       SET escalation_level_id = $2, country_id = $3, team_id = $4, contact_id = $5, raci_role = $6,
           description = $7, schedule = $8, response_time = $9
       WHERE id = $1
       RETURNING *`,
      [
        id,
        levelId,
        countryId,
        teamId,
        contactId,
        input.raciRole ?? current.raci_role,
        pick(input, "description", current.description),
        pick(input, "schedule", current.schedule),
        pick(input, "responseTime", current.response_time),
      ]
    );
    await audit(client, actor, "update", "assignment", id, { before: current, after: rows[0] });
    return { assignmentId: id };
  });
}

/** Edita un equipo por su id: nombre, país, grupo resolutor, sede y descripción (null borra el valor). */
export function updateTeam(id, input, actor) {
  return withTransaction(async (client) => {
    const current = (await client.query("SELECT * FROM teams WHERE id = $1", [id])).rows[0];
    if (!current) throw new HttpError(404, `No existe el equipo ${id}`);

    let countryId = current.country_id;
    if (input.countryCode) countryId = (await findCountry(client, input.countryCode)).id;

    const { rows } = await client.query(
      `UPDATE teams SET name = $2, country_id = $3, resolver_group_code = $4, site_code = $5, description = $6
       WHERE id = $1
       RETURNING id, name, resolver_group_code, site_code, description`,
      [
        id,
        input.name ?? current.name,
        countryId,
        pick(input, "resolverGroupCode", current.resolver_group_code),
        pick(input, "siteCode", current.site_code),
        pick(input, "description", current.description),
      ]
    );
    await audit(client, actor, "update", "team", id, { before: current, after: rows[0] });
    return rows[0];
  });
}

/** Un equipo con asignaciones no se borra: dejaría la matriz sin saber a quién escalar para ese equipo. */
export function deleteTeam(id, actor) {
  return withTransaction(async (client) => {
    const used = (await client.query("SELECT count(*)::int AS n FROM escalation_raci WHERE team_id = $1", [id])).rows[0].n;
    if (used > 0) throw new HttpError(409, `El equipo tiene ${asignaciones(used)}: elimínalas o muévelas antes de borrarlo`);
    const { rows } = await client.query("DELETE FROM teams WHERE id = $1 RETURNING *", [id]);
    if (!rows[0]) throw new HttpError(404, `No existe el equipo ${id}`);
    await audit(client, actor, "delete", "team", id, rows[0]);
    return { deleted: id };
  });
}

/** Edita un contacto: nombre, correo, teléfono y si está activo. */
export function updateContact(id, input, actor) {
  return withTransaction(async (client) => {
    const current = (await client.query("SELECT * FROM contacts WHERE id = $1", [id])).rows[0];
    if (!current) throw new HttpError(404, `No existe el contacto ${id}`);

    const { rows } = await client.query(
      `UPDATE contacts SET name = $2, email = $3, phone = $4, active = $5 WHERE id = $1
       RETURNING id, name, email, phone, active`,
      [
        id,
        input.name ?? current.name,
        pick(input, "email", current.email),
        normalizePhone(pick(input, "phone", current.phone)),
        input.active ?? current.active,
      ]
    );
    await audit(client, actor, "update", "contact", id, { before: current, after: rows[0] });
    return rows[0];
  });
}

/** Un contacto asignado no se borra (se desactiva con active=false): quedaría una asignación apuntando a nadie. */
export function deleteContact(id, actor) {
  return withTransaction(async (client) => {
    const used = (await client.query("SELECT count(*)::int AS n FROM escalation_raci WHERE contact_id = $1", [id])).rows[0].n;
    if (used > 0) throw new HttpError(409, `El contacto tiene ${asignaciones(used)}: quítalo de ellas o desactívalo en vez de borrarlo`);
    const { rows } = await client.query("DELETE FROM contacts WHERE id = $1 RETURNING *", [id]);
    if (!rows[0]) throw new HttpError(404, `No existe el contacto ${id}`);
    await audit(client, actor, "delete", "contact", id, rows[0]);
    return { deleted: id };
  });
}

/** Un país con equipos, sondas, dispositivos o asignaciones no se borra. */
export function deleteCountry(isoCode, actor) {
  return withTransaction(async (client) => {
    const country = (await client.query("SELECT id, iso_code, name FROM countries WHERE iso_code = $1", [isoCode.toUpperCase()])).rows[0];
    if (!country) throw new HttpError(404, `El país "${isoCode}" no existe`);

    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM teams WHERE country_id = $1) AS teams,
              (SELECT count(*)::int FROM escalation_raci WHERE country_id = $1) AS assignments,
              (SELECT count(*)::int FROM opmanager_probes WHERE country_id = $1) AS probes,
              (SELECT count(*)::int FROM devices WHERE country_id = $1) AS devices`,
      [country.id]
    );
    const inUse = Object.entries(rows[0]).filter(([, count]) => count > 0);
    if (inUse.length) {
      throw new HttpError(409, `El país está en uso (${inUse.map(([what, count]) => `${count} ${what}`).join(", ")}): no se puede borrar`);
    }
    await client.query("DELETE FROM countries WHERE id = $1", [country.id]);
    await audit(client, actor, "delete", "country", country.id, country);
    return { deleted: country.iso_code };
  });
}

/** Un nivel con asignaciones no se borra. */
export function deleteLevel(levelNumber, actor) {
  return withTransaction(async (client) => {
    const level = (await client.query("SELECT id, level_number, name FROM escalation_levels WHERE level_number = $1", [levelNumber])).rows[0];
    if (!level) throw new HttpError(404, `El nivel ${levelNumber} no existe`);
    const used = (await client.query("SELECT count(*)::int AS n FROM escalation_raci WHERE escalation_level_id = $1", [level.id])).rows[0].n;
    if (used > 0) throw new HttpError(409, `El nivel tiene ${asignaciones(used)}: no se puede borrar`);
    await client.query("DELETE FROM escalation_levels WHERE id = $1", [level.id]);
    await audit(client, actor, "delete", "level", level.id, level);
    return { deleted: levelNumber };
  });
}

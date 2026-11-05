import { pool } from "./pool.js";
import { HttpError, audit, createAssignmentOn, upsertTeamOn } from "./escalationAdmin.js";
import { MAX_ROWS_PER_SHEET, fold, normalizeAssignmentRow, normalizeTeamRow } from "./escalationImport.logic.js";

/**
 * Importación masiva de la matriz RACI (equipos y asignaciones) desde las filas que el navegador lee del Excel.
 *
 * Todo ocurre en UNA transacción, con un punto de guardado por fila para poder reunir TODOS los errores del archivo en
 * una sola pasada (sin él, el primer fallo anularía el resto). Al final:
 *   - dryRun = true  -> se deshace siempre: es la "prueba en seco" que le muestra al usuario qué pasaría.
 *   - hay algún error -> se deshace: la importación es todo o nada, así la matriz nunca queda a medias.
 *   - si no -> se confirma, con una entrada de auditoría que resume la carga.
 * Solo crea y actualiza: borrar se hace desde la pantalla, nunca por omisión en un archivo.
 */

const SAVEPOINT = "import_row";

const issueFor = (sheet, row, status, action, messages) => ({ sheet, row, status, action, messages });

// Una fila que falla por una regla de la base (nombre repetido, grupo ya usado...) se explica en términos del Excel.
function explain(error) {
  if (error instanceof HttpError) return error.message;
  if (error?.code === "23505") {
    const detail = String(error.detail ?? "");
    if (detail.includes("resolver_group_code")) return "Ese grupo resolutor ya pertenece a otro equipo (debe ser único en toda la matriz)";
    if (detail.includes("site_code")) return "Esa sede ya pertenece a otro equipo (debe ser única en toda la matriz)";
    return "Ya existe un registro con ese valor único";
  }
  return null; // inesperado: se deja subir para no ocultar un fallo real
}

async function inSavepoint(client, work) {
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const result = await work();
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return { ok: true, result };
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    const message = explain(error);
    if (message === null) throw error;
    return { ok: false, message };
  }
}

/** El equipo al que se refiere una asignación: por grupo resolutor, por sede o por nombre dentro del país. */
async function resolveTeam(client, ref, countryId) {
  const byCode = await client.query(
    `SELECT id, name, country_id, resolver_group_code, site_code FROM teams WHERE lower(resolver_group_code) = lower($1) OR lower(site_code) = lower($1)`,
    [ref]
  );
  if (byCode.rows[0]) return byCode.rows[0];
  const byName = await client.query(`SELECT id, name, country_id, resolver_group_code, site_code FROM teams WHERE lower(name) = lower($1) AND country_id = $2`, [ref, countryId]);
  return byName.rows[0] ?? null;
}

async function countContacts(client) {
  return (await client.query("SELECT count(*)::int AS n FROM contacts")).rows[0].n;
}

/**
 * @param {{ teams?: object[], assignments?: object[], dryRun?: boolean }} input  filas tal cual salen del Excel
 * @param {{ id, name, authenticated }} actor
 */
export async function importMatrix(input, actor) {
  const teamRows = input.teams ?? [];
  const assignmentRows = input.assignments ?? [];
  if (teamRows.length > MAX_ROWS_PER_SHEET || assignmentRows.length > MAX_ROWS_PER_SHEET) {
    throw new HttpError(400, `Cada hoja admite hasta ${MAX_ROWS_PER_SHEET} filas`);
  }
  if (teamRows.length + assignmentRows.length === 0) throw new HttpError(400, "El archivo no trae filas para importar");
  const dryRun = input.dryRun !== false; // por omisión NO escribe: confirmar exige pedirlo de forma explícita

  const issues = [];
  const summary = {
    teams: { total: teamRows.length, create: 0, update: 0, errors: 0 },
    assignments: { total: assignmentRows.length, create: 0, update: 0, errors: 0 },
    newContacts: 0,
  };

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const contactsBefore = await countContacts(client);
    const countries = (await client.query("SELECT id, iso_code, name FROM countries")).rows;
    const countryByIso = new Map(countries.map((country) => [country.iso_code, country]));
    const levels = (await client.query("SELECT id, level_number, name FROM escalation_levels")).rows;
    const levelByNumber = new Map(levels.map((level) => [level.level_number, level]));

    // ---- Equipos ----
    const seenTeams = new Map(); // "ISO|nombre" -> fila
    const seenCodes = new Map(); // grupo o sede -> fila
    for (const [index, raw] of teamRows.entries()) {
      const rowNumber = raw.row ?? index + 2;
      const { errors, value } = normalizeTeamRow({ ...raw, row: rowNumber }, countries);

      if (!errors.length) {
        const teamKey = `${value.iso}|${fold(value.name)}`;
        if (seenTeams.has(teamKey)) errors.push(`Este equipo ya aparece en la fila ${seenTeams.get(teamKey)}`);
        else seenTeams.set(teamKey, rowNumber);
        for (const [label, code] of [["grupo resolutor", value.resolverGroupCode], ["sede", value.siteCode]]) {
          if (!code) continue;
          const codeKey = `${label}|${fold(code)}`;
          if (seenCodes.has(codeKey)) errors.push(`El ${label} «${code}» ya aparece en la fila ${seenCodes.get(codeKey)}`);
          else seenCodes.set(codeKey, rowNumber);
        }
      }
      if (errors.length) {
        summary.teams.errors += 1;
        issues.push(issueFor("Equipos", rowNumber, "error", null, errors));
        continue;
      }

      const country = countryByIso.get(value.iso);
      const warnings = [];
      const attempt = await inSavepoint(client, async () => {
        const existing = (await client.query("SELECT id, name, resolver_group_code, site_code FROM teams WHERE lower(name) = lower($1) AND country_id = $2", [value.name, country.id])).rows[0];
        if (existing) {
          if (value.resolverGroupCode && existing.resolver_group_code && fold(existing.resolver_group_code) !== fold(value.resolverGroupCode)) {
            warnings.push(`Cambia el grupo resolutor de «${existing.resolver_group_code}» a «${value.resolverGroupCode}»`);
          }
          if (value.siteCode && existing.site_code && fold(existing.site_code) !== fold(value.siteCode)) warnings.push(`Cambia la sede de «${existing.site_code}» a «${value.siteCode}»`);
        }
        // Con el nombre ya guardado se actualiza el mismo equipo aunque el Excel lo escriba con otras mayúsculas.
        await upsertTeamOn(client, { countryCode: value.iso, name: existing?.name ?? value.name, resolverGroupCode: value.resolverGroupCode, siteCode: value.siteCode, description: value.description }, actor);
        return existing ? "actualizar" : "crear";
      });

      if (!attempt.ok) {
        summary.teams.errors += 1;
        issues.push(issueFor("Equipos", rowNumber, "error", null, [attempt.message]));
        continue;
      }
      summary.teams[attempt.result === "crear" ? "create" : "update"] += 1;
      if (warnings.length) issues.push(issueFor("Equipos", rowNumber, "warning", attempt.result, warnings));
    }

    // ---- Asignaciones (ven los equipos recién creados arriba: están en la misma transacción) ----
    const seenAssignments = new Map();
    for (const [index, raw] of assignmentRows.entries()) {
      const rowNumber = raw.row ?? index + 2;
      const { errors, value } = normalizeAssignmentRow({ ...raw, row: rowNumber }, countries);
      if (!errors.length && !levelByNumber.has(value.levelNumber)) errors.push(`El nivel ${value.levelNumber} no existe: créalo primero en la pestaña Países y niveles`);

      let team = null;
      if (!errors.length) {
        const country = countryByIso.get(value.iso);
        team = await resolveTeam(client, value.teamRef, country.id);
        if (!team) errors.push(`No existe el equipo «${value.teamRef}» (se busca por grupo resolutor, sede o nombre en ${value.iso}): agrégalo en la hoja Equipos`);
        else if (team.country_id == null) errors.push(`El equipo «${team.name}» no tiene país: asígnale uno en la pestaña Equipos`);
        else if (team.country_id !== country.id) {
          const owner = countries.find((item) => item.id === team.country_id);
          errors.push(`El equipo «${team.name}» pertenece a ${owner?.iso_code ?? "otro país"}, no a ${value.iso}`);
        }
      }
      if (!errors.length) {
        const contactKey = value.contact.email ? fold(value.contact.email) : fold(value.contact.name);
        const key = `${team.id}|${value.levelNumber}|${value.raciRole}|${contactKey}`;
        if (seenAssignments.has(key)) errors.push(`Esta asignación ya aparece en la fila ${seenAssignments.get(key)}`);
        else seenAssignments.set(key, rowNumber);
      }
      if (errors.length) {
        summary.assignments.errors += 1;
        issues.push(issueFor("Asignaciones", rowNumber, "error", null, errors));
        continue;
      }

      const warnings = [];
      const attempt = await inSavepoint(client, async () => {
        const existingContact = value.contact.email
          ? (await client.query("SELECT id, name FROM contacts WHERE lower(email) = lower($1)", [value.contact.email])).rows[0]
          : (await client.query("SELECT id, name FROM contacts WHERE email IS NULL AND name = $1", [value.contact.name])).rows[0];
        if (existingContact && fold(existingContact.name) !== fold(value.contact.name)) {
          warnings.push(`El correo ya pertenece a «${existingContact.name}»: se actualizará su nombre a «${value.contact.name}»`);
        }
        const levelId = levelByNumber.get(value.levelNumber).id;
        const existing = existingContact
          ? (await client.query("SELECT id FROM escalation_raci WHERE escalation_level_id = $1 AND country_id = $2 AND team_id = $3 AND contact_id = $4 AND raci_role = $5", [levelId, team.country_id, team.id, existingContact.id, value.raciRole])).rows[0]
          : null;

        await createAssignmentOn(
          client,
          {
            countryCode: value.iso,
            teamName: team.name,
            levelNumber: value.levelNumber,
            raciRole: value.raciRole,
            contact: value.contact,
            schedule: value.schedule,
            responseTime: value.responseTime,
            description: value.description,
            replace: false,
          },
          actor
        );
        return existing ? "actualizar" : "crear";
      });

      if (!attempt.ok) {
        summary.assignments.errors += 1;
        issues.push(issueFor("Asignaciones", rowNumber, "error", null, [attempt.message]));
        continue;
      }
      summary.assignments[attempt.result === "crear" ? "create" : "update"] += 1;
      if (warnings.length) issues.push(issueFor("Asignaciones", rowNumber, "warning", attempt.result, warnings));
    }

    summary.newContacts = (await countContacts(client)) - contactsBefore;
    const failed = summary.teams.errors + summary.assignments.errors > 0;

    if (!dryRun && !failed) {
      await audit(client, actor, "import", "matrix", null, { teams: summary.teams, assignments: summary.assignments, newContacts: summary.newContacts });
      await client.query("COMMIT");
      committed = true;
    } else {
      await client.query("ROLLBACK");
    }

    issues.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row);
    return { dryRun, committed, canImport: !failed, summary, issues };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "42P01") {
      throw new HttpError(500, "Falta una tabla de la matriz (probablemente escalation_audit_log): ejecuta «pnpm run migrate» en ai-lab y vuelve a intentar");
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Lógica pura (sin base de datos) de la importación masiva de la matriz RACI: normaliza lo que llega del Excel y lo valida
 * fila por fila, con mensajes en español que dicen QUÉ corregir. Lo que depende de la base (si el equipo existe, si el
 * contacto ya está registrado...) lo resuelve escalationImport.js.
 *
 * Hojas del Excel:
 *   Equipos       País | Nombre del equipo | Grupo resolutor | Sede | Descripción
 *   Asignaciones  País | Equipo | Nivel | Rol | Contacto | Correo | Teléfono | Horario | Tiempo de respuesta | Descripción
 */
import { normalizePhone } from "./phone.js";

export const MAX_ROWS_PER_SHEET = 3000;
export const ROLES = ["R", "A", "C", "I"];

/** Para comparar sin importar mayúsculas, tildes ni espacios de más ("Perú" = "PERU"). */
export const fold = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const line = (value) => (value == null ? "" : String(value).replace(/\s+/g, " ").trim());
const block = (value) => (value == null ? "" : String(value).replace(/\r\n/g, "\n").trim());

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLE_WORDS = { responsable: "R", aprobador: "A", aprueba: "A", accountable: "A", consultado: "C", consulta: "C", informado: "I", informa: "I" };

/** "CO", "co", "CO · Colombia" o "Colombia" -> código ISO de un país que exista; si no, un error claro. */
export function parseCountry(value, countries) {
  const text = line(value);
  if (!text) return { error: "Falta el país" };
  const head = text.includes("·") ? text.split("·")[0].trim() : text;
  const byIso = /^[A-Za-z]{2}$/.test(head) ? countries.find((country) => country.iso_code === head.toUpperCase()) : null;
  const found = byIso ?? countries.find((country) => fold(country.name) === fold(head));
  return found ? { iso: found.iso_code } : { error: `El país «${text}» no existe: créalo primero en la pestaña Países y niveles` };
}

/** "1", 1 o "1 · Primera respuesta" -> 1. */
export function parseLevel(value) {
  const text = line(value);
  if (!text) return { error: "Falta el nivel" };
  const match = text.match(/^(\d{1,3})(?:\b|\s*·)/);
  return match ? { level: Number(match[1]) } : { error: `El nivel «${text}» no es válido: usa el número (0, 1, 2…) o elige uno de la lista` };
}

/** "R", "r · Responsable" o "Responsable" -> "R". */
export function parseRole(value) {
  const text = line(value);
  if (!text) return { error: "Falta el rol RACI" };
  const head = fold(text.split("·")[0]);
  if (head.length === 1 && ROLES.includes(head.toUpperCase())) return { role: head.toUpperCase() };
  const byWord = ROLE_WORDS[head];
  return byWord ? { role: byWord } : { error: `El rol «${text}» no es válido: usa R, A, C o I` };
}

const tooLong = (label, value, max) => (value.length > max ? `${label} supera ${max} caracteres` : null);

/** Fila de la hoja Equipos. */
export function normalizeTeamRow(raw, countries) {
  const errors = [];
  const country = parseCountry(raw.country, countries);
  if (country.error) errors.push(country.error);

  const name = line(raw.name);
  const resolverGroupCode = line(raw.resolverGroupCode);
  const siteCode = line(raw.siteCode);
  const description = block(raw.description);
  if (!name) errors.push("Falta el nombre del equipo");
  for (const message of [tooLong("El nombre", name, 100), tooLong("El grupo resolutor", resolverGroupCode, 50), tooLong("La sede", siteCode, 50), tooLong("La descripción", description, 1000)]) {
    if (message) errors.push(message);
  }

  return {
    errors,
    value: { row: raw.row, iso: country.iso, name, resolverGroupCode: resolverGroupCode || undefined, siteCode: siteCode || undefined, description: description || undefined },
  };
}

/** Fila de la hoja Asignaciones. */
export function normalizeAssignmentRow(raw, countries) {
  const errors = [];
  const country = parseCountry(raw.country, countries);
  if (country.error) errors.push(country.error);
  const level = parseLevel(raw.level);
  if (level.error) errors.push(level.error);
  const role = parseRole(raw.role);
  if (role.error) errors.push(role.error);

  const team = line(raw.team);
  if (!team) errors.push("Falta el equipo (grupo resolutor, sede o nombre)");

  const contactName = line(raw.contactName);
  const contactEmail = line(raw.contactEmail);
  const phone = normalizePhone(block(raw.contactPhone)) ?? "";
  const schedule = line(raw.schedule);
  const responseTime = line(raw.responseTime);
  const description = block(raw.description);
  if (!contactName) errors.push("Falta el nombre del contacto");
  if (contactEmail && !EMAIL.test(contactEmail)) errors.push(`El correo «${contactEmail}» no es válido`);
  for (const message of [
    tooLong("El nombre del contacto", contactName, 150),
    tooLong("El correo", contactEmail, 150),
    tooLong("El teléfono", phone, 255),
    tooLong("El horario", schedule, 100),
    tooLong("El tiempo de respuesta", responseTime, 100),
    tooLong("La descripción", description, 1000),
  ]) {
    if (message) errors.push(message);
  }

  return {
    errors,
    value: {
      row: raw.row,
      iso: country.iso,
      teamRef: team,
      levelNumber: level.level,
      raciRole: role.role,
      contact: { name: contactName, email: contactEmail || undefined, phone: phone || undefined },
      schedule: schedule || undefined,
      responseTime: responseTime || undefined,
      description: description || undefined,
    },
  };
}

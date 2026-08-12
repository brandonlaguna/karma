import { pool } from "./pool.js";

/**
 * Busca un dispositivo en el inventario propio (catalogado a mano desde
 * los Excel de NOC) por nombre exacto o parcial. Sirve como respaldo
 * cuando el customField de OpManager no está bien diligenciado -- si el
 * dispositivo ya está catalogado acá, se resuelve país/ciudad/sede/
 * grupo de soporte sin depender de parsear el nombre.
 */
export async function findDevice(deviceName) {
  const exact = await pool.query(
    `SELECT d.*, c.iso_code AS country_iso, c.name AS country_name
     FROM devices d
     LEFT JOIN countries c ON c.id = d.country_id
     WHERE d.device_name = $1`,
    [deviceName]
  );
  if (exact.rows[0]) return exact.rows[0];

  const partial = await pool.query(
    `SELECT d.*, c.iso_code AS country_iso, c.name AS country_name
     FROM devices d
     LEFT JOIN countries c ON c.id = d.country_id
     WHERE d.device_name ILIKE $1 OR d.display_name ILIKE $1
     LIMIT 5`,
    [`%${deviceName}%`]
  );
  return partial.rows;
}

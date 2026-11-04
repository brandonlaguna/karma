/**
 * Fuentes (vendors) activas en este despliegue, desde ENABLED_VENDORS. Misma regla que el servidor MCP
 * (mcp-server/src/mcp/buildServer.ts, isVendorEnabled): lista separada por comas; VACÍO = todas. Así el prompt y las
 * herramientas que ve el modelo siempre coinciden: ni se describe una herramienta que no existe, ni se omite una que sí.
 */
export const KNOWN_VENDORS = ["zabbix", "opmanager"] as const;
export type Vendor = (typeof KNOWN_VENDORS)[number];

export function activeVendors(raw: string | undefined = process.env.ENABLED_VENDORS): Set<Vendor> {
  const list = (raw ?? "").trim().toLowerCase();
  if (!list) return new Set(KNOWN_VENDORS);
  const wanted = list.split(",").map((item) => item.trim());
  // Los nombres que no son un vendor con prompt propio (p. ej. servicedeskplus) se ignoran aquí.
  return new Set(KNOWN_VENDORS.filter((vendor) => wanted.includes(vendor)));
}

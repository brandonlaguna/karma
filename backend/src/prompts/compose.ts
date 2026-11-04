/**
 * Recetas que arman cada prompt a partir de los bloques: lo común más lo de cada vendor ACTIVO en el despliegue.
 * Fusionet (solo Zabbix) recibe común + Zabbix; Atento (OpManager y Zabbix) recibe común + OpManager + Zabbix.
 *
 * Para agregar un vendor: un archivo de bloques nuevo, su nombre en KNOWN_VENDORS (vendors.ts) y sus piezas en estas dos
 * recetas. El orden de las secciones es el que tenían los prompts originales.
 */
import type { Vendor } from "./vendors.js";
import * as common from "./common.js";
import * as zabbix from "./zabbix.js";
import * as opmanager from "./opmanager.js";

const join = (parts: Array<string | false | null | undefined>, separator: string): string =>
  parts.filter((part): part is string => Boolean(part)).join(separator);

// NUEVO: con más de una fuente activa, cada herramienta ve SOLO la suya; sin esta regla el modelo respondía "hay N alertas
// activas" con la cifra de una fuente como si fuera del ecosistema completo.
const SCOPE_BY_SOURCE =
  'ALCANCE POR FUENTE: cada herramienta ve solo SU fuente. Las de Zabbix cubren únicamente lo que está en Zabbix y las de OpManager, únicamente lo de OpManager. Nunca presentes una cifra de una fuente como si fuera del ecosistema completo: di siempre de cuál fuente es ("en Zabbix hay...", "en OpManager hay..."). Si te piden un total global o un panorama general ("¿qué alertas hay activas?"), consulta AMBOS resúmenes ("get_zabbix_active_overview" y "get_opmanager_active_overview") y preséntalos por separado, cada uno con su fuente: "En Zabbix hay N...", "En OpManager hay M...". Si das un total conjunto, di que es la suma de ambas fuentes; nunca abras con "Actualmente hay N alertas activas" a secas. Los dos conteos no se calculan igual (Zabbix se verifica en vivo contra Zabbix; OpManager muestra lo abierto en EPISTECH): si ambos son relevantes, dilo en una línea. Si una de las dos consultas falla, da la otra con su fuente y di cuál no pudiste consultar. Nunca afirmes que una fuente "no tiene datos" o "no está disponible" sin haberla consultado en ESTE turno: un error de un mensaje anterior de la conversación no cuenta, vuelve a llamar la herramienta.';

/** Prompt del análisis de una alerta (context "alert_triage"). */
export function composeTriagePrompt(vendors: Set<Vendor>): string {
  const z = vendors.has("zabbix");
  const o = vendors.has("opmanager");

  // Cada regla de vendor es una viñeta; las frases "las tools del otro vendor no aplican" solo van si el otro está activo.
  const zabbixRule = join([zabbix.TRIAGE_VENDOR_RULE_START, o && zabbix.TRIAGE_NOT_OPMANAGER_TOOLS, zabbix.TRIAGE_VENDOR_RULE_END], "\n  ");
  const opmanagerRule = join([opmanager.TRIAGE_VENDOR_RULE, z && opmanager.TRIAGE_NOT_ZABBIX_TOOLS], "\n  ");
  const vendorRules = join([common.TRIAGE_VENDOR_HEADER, z && zabbixRule, o && opmanagerRule], "\n");
  const tools = join(
    [
      common.TRIAGE_TOOLS_HEADER,
      z && zabbix.TRIAGE_TOOL,
      common.TOOL_GET_ALERT_BY_ID,
      ...(o ? opmanager.TRIAGE_TOOLS : []),
      common.TOOL_KNOWLEDGE_BASE,
      common.TOOL_ESCALATION_MATRIX,
    ],
    "\n"
  );
  // El último párrafo de cierre (HERRAMIENTAS) lleva, si Zabbix está activo, su ejemplo de conectividad.
  const closing = [...common.TRIAGE_CLOSING];
  if (z) closing[closing.length - 1] = `${closing[closing.length - 1]} ${zabbix.CONNECTIVITY_EXAMPLE}`;

  return join([...common.TRIAGE_INTRO, vendorRules, tools, o && opmanager.TRIAGE_DEVICE_ATTRIBUTES, ...closing], "\n\n").trim();
}

/** Prompt del asistente general (panel lateral, sin alerta puntual). */
export function composeGeneralPrompt(vendors: Set<Vendor>): string {
  const z = vendors.has("zabbix");
  const o = vendors.has("opmanager");

  // Un solo párrafo en el original: la ayuda de Zabbix y el manejo del Alert ID van entrelazados.
  const alertsParagraph = join([z && zabbix.GENERAL_OVERVIEW, common.GENERAL_ALERT_ID_HANDLING, z && zabbix.GENERAL_DIG_DEEPER, common.GENERAL_NO_INVENTAR], " ");
  const dataRule = join([common.GENERAL_SOLO_TOOLS, z && zabbix.GENERAL_CLIENTES], " ");
  const closing = [...common.GENERAL_CLOSING];
  if (z) closing[closing.length - 1] = `${closing[closing.length - 1]} ${zabbix.CONNECTIVITY_EXAMPLE}`;

  return join(
    [
      ...common.GENERAL_INTRO,
      alertsParagraph,
      o && opmanager.GENERAL_OPMANAGER,
      z && zabbix.GENERAL_EQUIPOS,
      z && zabbix.GENERAL_MUESTRAS,
      z && zabbix.GENERAL_ALCANCE,
      z && o && SCOPE_BY_SOURCE,
      common.GENERAL_CAUSAS,
      dataRule,
      ...closing,
    ],
    "\n\n"
  ).trim();
}

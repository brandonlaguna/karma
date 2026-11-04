/**
 * Bloques de prompt de OPMANAGER: se incluyen solo si OpManager está entre los vendors activos (ENABLED_VENDORS). Las
 * viñetas de herramientas son las que ya existían en el prompt de análisis de alerta; los bloques marcados como NUEVO
 * se añadieron al separar los prompts por vendor. Receta de ensamblado en compose.ts.
 */
// NUEVO: contraparte de la regla de Zabbix; solo si Zabbix también está activo (ver compose.ts).
export const TRIAGE_NOT_ZABBIX_TOOLS = `Las tools de Zabbix ("get_zabbix_alert_insight") NO aplican a alertas de
  OpManager: no las llames.`;
export const TRIAGE_VENDOR_RULE =`- Si es OPMANAGER: usa las tools de OpManager descritas abajo.`;
export const TRIAGE_TOOLS = [
  `- "get_device_info": información básica de un dispositivo a partir de su
  nombre. Para investigar una alerta normalmente NO hace falta: las tools
  get_device_notes, get_interface_graphs y get_trace_response reciben el
  "entity" de json_result y resuelven solas el dispositivo y su probeID.
  Úsala solo si te preguntan por un dispositivo sin alerta de por medio.`,
  `- "get_alarm_properties" (con el "entity" de json_result): para saber si
  sigue activa (alarma.severidadActual), se restableció, quién la
  reconoció, o si hay caídas constantes (eventosRecientes). alarma.tipo
  dice qué es ("Interface Down", "Device Down", "Threshold"...): si
  alarma.interfaz no es null la alerta es de una interfaz, si es null es
  de dispositivo.`,
  `- "get_device_notes": customFields del dispositivo -- país, ciudad,
  sede, área resolutora ("Grupo Resolutor", ej. "CO-REDES",
  "CO-SERVIDORES", "CO-TELEFONIA"), criticidad. Es la fuente PRINCIPAL
  para "¿a quién le reporto esto?" -- si trae "Grupo Resolutor", pásalo
  tal cual como "resolverGroupCode" a get_escalation_matrix. Pásale
  SOLO el "entity" de json_result, tal cual: la tool obtiene de OpManager
  el probeID y el nombre del dispositivo, no los armes tú.`,
  `- "search_device_inventory": respaldo cuando get_device_notes no trae
  customFields completos (dispositivo mal diligenciado en OpManager).
  Busca por nombre del dispositivo en el inventario propio catalogado
  desde los Excel de NOC y devuelve país/ciudad/sede/grupo de soporte.
  Úsala solo si get_device_notes se quedó corto -- no la corras por
  rutina.`,
  `- "get_interface_graphs": solo si la pregunta es sobre tráfico/estado de
  una interfaz puntual. Pásale SOLO el campo "entity" de json_result, tal
  cual (ej. "IF-172.21.49.4.50000000001-7_Poll" o "IF_UTIL_50000027344"):
  la tool le pregunta a OpManager el nombre exacto de la interfaz y el
  probeID -- NO los armes ni los transcribas tú. Si responde que la alarma
  no es de una interfaz, es una alerta de dispositivo: no hay gráficas de
  interfaz, no insistas. El resultado ya viene resumido (estadísticas de
  Rx/Tx del período): cita los valores con su unidad (bits por segundo) y
  si hubo picos.`,
  `- "get_device_notes" devuelve { campos } con pares nombre-valor: "Site" es la
  sede, "Rol" es la función del dispositivo en la red (NO la sede) y
  "Responsable a cargo" es quien lo administra -- menciónalo si aporta a
  quién escalar.`,
  `- "get_trace_response": solo si preguntan por conectividad/ruta de red.
  Pásale SOLO el "entity" de json_result, tal cual.`,
  `- Para decodificar a quién pertenece un dispositivo de OpManager el orden es: primero "get_device_notes", después "search_device_inventory" y, como ÚLTIMO recurso, la nomenclatura de nombres que trae "search_knowledge_base".`,
];

// NUEVO: desde que la ingesta guarda los datos del equipo en device_attributes, el detalle ya trae probe, área, país...
export const TRIAGE_DEVICE_ATTRIBUTES = `DATOS DEL EQUIPO EN OPMANAGER: el detalle ya cargado de una alerta de OpManager trae el campo "device_attributes" con los datos del equipo guardados al ingerirla (probe, área, país, sede, servicio, criticidad, grupo resolutor y alias). Úsalos primero para decir a qué equipo, probe y área pertenece la alerta; llama a "get_device_notes" solo si falta un dato que necesites o si piden el valor actual en OpManager.`;

// NUEVO: el asistente general no tenía nada de OpManager (todo su texto era de Zabbix).
export const GENERAL_OPMANAGER = `Sobre alertas de OPMANAGER: el detalle de una alerta ("get_alert_by_id") puede traer el campo "device_attributes" con los datos del equipo guardados al ingerirla (probe, área, país, sede, servicio, criticidad, grupo resolutor, alias). Cuando te pregunten por una alerta de OpManager, di siempre a qué equipo, probe y área pertenece usando esos datos; si el campo viene vacío, dilo y ofrece consultar "get_device_notes". Además, si el estado de la alerta es resuelta o cerrada, preséntala como resuelta (con su fecha) y no la describas como crítica o activa. Para investigar un equipo concreto usa sus herramientas: "get_device_info" para resolver el equipo y su probe, "get_device_notes" para sus campos personalizados (país, sede, área, grupo resolutor, criticidad) y, solo si la pregunta lo pide, "get_alarm_properties", "get_interface_graphs" y "get_trace_response". Para preguntas generales de OpManager ("¿qué alertas hay activas en OpManager?", "¿qué probe o país tiene más alertas?", "¿cuántas hay en Perú?", "¿qué tipo de alerta predomina?") usa "get_opmanager_active_overview": trae el total, y los desgloses por país, probe, sede, área, criticidad, tipo de alerta y equipo; para acotar a un lugar pásale el filtro pais, probe, sede o area. "Sin dato" son alertas cuyo equipo no tiene ese campo diligenciado en OpManager: dilo así, sin inventar a quién pertenecen. Esas cifras son las alertas abiertas según EPISTECH, sin verificar en vivo contra OpManager: si casi todas llevan más de 7 días, avisa que pueden incluir alertas ya restablecidas que EPISTECH no ha cerrado. Para profundizar en una alerta del listado usa "get_alert_by_id" con su "id".`;

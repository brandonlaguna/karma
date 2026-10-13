/**
 * Cliente hacia los endpoints de OpManager que ya expone EpistechBackend
 * (mismo servidor Docker, red compartida `net_container` -- ver
 * EPISTECH/docker-compose.yml -- el que de verdad está en uso --,
 * servicio "backend" / container_name "epistech-backend", con GUION).
 *
 * mcp-server NO le habla a OpManager directo -- reusa las rutas que ya
 * existen en Epistech (EpistechBackend/routes/opmanager.route.js), para
 * no duplicar la lógica de autenticación/throttling que ya vive ahí.
 */
import { internalAuthHeaders } from "../auth/internalToken.js";

const EPISTECH_BACKEND_URL = process.env.EPISTECH_BACKEND_URL || "http://epistech-backend:4000";

async function postToEpistech(path, body) {
  const url = `${EPISTECH_BACKEND_URL}/api/opmanager/${path}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    // fetch() lanza un error genérico ("fetch failed") sin decir a qué
    // URL intentaba conectarse ni por qué -- pasa antes de recibir
    // cualquier respuesta HTTP, así que es de red (DNS, conexión
    // rechazada, timeout), no del endpoint. Se envuelve con la URL y la
    // causa real (networkError.cause, ej. ECONNREFUSED/ENOTFOUND) para
    // no tener que adivinar la próxima vez que pase.
    throw new Error(
      `No se pudo conectar a EpistechBackend en ${url} -- ${networkError.cause?.code || networkError.message}. ` +
        `Verifica que el contenedor "epistech_backend" esté arriba y en la misma red Docker (net_container).`
    );
  }

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`EpistechBackend /api/opmanager/${path} respondió ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

/**
 * Puente device -> probeID. Los otros 3 endpoints (notas, gráficas,
 * traza) piden "eeProbeID", que no viene directo en la alerta cruda --
 * hay que resolverlo primero a partir del nombre del dispositivo.
 */
export async function getDeviceInfo({ deviceName }) {
  return postToEpistech("getDeviceInfo", { deviceName });
}

/**
 * Historial/estado de la alarma: si se restableció, si sigue caída, y
 * el histórico de eventos. Usa "entity" (NO "alarmId" -- confirmado con
 * Victor, son nombres distintos para lo mismo y solo "entity" funciona
 * contra esta instancia de OpManager vía este endpoint HTTP).
 */
export async function getAlarmsProperties({ entity }) {
  return postToEpistech("getAlarmsProperties", { entity });
}

/**
 * customFields del dispositivo: país, ciudad, sede, área resolutora,
 * criticidad, etc.
 */
export async function getDeviceNotes({ name, eeProbeID }) {
  return postToEpistech("getDeviceNotes", { name, eeProbeID });
}

/**
 * Estado/tráfico de una interfaz específica del dispositivo (cuando la
 * alerta aplica a una interfaz puntual, no al dispositivo completo).
 */
// OpManager exige graphName/isFluidic/graphFilterType/period; los defaults son
// los de la consulta de tráfico del día que usa su propia interfaz.
export async function getInterfaceGraphs({
  eeProbeID,
  interfaceName,
  graphName = "traffic",
  isFluidic = true,
  graphFilterType = "avg",
  period = "Today",
}) {
  // El "entity" de las alertas de caída trae un sufijo "_Poll" que OpManager rechaza.
  return postToEpistech("getInterfaceGraphs", {
    eeProbeID,
    interfaceName: interfaceName.replace(/_Poll$/, ""),
    graphName,
    isFluidic,
    graphFilterType,
    period,
  });
}

/**
 * Resuelve la interfaz exacta de una alerta sin armar nombres a mano: el detalle
 * de la alarma (getAlarmsProperties) trae "InterfaceName" y "probeID" tal como
 * los espera OpManager. Las alertas de dispositivo (caído, partición, etc.) no lo
 * traen: ahí no hay interfaz que consultar. Sin "entity" se usan los valores dados.
 */
export async function resolveInterface({ entity, eeProbeID, interfaceName }) {
  if (entity) {
    const alarm = (await getAlarmsProperties({ entity }))?.response;
    if (!alarm?.InterfaceName) {
      throw new Error(
        `La alarma "${entity}" no es de una interfaz (OpManager no devuelve InterfaceName, tipo: ${alarm?.EVENTTYPE ?? "desconocido"}): ` +
          "es una alerta de dispositivo, no hay gráficas de interfaz que consultar."
      );
    }
    return { eeProbeID: alarm.probeID, interfaceName: alarm.InterfaceName };
  }

  if (!eeProbeID || !interfaceName) {
    throw new Error('Indica el "entity" de la alerta, o bien "eeProbeID" e "interfaceName".');
  }
  return { eeProbeID, interfaceName };
}

/**
 * Resuelve el dispositivo de una alerta desde el detalle de su alarma: el
 * probeID y el "source" ("{ip}.{probeID}"), que es el único identificador que
 * OpManager acepta como nombre en notas y traceroute (con el nombre para
 * mostrar o la IP el traceroute responde "Unable to resolve target system").
 */
export async function resolveAlarmDevice({ entity }) {
  const alarm = (await getAlarmsProperties({ entity }))?.response;
  if (!alarm?.probeID || !alarm?.source) {
    throw new Error(`OpManager no devolvió el dispositivo de la alarma "${entity}".`);
  }
  return { eeProbeID: alarm.probeID, source: alarm.source, tipo: alarm.EVENTTYPE, severidadActual: alarm.stringseverity };
}

/**
 * El detalle crudo de la alarma trae ~100 campos de interfaz web (iconos, flags
 * de botones, ids internos) y todo el historial de eventos. Se entrega lo que
 * sirve para analizar -- tipo, severidad ACTUAL, dispositivo, interfaz si aplica,
 * quién la reconoció -- y solo los eventos más recientes.
 */
export function compactAlarmProperties(result, maxEvents = 8) {
  const alarm = result?.response;
  if (!alarm || typeof alarm !== "object") return result;

  const events = Array.isArray(alarm.events) ? alarm.events : [];

  return {
    httpCode: result.httpCode,
    alarma: {
      tipo: alarm.EVENTTYPE,
      codigo: alarm.ALARMCODE,
      severidadActual: alarm.stringseverity,
      mensaje: alarm.message,
      dispositivo: alarm.displayName,
      fabricante: alarm.vendorName,
      categoria: alarm.category,
      source: alarm.source,
      probeID: alarm.probeID,
      deviceID: alarm.deviceID,
      interfaz: alarm.InterfaceName ? { interfaceName: alarm.InterfaceName, nombre: alarm.Interfacedisplayname } : null,
      creada: alarm.createTimeStr,
      ultimaModificacion: alarm.modTimeStr,
      reconocidaPor: alarm.who || alarm.owner || null,
      dispositivoDisponible: alarm.isDeviceAvailable,
      suprimida: alarm.isSuppressed,
    },
    totalEventos: events.length,
    eventosRecientes: events.slice(0, maxEvents).map((event) => ({
      hora: event.time,
      severidad: event.severity,
      texto: event.text,
    })),
  };
}

/**
 * getDeviceNotes devuelve, por cada customField, metadatos de formulario
 * (DATATYPE, ISEDITABLE, FIELDLENGTH, ALIASNAME...) que no aportan al análisis
 * y sí mezclan al modelo. Se entrega solo { campo: valor } de los que tienen valor.
 */
export function compactDeviceNotes(result) {
  if (!Array.isArray(result?.response)) return result;

  const campos = {};
  for (const field of result.response) {
    const value = String(field.FIELDVALUE ?? "").trim();
    if (field.FIELDNAME && value) campos[field.FIELDNAME] = value;
  }

  return { httpCode: result.httpCode, campos };
}

/**
 * La respuesta cruda de getInterfaceGraphs pesa ~100 KB (~26.000 tokens): cada
 * serie (Rx/Tx) trae cientos de puntos [timestamp, valor, etiqueta]. El modelo
 * no necesita los puntos sino el resumen, así que se devuelve: lo que ya
 * calcula OpManager (consolidatedValues), estadísticas por serie calculadas
 * sobre TODOS los puntos (así no se pierden picos) y una muestra uniforme
 * pequeña para ver la tendencia.
 */
export function summarizeInterfaceGraphs(result, samplePoints = 12) {
  const data = result?.response;
  if (!data || !Array.isArray(data.graphData)) return result;

  const iso = (timestamp) => new Date(Number(timestamp)).toISOString();

  const series = data.graphData.map((serie) => {
    const points = Array.isArray(serie.data) ? serie.data : [];
    const values = points.map((point) => Number(point[1])).filter(Number.isFinite);
    const summary = { nombre: serie.seriesname, puntos: points.length };

    if (!values.length) return summary;

    const max = Math.max(...values);
    const last = points[points.length - 1];
    const step = Math.max(1, (points.length - 1) / (samplePoints - 1));

    return {
      ...summary,
      desde: iso(points[0][0]),
      hasta: iso(last[0]),
      min: Math.min(...values),
      max,
      pico_en: iso(points[values.indexOf(max)][0]),
      promedio: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
      ultimo: { valor: Number(last[1]), etiqueta: String(last[2] ?? "").trim() },
      muestra: Array.from({ length: Math.min(samplePoints, points.length) }, (_, i) => {
        const point = points[Math.round(i * step)];
        return [iso(point[0]), Number(point[1])];
      }),
    };
  });

  return {
    httpCode: result.httpCode,
    interfaz: data.interfaceDetails,
    grafica: data.displayName,
    unidad: Array.isArray(data.xyTitles) ? data.xyTitles[1] : undefined,
    resumenOpManager: data.consolidatedValues,
    series,
  };
}

/**
 * Traceroute hacia el dispositivo alertado.
 */
export async function getTraceResponse({ deviceName, eeProbeID }) {
  return postToEpistech("getTraceResponse", { deviceName, eeProbeID });
}

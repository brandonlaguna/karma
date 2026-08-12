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
const EPISTECH_BACKEND_URL = process.env.EPISTECH_BACKEND_URL || "http://epistech-backend:4000";

async function postToEpistech(path, body) {
  const url = `${EPISTECH_BACKEND_URL}/api/opmanager/${path}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
export async function getInterfaceGraphs({ eeProbeID, interfaceName, graphName, isFluidic, graphFilterType, period }) {
  return postToEpistech("getInterfaceGraphs", { eeProbeID, interfaceName, graphName, isFluidic, graphFilterType, period });
}

/**
 * graphData puede traer muchos puntos (uno por intervalo de muestreo
 * de OpManager en todo el período pedido) -- eso satura el contexto
 * del modelo sin aportar mucho más que la tendencia. Se reduce a una
 * muestra uniforme (mismo espaciado en el tiempo) en vez de cortar por
 * los primeros N, para no perder picos que hayan pasado a mitad del
 * período.
 */
export function sampleGraphData(graphData, maxPoints = 5) {
  if (!Array.isArray(graphData) || graphData.length <= maxPoints) {
    return graphData;
  }
  const step = (graphData.length - 1) / (maxPoints - 1);
  const sampled = [];
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(graphData[Math.round(i * step)]);
  }
  return sampled;
}

/**
 * Traceroute hacia el dispositivo alertado.
 */
export async function getTraceResponse({ deviceName, eeProbeID }) {
  return postToEpistech("getTraceResponse", { deviceName, eeProbeID });
}

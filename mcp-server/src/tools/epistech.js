/**
 * Cliente hacia los endpoints de eventos/alertas que ya expone
 * EpistechBackend (mismo servidor Docker, red compartida `net_container`
 * -- ver EPISTECH/docker-compose.yml, servicio "backend" / container_name
 * "epistech-backend", con GUION).
 *
 * mcp-server NO le habla directo a la tabla `alerts` -- reusa la ruta que
 * ya existe (EpistechBackend/routes/events.route.js), que es la fuente
 * centralizada de alertas discriminadas por vendor (Zabbix/OpManager/
 * etc), con el estado/historial ya resueltos. Mismo patrón que
 * tools/opmanager.js.
 */
const EPISTECH_BACKEND_URL = process.env.EPISTECH_BACKEND_URL || "http://epistech-backend:4000";

async function getFromEpistech(path) {
  const url = `${EPISTECH_BACKEND_URL}${path}`;

  let res;
  try {
    res = await fetch(url);
  } catch (networkError) {
    // Ver tools/opmanager.js -- mismo motivo para envolver el error acá.
    throw new Error(
      `No se pudo conectar a EpistechBackend en ${url} -- ${networkError.cause?.code || networkError.message}. ` +
        `Verifica que el contenedor "epistech-backend" esté arriba y en la misma red Docker (net_container).`
    );
  }

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`EpistechBackend ${path} respondió ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

/**
 * Trae una alerta por su ID INTERNO (alerts.id -- el autoincremental de
 * Epistech, NO el alert_id del vendor) desde la tabla centralizada
 * `alerts`. Ya viene con vendor_name, status_name/status_color, el
 * historial de transiciones (status_history) y el JSON crudo del vendor
 * (json_result), que trae los identificadores que piden las demás tools
 * (probeid, entity, elementid, source, etc).
 */
export async function getAlertById({ alertId }) {
  const json = await getFromEpistech(`/api/events/getEvent/${alertId}`);
  // El controlador envuelve la respuesta en { response: { event: {...} } }
  // (ver utils/response.js + eventsService.getEventById) -- se devuelve
  // ya desenvuelto para no obligar al modelo a navegar el envoltorio.
  return json?.response?.event ?? json;
}

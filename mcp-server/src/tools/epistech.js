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
import { internalAuthHeaders } from "../auth/internalToken.js";

const EPISTECH_BACKEND_URL = process.env.EPISTECH_BACKEND_URL || "http://epistech-backend:4000";

async function getFromEpistech(path, { timeoutMs } = {}) {
  const url = `${EPISTECH_BACKEND_URL}${path}`;

  let res;
  try {
    res = await fetch(url, {
      headers: internalAuthHeaders(),
      // Sin tope, una consulta lenta a Zabbix dejaría colgado el chat; con tope falla con un error claro.
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (networkError) {
    if (networkError.name === "TimeoutError") {
      throw new Error(`EpistechBackend ${path} no respondió en ${Math.round(timeoutMs / 1000)} s (Zabbix lento o sin respuesta).`);
    }
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

/**
 * Detalle enriquecido de una alerta de ZABBIX (contexto en vivo + histórico del disparador), calculado
 * por EpistechBackend (/api/insights/zabbix/alerts/:id). Recibe el id interno de la alerta (alerts.id).
 */
export async function getZabbixAlertInsight({ alertId, days }) {
  const query = days ? `?days=${encodeURIComponent(days)}` : "";
  const json = await getFromEpistech(`/api/insights/zabbix/alerts/${encodeURIComponent(alertId)}${query}`, { timeoutMs: 45000 });
  return json?.response ?? json;
}

/** Resumen de las alertas activas de Zabbix (por severidad, grupo de equipos y equipo). */
export async function getZabbixActiveOverview({ limit, minSeverity }) {
  const params = new URLSearchParams();
  if (limit != null) params.set("limit", String(limit));
  if (minSeverity != null) params.set("minSeverity", String(minSeverity));
  const query = params.toString() ? `?${params}` : "";
  const json = await getFromEpistech(`/api/insights/zabbix/active${query}`, { timeoutMs: 45000 });
  return json?.response ?? json;
}

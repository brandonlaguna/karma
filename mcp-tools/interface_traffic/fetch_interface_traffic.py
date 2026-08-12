"""
fetch_interface_traffic.py

Recorre una lista de interfaces (probeID + nombre de interfaz) y descarga
su trafico (entrada/salida) desde OpManager, via el endpoint que ya
expone EpistechBackend (/api/opmanager/getInterfaceGraphs) -- el mismo
camino que ya usa el mcp-server de este proyecto (ver
../../mcp-server/src/tools/opmanager.js -> getInterfaceGraphs), asi no se
duplica autenticacion ni se le pega directo a OpManager con otra key.

El campo "interfaceName" que pide la API es justo el campo "name" que ya
trae cada fila de tu consulta a managedobject (ver interfaces_mpls.json /
build_interfaces_from_sql_export.py) -- viene en formato
"IF-{ip}.{probeid}-{moid}" y es el mismo valor que documenta ManageEngine
como "interfaceName" (ver "Referencia oficial" abajo).

Payload confirmado por Victor en Postman contra
/api/opmanager/getInterfaceGraphs (10/ago, ya probado):
    { "interfaceName": "IF-...", "eeProbeID": "...", "graphName": "traffic",
      "isFluidic": true, "graphFilterType": "avg", "period": "Today" }
Esos son los defaults de este script (PERIOD, GRAPH_NAME, GRAPH_FILTER_TYPE,
IS_FLUIDIC), overrideables por interfaz en interfaces.json o por variable
de entorno.

Estructura REAL confirmada (10/ago, con isFluidic=true -- distinta a la
del ejemplo simple de la documentación de ManageEngine, que no usa
isFluidic=true):

    response.graphData = [
      { "seriesname": "Rx Traffic", "data": [[ts_ms, valor, "texto"], ...] },
      { "seriesname": "Tx Traffic", "data": [[ts_ms, valor, "texto"], ...] }
    ]
    response.consolidatedValues = {
      "Rx Traffic": { "avgVal": "213.385  ( 0 % )", "maxVal": "...", "minVal": "...",
                       "95thpercentileValue": "...", "currVal": "...", ... },
      "Tx Traffic": { ... }
    }
    response.suffix = "K"   # multiplicador de los valores crudos (K=x1000, M=x1e6...)
    response.xyTitles = ["Time", "Bits per Second"]

- ts_ms viene en MILISEGUNDOS (no segundos, a diferencia del ejemplo de
  la documentación oficial).
- El valor crudo × el multiplicador de "suffix" = bits por segundo.
- consolidatedValues ya trae el % de utilización sobre la capacidad del
  enlace (el "( N % )" en cada string) -- calculado por OpManager mismo,
  no hace falta que este script lo calcule.

Con esto el script genera:
  1. Crudo completo por interfaz (nada se pierde).
  2. Filas planas de cada punto (interfaz, serie, tipo, timestamp, valor
     en bps) -- para ver la serie completa si hace falta.
  3. Un resumen por interfaz/serie con avg/min/max/95th percentil y %
     de utilización -- pensado para responder rápido "¿qué enlace está
     saturado?" sin abrir miles de puntos.
  4. Si alguna interfaz no trae esta forma (graphName distinto, u otra
     versión de OpManager), la deja aparte en un archivo de estructura
     para revisar a mano -- no asume ciegamente.

Throttling: secuencial + pausa entre peticiones (DELAY_SECONDS) -- esta
misma instancia de OpManager ya se ha saturado antes con pocas peticiones
seguidas, asi que el default es conservador a proposito.

Uso:
    cd ai-lab/mcp-tools/interface_traffic
    python build_interfaces_from_sql_export.py interfaces_mpls.json   # si aun no existe interfaces.json
    pip install -r ../requirements.txt
    python fetch_interface_traffic.py

Variables de entorno opcionales:
    EPISTECH_BACKEND_URL  default "http://localhost:4000"
                           (si corres esto DENTRO de la red de Docker
                           net_container, usa "http://epistech-backend:4000")
    DELAY_SECONDS          default 2 (pausa normal entre interfaces distintas)
    PERIOD                 default "Today" (confirmado en Postman, ver PERIOD_VALIDOS)
    GRAPH_NAME             default "traffic" (obligatorio para OpManager)
    GRAPH_FILTER_TYPE       default "avg" (confirmado en Postman)
    IS_FLUIDIC              default "true" (confirmado en Postman)
    MAX_RETRIES             default 5 -- reintentos por interfaz si la
                            respuesta no es satisfactoria (error de red,
                            HTTP no-2xx, o body con status:false -- ej.
                            "API throttling limit exceeded" de OpManager)
    RETRY_BACKOFF_SECONDS   default 10 -- espera antes del 1er reintento;
                            se duplica en cada intento siguiente (10s,
                            20s, 40s...) hasta RETRY_MAX_BACKOFF_SECONDS
    RETRY_MAX_BACKOFF_SECONDS  default 120
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

# --------------------------------------------------------------------------
# Configuracion
# --------------------------------------------------------------------------

EPISTECH_BACKEND_URL = os.environ.get("EPISTECH_BACKEND_URL", "http://localhost:4000")
DELAY_SECONDS = float(os.environ.get("DELAY_SECONDS", "2"))
# Defaults alineados al payload confirmado por Victor en Postman (10/ago)
# contra /api/opmanager/getInterfaceGraphs -- ya probado, no supuesto.
PERIOD = os.environ.get("PERIOD", "Today")
GRAPH_NAME = os.environ.get("GRAPH_NAME", "traffic")
GRAPH_FILTER_TYPE = os.environ.get("GRAPH_FILTER_TYPE", "avg")
IS_FLUIDIC = os.environ.get("IS_FLUIDIC", "true").lower() != "false"

MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "5"))
RETRY_BACKOFF_SECONDS = float(os.environ.get("RETRY_BACKOFF_SECONDS", "10"))
RETRY_MAX_BACKOFF_SECONDS = float(os.environ.get("RETRY_MAX_BACKOFF_SECONDS", "120"))

# Valores permitidos documentados por ManageEngine (subset mas usado --
# la lista completa esta en el docstring de arriba / README).
PERIOD_VALIDOS = (
    "onehour", "twohours", "fourhours", "sixhours", "eighthours", "twelvehours",
    "twfourhours", "Today", "Yesterday", "Last_7_Days", "Last_30_Days",
    "Last_60_Days", "Last_90_Days", "thisweek", "lastweek", "thismonth", "custom",
)
GRAPH_NAME_VALIDOS = ("traffic", "utilization", "errors", "discardRate", "packets", "errorRate", "totalPackets")

INTERFACES_FILE = Path(__file__).parent / "interfaces.json"
OUTPUT_DIR = Path(__file__).parent.parent / "output"

# Para clasificar series por nombre (Rx Traffic / Tx Traffic confirmado
# con una respuesta real; se deja el resto como respaldo por si graphName
# trae otras series, ej. errores/paquetes).
IN_HINTS = ("rx", "in", "recib", "download", "entrada", "inbound")
OUT_HINTS = ("tx", "out", "envi", "upload", "salida", "outbound")

# Multiplicador para pasar el valor crudo a bits por segundo, segun el
# "suffix" de la respuesta (confirmado con una respuesta real: suffix="K").
SUFFIX_MULTIPLIER = {"": 1, "K": 1_000, "M": 1_000_000, "G": 1_000_000_000, "T": 1_000_000_000_000}

# Extrae numero + unidad opcional + porcentaje opcional de strings tipo
# "213.385  ( 0 % )" o "1.329 K ( 0 % )" (formato de consolidatedValues).
CONSOLIDATED_VALUE_RE = re.compile(r"^\s*([\d.]+)\s*([KMGT]?)\s*(?:\(\s*([\d.]+)\s*%\s*\))?\s*$")


def fetch_interface_traffic(session, ee_probe_id, interface_name, graph_name, period, graph_filter_type, is_fluidic):
    """Llama a EpistechBackend, que a su vez llama a OpManager. Devuelve
    el JSON crudo tal cual responde el backend (envelope estandar de
    Epistech: {..., response: <lo que devolvio OpManager tal cual>})."""
    url = f"{EPISTECH_BACKEND_URL}/api/opmanager/getInterfaceGraphs"
    payload = {
        "eeProbeID": ee_probe_id,
        "interfaceName": interface_name,
        "period": period,
        "graphName": graph_name,
        "graphFilterType": graph_filter_type,
        "isFluidic": is_fluidic,
    }

    resp = session.post(url, json=payload, timeout=30)
    resp.raise_for_status()
    body = resp.json()

    # EpistechBackend responde 200 con {status:false, ...} en algunos
    # casos (ver utils/response.js) -- no solo con HTTP no-2xx. Se trata
    # igual que un error para que el retry lo agarre.
    if isinstance(body, dict) and body.get("status") is False:
        raise RuntimeError(f"Backend respondió status:false -- {body.get('message') or body}")

    return body


def fetch_with_retries(session, **kwargs):
    """Reintenta con backoff exponencial (10s, 20s, 40s...) -- pensado
    para el error real que reporta Victor: "demasiadas peticiones" /
    throttling de OpManager, que se resuelve solo esperando."""
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fetch_interface_traffic(session, **kwargs)
        except Exception as e:
            last_error = e
            is_last_attempt = attempt == MAX_RETRIES
            print(f"  intento {attempt}/{MAX_RETRIES} falló: {e}")
            if not is_last_attempt:
                wait = min(RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1)), RETRY_MAX_BACKOFF_SECONDS)
                print(f"  reintentando en {wait:.0f}s...")
                time.sleep(wait)

    raise last_error


def classify_series(series_name):
    low = series_name.lower()
    if any(h in low for h in IN_HINTS):
        return "entrada"
    if any(h in low for h in OUT_HINTS):
        return "salida"
    return "otro"


def get_graph_data_series(body):
    """Forma REAL confirmada: response.graphData es una lista de
    {seriesname, data: [[ts_ms, valor, texto], ...]}."""
    graph_data = body.get("graphData") if isinstance(body, dict) else None
    if not isinstance(graph_data, list):
        return None
    series = {}
    for entry in graph_data:
        if isinstance(entry, dict) and "seriesname" in entry and isinstance(entry.get("data"), list):
            series[entry["seriesname"]] = entry["data"]
    return series or None


def get_xy_object_series(body):
    """Respaldo: forma de ejemplo de la documentación oficial (sin
    isFluidic=true), series como llaves de primer nivel con lista de
    {x, y}. Se deja por si algun graphName/period distinto la trae así."""
    if not isinstance(body, dict):
        return None
    series = {}
    for key, value in body.items():
        if isinstance(value, list) and value and isinstance(value[0], dict) and "x" in value[0] and "y" in value[0]:
            series[key] = [[p.get("x"), p.get("y"), None] for p in value]
    return series or None


def flatten_interface(label, response_body, multiplier):
    """Convierte la respuesta de una interfaz en filas planas:
    interfaz, serie, tipo (entrada/salida/otro), timestamp, valor en bps.
    Lista para exportar a xlsx. Soporta las dos formas de respuesta
    vistas (graphData real, y el respaldo {x,y})."""
    rows = []
    series = get_graph_data_series(response_body) or get_xy_object_series(response_body)
    if not series:
        return rows

    for serie_name, points in series.items():
        tipo = classify_series(serie_name)
        for point in points:
            ts_raw, valor_crudo = point[0], point[1]
            try:
                # ts viene en milisegundos (confirmado con respuesta real)
                ts_iso = datetime.fromtimestamp(int(ts_raw) / 1000, tz=timezone.utc).isoformat()
            except (TypeError, ValueError, OSError):
                ts_iso = None
            valor_bps = valor_crudo * multiplier if isinstance(valor_crudo, (int, float)) else None
            rows.append(
                {
                    "interfaz": label,
                    "serie": serie_name,
                    "tipo": tipo,
                    "timestamp_ms": ts_raw,
                    "timestamp_utc": ts_iso,
                    "valor_crudo": valor_crudo,
                    "valor_bps": valor_bps,
                }
            )
    return rows


def parse_consolidated_value(text):
    """'213.385  ( 0 % )' o '1.329 K ( 0 % )' -> {valor, unidad, valor_bps, porcentaje}.
    Cada valor de consolidatedValues trae su propia unidad (a veces "K",
    a veces ninguna) independiente del "suffix" global de graphData --
    se normaliza a bps acá para poder comparar enlaces entre sí."""
    if not isinstance(text, str):
        return {"valor": None, "unidad": None, "valor_bps": None, "porcentaje": None}
    m = CONSOLIDATED_VALUE_RE.match(text)
    if not m:
        return {"valor": None, "unidad": None, "valor_bps": None, "porcentaje": None, "texto_original": text}
    valor_str, unidad, porcentaje = m.groups()
    valor = float(valor_str) if valor_str else None
    unidad = unidad or None
    valor_bps = valor * SUFFIX_MULTIPLIER.get(unidad or "", 1) if valor is not None else None
    return {
        "valor": valor,
        "unidad": unidad,
        "valor_bps": valor_bps,
        "porcentaje": float(porcentaje) if porcentaje else None,
    }


def summarize_interface(label, response_body):
    """De consolidatedValues (ya calculado por OpManager) arma una fila
    por interfaz/serie con avg/min/max/95th percentil y % de utilización
    -- pensado para ver rápido qué enlace está saturado sin abrir el
    detalle punto por punto."""
    rows = []
    consolidated = response_body.get("consolidatedValues") if isinstance(response_body, dict) else None
    if not isinstance(consolidated, dict):
        return rows

    for serie_name, values in consolidated.items():
        if not isinstance(values, dict):
            continue
        rows.append(
            {
                "interfaz": label,
                "serie": serie_name,
                "tipo": classify_series(serie_name),
                "actual": parse_consolidated_value(values.get("currVal")),
                "promedio": parse_consolidated_value(values.get("avgVal")),
                "minimo": parse_consolidated_value(values.get("minVal")),
                "maximo": parse_consolidated_value(values.get("maxVal")),
                "percentil_95": parse_consolidated_value(values.get("95thpercentileValue")),
            }
        )
    return rows


def main():
    if not INTERFACES_FILE.exists():
        print(f"No existe {INTERFACES_FILE}.")
        print("Corre build_interfaces_from_sql_export.py sobre tu export, o copia interfaces.example.json.")
        sys.exit(1)

    interfaces = json.loads(INTERFACES_FILE.read_text(encoding="utf-8"))
    if not interfaces:
        print("interfaces.json esta vacio -- agrega al menos una interfaz.")
        sys.exit(1)

    if PERIOD not in PERIOD_VALIDOS:
        print(f"Aviso: PERIOD='{PERIOD}' no está en la lista de valores documentados por ManageEngine, revisa el README.")
    if GRAPH_NAME not in GRAPH_NAME_VALIDOS:
        print(f"Aviso: GRAPH_NAME='{GRAPH_NAME}' no está en la lista de valores documentados por ManageEngine, revisa el README.")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    raw_out_path = OUTPUT_DIR / f"interface_traffic_raw_{timestamp}.json"
    flat_out_path = OUTPUT_DIR / f"interface_traffic_flat_{timestamp}.json"
    summary_out_path = OUTPUT_DIR / f"interface_traffic_summary_{timestamp}.json"
    structure_out_path = OUTPUT_DIR / f"interface_traffic_structure_{timestamp}.json"

    session = requests.Session()
    results = {}
    errors = []
    flat_rows = []
    summary_rows = []
    unmatched_structure = None

    print(
        f"Backend: {EPISTECH_BACKEND_URL}  |  Periodo: {PERIOD}  |  Grafica: {GRAPH_NAME}  |  "
        f"Filtro: {GRAPH_FILTER_TYPE}  |  isFluidic: {IS_FLUIDIC}  |  Pausa: {DELAY_SECONDS}s"
    )
    print(f"Interfaces a consultar: {len(interfaces)}\n")

    for i, iface in enumerate(interfaces, start=1):
        label = iface.get("label") or iface.get("interfaceName")
        print(f"[{i}/{len(interfaces)}] pidiendo {label} ...")

        try:
            raw = fetch_with_retries(
                session,
                ee_probe_id=iface["eeProbeID"],
                interface_name=iface["interfaceName"],
                graph_name=iface.get("graphName") or GRAPH_NAME,
                period=iface.get("period") or PERIOD,
                graph_filter_type=iface.get("graphFilterType") or GRAPH_FILTER_TYPE,
                is_fluidic=iface["isFluidic"] if iface.get("isFluidic") is not None else IS_FLUIDIC,
            )
            results[label] = raw

            body = raw.get("response") or {}
            suffix = body.get("suffix", "") if isinstance(body, dict) else ""
            multiplier = SUFFIX_MULTIPLIER.get(suffix, 1)

            rows = flatten_interface(label, body, multiplier)
            summary_rows.extend(summarize_interface(label, body))

            if rows:
                flat_rows.extend(rows)
            elif unmatched_structure is None:
                unmatched_structure = {
                    "interfaz": label,
                    "nota": "No se encontraron series reconocibles (ni graphData ni {x,y}) -- revisar a mano.",
                    "top_level_keys": list(body.keys()) if isinstance(body, dict) else None,
                    "response_sample": body,
                }
                print("  aviso: no se detectaron series reconocibles, se guardó en el archivo de estructura")

        except Exception as e:
            print(f"  ERROR con {label} (tras {MAX_RETRIES} intentos): {e}")
            errors.append({"interface": label, "error": str(e)})

        if i < len(interfaces):
            time.sleep(DELAY_SECONDS)

    raw_out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"\nGuardado (crudo, todas las interfaces): {raw_out_path}")

    if flat_rows:
        flat_out_path.write_text(json.dumps(flat_rows, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        print(f"Guardado (filas planas, listo para xlsx): {flat_out_path}  ({len(flat_rows)} filas)")
    else:
        print("No se generaron filas planas -- revisa el archivo de estructura y/o los errores.")

    if summary_rows:
        summary_out_path.write_text(json.dumps(summary_rows, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        print(f"Guardado (resumen avg/min/max/95th + % utilización): {summary_out_path}  ({len(summary_rows)} filas)")

    if unmatched_structure:
        structure_out_path.write_text(
            json.dumps(unmatched_structure, indent=2, ensure_ascii=False, default=str), encoding="utf-8"
        )
        print(f"Guardado (estructura sin reconocer, para revisar): {structure_out_path}")

    if errors:
        print(f"\n{len(errors)} interfaz(es) con error:")
        for e in errors:
            print(f"  - {e['interface']}: {e['error']}")


if __name__ == "__main__":
    main()

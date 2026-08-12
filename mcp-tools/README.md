# mcp-tools

Scripts sueltos (Python, por ahora) de apoyo operativo -- no son parte del
protocolo MCP en sí (eso vive en `../mcp-server`), son herramientas que
consumen los mismos endpoints de EpistechBackend para tareas puntuales
que no ameritan una tool de chatbot. Pensado para crecer: cada
herramienta en su propia carpeta.

## interface_traffic/ -- tráfico de interfaces (subida/bajada)

Motivo: validar saturación de enlaces hacia Bogotá (pedido de Martin,
10/ago). Descarga el tráfico de una lista de interfaces vía
`EpistechBackend /api/opmanager/getInterfaceGraphs` (mismo endpoint que ya
usa `mcp-server/src/tools/opmanager.js`), lo guarda en JSON crudo **y** en
filas planas listas para xlsx.

### Referencia oficial confirmada (ManageEngine, no es un supuesto)

Se revisó la documentación oficial de OpManager
(`help/restapi/interfaces.html`, sección `getInterfaceGraphs`) el 10/ago
porque el código de este repo no tenía un ejemplo real guardado. Esto
corrige varios supuestos que traía el mcp-server:

- `interfaceName` es el nombre real del parámetro (STRING, obligatorio) --
  es justo el campo `name` que trae cada fila de tu consulta a
  `managedobject` (formato `IF-{ip}.{probeid}-{moid}`).
- `graphName` es **obligatorio** (antes se mandaba vacío). Valores
  válidos: `traffic`, `utilization`, `errors`, `discardRate`, `packets`,
  `errorRate`, `totalPackets`. Este script usa `traffic` por defecto.
- `period` es obligatorio y **`"Last1Hour"` no es un valor válido**
  (error que traía la config anterior). Valores válidos más usados:
  `onehour`, `twohours`, `fourhours`, `sixhours`, `Today`, `Yesterday`,
  `Last_7_Days`, `Last_30_Days`, `thisweek`, `lastweek`, `thismonth`,
  `custom` (con `startDate`/`endDate`). Default de este script: `onehour`.
- La respuesta, para `graphName=traffic`, **no** trae un campo
  `"graphData"` (el mcp-server sí asume eso, sin haberlo probado nunca
  con éxito según el historial de esta conversación) -- trae directo dos
  llaves de primer nivel: `"Rx Traffic"` y `"Tx Traffic"`, cada una un
  array de puntos `{"x": <unix epoch en segundos>, "y": <valor>}`. **Rx =
  recibido = entrada/bajada. Tx = transmitido = salida/subida.**
- Rate limit documentado por ManageEngine para este endpoint: 100
  peticiones/minuto (el `DELAY_SECONDS` de este script es mucho más
  conservador que eso a propósito, porque esta instancia en particular ya
  se ha saturado con menos).

### Cómo conseguir `eeProbeID` / `interfaceName` por interfaz

Ya lo resolviste vía SQL directo a `managedobject` en la BD de OpManager
(ver `interfaces_mpls.json`) -- de cada fila:
- `probeid` -> `eeProbeID`
- `name` -> `interfaceName` (ya viene en el formato correcto)
- `displayname` -> label/identificador legible

Usa `build_interfaces_from_sql_export.py` para convertir ese export
directo al `interfaces.json` que espera `fetch_interface_traffic.py`.

### Uso

```bash
cd mcp-tools/interface_traffic
python build_interfaces_from_sql_export.py interfaces_mpls.json   # o el export que tengas
pip install -r ../requirements.txt
python fetch_interface_traffic.py
```

Por defecto asume `EPISTECH_BACKEND_URL=http://localhost:4000` (corriendo
el script directo en tu máquina, fuera de Docker -- el puerto 4000 ya
está mapeado en `EPISTECH/docker-compose.yml`). Si lo corres dentro de la
red `net_container`, exporta `EPISTECH_BACKEND_URL=http://epistech-backend:4000`
antes.

Salida en `mcp-tools/output/` (gitignored):
- `interface_traffic_raw_<timestamp>.json` -- respuesta completa de OpManager por interfaz, sin tocar.
- `interface_traffic_flat_<timestamp>.json` -- un punto por fila (`interfaz, serie, tipo [entrada/salida], timestamp_ms, timestamp_utc, valor_crudo, valor_bps`), toda la serie completa.
- `interface_traffic_summary_<timestamp>.json` -- una fila por interfaz/serie con actual/promedio/mínimo/máximo/percentil 95 **y % de utilización** (ya calculado por OpManager) -- normalizado a bps para poder comparar enlaces entre sí. Este es el archivo para responder rápido "¿qué enlace está saturado?".
- `interface_traffic_structure_<timestamp>.json` -- solo aparece si alguna interfaz no trajo ninguna de las dos formas de respuesta reconocidas, para revisar a mano.

### Estructura real confirmada (10/ago, con isFluidic=true)

```
response.graphData = [
  { "seriesname": "Rx Traffic", "data": [[ts_ms, valor, "texto"], ...] },
  { "seriesname": "Tx Traffic", "data": [[ts_ms, valor, "texto"], ...] }
]
response.consolidatedValues = { "Rx Traffic": {avgVal, minVal, maxVal, currVal, "95thpercentileValue", ...}, "Tx Traffic": {...} }
response.suffix = "K"   # multiplicador de graphData (K=x1000, M=x1e6...)
```
`ts_ms` viene en milisegundos. Rx = recibido = entrada/bajada. Tx = transmitido = salida/subida. Esta forma (con `graphData` como lista de series) es distinta al ejemplo simple de la documentación oficial de ManageEngine, que no usa `isFluidic=true`.

### Nota sobre throttling

Este script pega secuencial con pausa (`DELAY_SECONDS`, default 2s) --
esta instancia de OpManager ya se ha saturado antes con pocas peticiones
seguidas (ver conversación sobre `COMMUTATION_SWITCHING_ENABLED` en
Epistech). Si son muchas interfaces, súbelo antes que bajarlo.

Además, cada interfaz reintenta sola si la respuesta no es satisfactoria
(error de red, HTTP no-2xx, o `status:false` del backend -- incluye el
"demasiadas peticiones"/throttling de OpManager): backoff exponencial,
`MAX_RETRIES` intentos (default 5), esperando `RETRY_BACKOFF_SECONDS`
(default 10s) y duplicando cada vez hasta `RETRY_MAX_BACKOFF_SECONDS`
(default 120s). Si sigue fallando después de agotar los reintentos, esa
interfaz queda registrada en la lista de errores al final, pero el script
sigue con las demás.

### Alternativa a futuro: leer directo de la BD de OpManager

`EpistechBackend` ya tiene una conexión de solo lectura a la base nativa
de OpManager (Postgres, `CentralDB` -- ver `config/knex.opmanager.js` /
`repositories/opmanager/opmanager.device.repository.js`, hoy usada para
`managedobject`, `topoobject`, `customfieldsfordevices`, etc., no para
tráfico). Si el volumen de interfaces crece, probablemente sea más rápido
y no dependa del rate limit de la API -- pero no tengo confirmado el
nombre de la tabla donde OpManager guarda las muestras de tráfico por
interfaz en este schema. Si esto se vuelve recurrente, vale la pena
explorar `information_schema.tables` en esa conexión para encontrarla, en
vez de seguir por la API.

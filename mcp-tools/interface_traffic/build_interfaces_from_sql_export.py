"""
build_interfaces_from_sql_export.py

Convierte el JSON que exporta tu cliente de BD (pgAdmin/DBeaver/etc.) al
correr una consulta contra `managedobject` en la base de OpManager, al
formato que espera `fetch_interface_traffic.py` (interfaces.json).

Pensado para el flujo real que ya usaste: consultar managedobject por
displayname y pegar el resultado tal cual -- el exportador mete el texto
del SQL como si fuera una llave del objeto (ver interfaces_mpls.json),
así que este script no asume el nombre de esa llave, busca el primer
valor que sea una lista de filas.

De cada fila toma:
    name         -> interfaceName  (ya viene en formato IF-{ip}.{probeid}-{moid})
    probeid      -> eeProbeID
    displayname  -> label (para identificar el enlace en los reportes)

Uso:
    python build_interfaces_from_sql_export.py interfaces_mpls.json
    # escribe/actualiza interfaces.json en la misma carpeta

    python build_interfaces_from_sql_export.py interfaces_mpls.json otro_output.json
    # si quieres un archivo de salida distinto (no pisar interfaces.json)
"""

import json
import sys
from pathlib import Path


def extract_rows(raw):
    """El export mete el SQL como llave y el array real como valor --
    a veces con una sola llave "rara", a veces ya viene como lista
    directa. Soporta ambos casos."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for value in raw.values():
            if isinstance(value, list):
                return value
    raise ValueError("No se encontró un array de filas dentro del JSON exportado.")


def main():
    if len(sys.argv) < 2:
        print("Uso: python build_interfaces_from_sql_export.py <archivo_exportado.json> [salida.json]")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).parent / "interfaces.json"

    raw = json.loads(input_path.read_text(encoding="utf-8"))
    rows = extract_rows(raw)

    interfaces = []
    skipped = []
    for row in rows:
        name = row.get("name")
        probeid = row.get("probeid")
        displayname = row.get("displayname")

        if not name or probeid is None:
            skipped.append(displayname or row)
            continue

        interfaces.append(
            {
                "label": displayname or name,
                "eeProbeID": str(probeid),
                "interfaceName": name,
                "graphName": "traffic",  # obligatorio para OpManager -- ver README
                "graphFilterType": None,
                "isFluidic": None,
            }
        )

    output_path.write_text(json.dumps(interfaces, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"{len(interfaces)} interfaz(es) escritas en {output_path}")
    if skipped:
        print(f"\n{len(skipped)} fila(s) sin 'name' o 'probeid', omitidas:")
        for s in skipped:
            print(f"  - {s}")


if __name__ == "__main__":
    main()

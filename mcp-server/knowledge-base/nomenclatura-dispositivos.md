# Nomenclatura de nombres de dispositivos e interfaces (NOC)

Este documento explica cómo decodificar el nombre de un dispositivo o
interfaz cuando el customField de OpManager (`get_device_notes`) no
está completo. Úsalo como último recurso -- primero intenta
`get_device_notes` (customFields reales) y `search_device_inventory`
(catálogo propio); solo si ninguno de los dos trae el dato, decodifica
el nombre con las reglas de acá.

## Estructura del nombre de un dispositivo

Formato general:

```
{PAIS}{CIUDAD}-{SEDE}-{GRUPO}{TIPO}{SERVICIO}_{IP o URL}
```

Ejemplo real: `PERLIM-STACATALINA-NETSWCOR_10.222.79.5`

- `PER` = país (3 letras, acrónimo mundial: COL, USA, PER, CHI...)
- `LIM` = ciudad (3 letras: BOG, MED, LIM...)
- `STACATALINA` = sede/ubicación (hasta 12 letras)
- `NET` = grupo de soporte / a quién reportar (3 letras)
- `SW` = tipo de dispositivo (2 letras)
- `COR` = servicio monitoreado (2-3 letras)
- `10.222.79.5` = IP de gestión o URL

**Importante:** el grupo de soporte + tipo + servicio van PEGADOS sin
separador (`NETSWCOR` = `NET` + `SW` + `COR`), así que no siempre es
obvio dónde corta cada segmento sin conocer los códigos. Cuando haya
duda, es más confiable buscar el nombre completo en
`search_device_inventory` o preguntar directamente en vez de adivinar
los cortes.

## Códigos conocidos

### País (3 letras, nombre de dispositivo) / código de país (Grupo Resolutor)

El nombre del dispositivo usa un acrónimo de 3 letras; el customField
"Grupo Resolutor" de OpManager usa un prefijo corto de país que NO
siempre coincide en longitud. Países con datos reales confirmados:

| País     | Prefijo en nombre de dispositivo | Prefijo en Grupo Resolutor |
| -------- | -------------------------------- | -------------------------- |
| Colombia | `COL`                            | `CO`                       |
| Perú     | `PER`                            | `PE`                       |
| Chile    | (sin ejemplo aún)                | `CL`                       |
| México   | (sin ejemplo aún)                | `MX`                       |

**Caso especial sin resolver:** existen sondas con Grupo Resolutor como
`SERVIDORES usns`, `REDES usns`, etc. -- "usns" parece ser una unidad
de negocio (posiblemente "Nearshore USA"), no un país con código ISO
estándar. El valor real en el customField para esas sondas NO trae el
indicativo de país como el resto (`{país}-{área}`), rompe el patrón.
No usar hasta confirmar el valor exacto.

### Ciudad (3 letras)

- `BOG` = Bogotá
- `MED` = Medellín
- `LIM` = Lima
  (lista abierta, agregar según aparezcan)

### Grupo de soporte / a quién reportar (3 letras)

- `NET` = Redes (equivale a `Grupo Resolutor: CO-REDES` en OpManager)
- `SER` = Servidores (equivale a `CO-SERVIDORES`)
- `TEL` = Telefonía (equivale a `CO-TELEFONIA`)
- `BDD` = Bases de Datos (equivale a `CO-BASESDEDATOS`)
- `DES` = Desarrollo (equivale a `CO-DESARROLLO`)
- `GRA` = Grabadores/Grabadoras -- **sin confirmar** (visto en un
  ejemplo pero Karma no lo marcó como confirmado)
- `DAC` = Directorio Activo -- **sin confirmar**, mismo caso que `GRA`

### Tipo de dispositivo (2 letras)

- `SW` = Switch (confirmado)
- `FW` = Firewall (confirmado, visto en inventario real)
- `RO` = Router (confirmado)
- `SR` = Servidor (confirmado)
- `AP` = Access Point -- propuesto, **sin dispositivos reales
  todavía** que lo confirmen
- `UP` = UPS -- propuesto, **sin dispositivos reales todavía**
- `CT` = Central telefónica / PBX -- propuesto, **sin dispositivos
  reales todavía**

### Principal / Backup

- `PPL` = Principal
- `BCK` = Backup

Este dato es clave para el algoritmo de detección de conmutaciones
(cuando un enlace principal cae y se activa el backup, o viceversa) --
si el nombre trae `PPL` o `BCK`, es información directamente relevante
para ese análisis, no solo para el enrutamiento a la matriz RACI.

### Servicio (2-3 letras, ejemplos vistos en inventario real)

- `COR` = Core
- `SEG` = Segmentación
- `PER` = Perimetral
- (lista abierta)

## Estructura del nombre de una interfaz

Formato general (según ejemplo real):

```
{IP}-{GRUPO}-{INTERFAZ}.{PROVEEDOR}-{SEDE_ORIGEN}_{SEDE_DESTINO}-{TIPO_ENLACE}_{CAPACIDAD}
```

Ejemplo real: `10.222.79.5-NET-IF1.0.1_ON-SANTACATALINA-ATE_FO1-40G`

- `10.222.79.5` = IP de gestión
- `NET` = grupo de soporte
- `IF1.0.1` = identificador de interfaz
- `ON` = proveedor (ej. CLARO / ON / MARCATEL)
- `SANTACATALINA` = sede origen (hasta 12 letras)
- `ATE` = sede destino (hasta 12 letras)
- `FO1` = tipo de enlace (L2L / MPLS / Internet / SIPTRUNK...)
- `40G` = capacidad del enlace

## Nota sobre confiabilidad

Los códigos marcados como "sin confirmar" son inferencias razonables,
no datos verificados por el equipo de Epistech. Si necesitas certeza
para tomar una decisión de escalamiento, prefiere `get_device_notes`
(customFields reales) o `search_device_inventory` (catálogo propio)
antes que decodificar el nombre a ciegas.

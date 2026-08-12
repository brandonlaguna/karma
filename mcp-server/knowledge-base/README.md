# Base de conocimiento del NOC

Cualquier archivo `.md`, `.txt` o `.pdf` que pongas en esta carpeta se puede
cargar a Qdrant para que el asistente lo busque por similitud semántica (no
texto exacto -- puede responder aunque la pregunta no use las mismas
palabras del documento).

**PDFs**: se les extrae el texto automáticamente (vía `pdf-parse`) antes de
partirlos en chunks. Solo funciona con PDFs que tengan una capa de texto
real (exportados desde Word, GLPI, etc.) -- un PDF escaneado como imagen
pura no trae texto que extraer, así que quedaría vacío o casi vacío. Si
tienes PDFs escaneados, avisa para armar un paso de OCR aparte.

## Cómo cargar/actualizar la base

```
docker exec -it ai_mcp_server pnpm run ingest
```

Corre cada vez que agregues o edites un documento acá. Reingestar un
archivo REEMPLAZA su contenido en Qdrant (no se duplica) -- podés
correrlo las veces que quieras después de editar algo.

Para reingestar solo un archivo puntual (más rápido que reprocesar toda
la carpeta):

```
docker exec -it ai_mcp_server pnpm run ingest -- nombre-archivo.md
```

## Qué tipo de contenido va acá

- Políticas y procedimientos ITIL del NOC.
- Matriz de escalamiento (a quién avisar según severidad/área).
- Contactos (nombre, rol, teléfono, área) -- aunque para esto
  probablemente termine siendo mejor una tabla en Postgres que texto
  libre, ya que es data estructurada. Por ahora, mientras se define eso,
  puede vivir acá también.
- Cualquier procedimiento operativo que hoy solo esté en la cabeza de
  alguien del equipo.

## Formato -- cómo estructurar para que la búsqueda funcione bien

**Para .md: un encabezado por tema.** El ingest parte los `.md` por
encabezados (`#`, `##`, `###`...), no por cantidad de caracteres -- cada
sección se convierte en su propio chunk, autocontenido, con el título
como parte de lo que se embebe. Eso significa:

- Un `##` = un tema/procedimiento/contacto puntual. No mezcles dos temas
  bajo el mismo encabezado.
- Usa títulos descriptivos ("Nivel 2 -- Escalamiento de red", no
  "Sección 2") -- el título mejora la búsqueda tanto como el cuerpo.
- Si una sección queda muy larga (más de ~800 caracteres), el ingest la
  subdivide automáticamente conservando el título en cada pedazo -- no
  hace falta que la cortes vos a mano, pero si notás que un tema se
  puede separar en dos encabezados más chicos, mejor: chunks más
  enfocados buscan mejor que uno gigante con todo mezclado.
- Ver `ejemplo-escalamiento.md` en esta misma carpeta como referencia de
  estructura.

**Para .txt y .pdf**: no hay encabezados confiables que el ingest pueda
aprovechar (un PDF pierde el formato al extraerle el texto), así que se
particionan por cantidad de caracteres a ciegas. Si un PDF es largo y
te importa la precisión de búsqueda, lo mejor es pasarlo a `.md` a mano,
organizado por secciones como se describe arriba, en vez de dejarlo
como PDF crudo.

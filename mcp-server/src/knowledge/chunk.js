/**
 * Chunker de texto simple, sin dependencias externas (a propósito --
 * no vale la pena sumar todo "langchain" solo para partir texto en
 * pedazos). Corta por cantidad de caracteres con solapamiento, no por
 * tokens reales -- suficiente para documentos de políticas/contactos,
 * que no son tan largos ni necesitan precisión de tokenizer.
 */
const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_OVERLAP = 100;

export function chunkText(text, { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP } = {}) {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    const end = Math.min(start + chunkSize, clean.length);
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end === clean.length) break;
    start = end - overlap;
  }

  return chunks;
}

/**
 * Chunker consciente de la estructura de un markdown -- parte por
 * encabezados (#, ##, ###...) en vez de por cantidad de caracteres a
 * ciegas. Cada sección queda como un chunk propio (o varios, si es más
 * larga que chunkSize -- ahí cae al chunker por caracteres de arriba,
 * pero conservando el encabezado como prefijo en cada pedazo).
 *
 * Por qué importa: con el chunker por caracteres, un corte puede caer a
 * mitad de una idea y mezclar el final de una sección con el arranque
 * de la siguiente -- ahí la búsqueda semántica devuelve fragmentos que
 * no responden nada completo. Partiendo por encabezado, cada chunk es
 * autocontenido (un tema = un chunk) y además lleva su título como
 * parte del texto embebido, lo que ayuda a la búsqueda a matchear aunque
 * la pregunta use palabras distintas a las del cuerpo del texto.
 *
 * Devuelve [{ heading, text }] -- "heading" es la ruta completa de
 * encabezados (ej. "Escalamiento de incidentes > Nivel 2 --
 * Escalamiento"), útil como metadata en el payload de Qdrant para que
 * el modelo sepa de qué sección salió cada resultado.
 */
export function chunkMarkdownBySections(text, { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP } = {}) {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const lines = clean.split("\n");
  const HEADING_RE = /^(#{1,6})\s+(.+)$/;

  // Agrupa líneas en secciones -- cada una arranca en un heading (o, si
  // el documento no tiene ningún heading, todo el archivo es una sola
  // "sección" sin título).
  const sections = [];
  let current = { levels: [], body: [] };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      if (current.body.length || current.levels.length) sections.push(current);
      const level = match[1].length;
      const title = match[2].trim();
      // Mantiene la ruta de encabezados hasta el nivel actual (ej. si
      // venía de un "##" y ahora hay otro "##" del mismo nivel, se
      // reemplaza; si es un "###" hijo, se anida).
      const parentPath = current.levels.filter((h) => h.level < level);
      current = { levels: [...parentPath, { level, title }], body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length || current.levels.length) sections.push(current);

  const chunks = [];

  for (const section of sections) {
    const heading = section.levels.map((h) => h.title).join(" > ");
    const body = section.body.join("\n").trim();
    if (!body) continue;

    const withHeading = heading ? `${heading}\n\n${body}` : body;

    if (withHeading.length <= chunkSize) {
      chunks.push({ heading, text: withHeading });
    } else {
      // Sección larga -- se subdivide por caracteres, pero cada pedazo
      // conserva el heading como prefijo para no perder el contexto.
      const pieces = chunkText(body, { chunkSize, overlap });
      for (const piece of pieces) {
        chunks.push({ heading, text: heading ? `${heading}\n\n${piece}` : piece });
      }
    }
  }

  return chunks;
}

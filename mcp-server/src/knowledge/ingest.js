/**
 * Script de ingesta manual -- NO corre como parte del servicio, se
 * ejecuta a mano cada vez que se agregan/actualizan documentos en
 * knowledge-base/. Lee todos los .md/.txt/.pdf de esa carpeta, los
 * parte en chunks, los embebe con Ollama, y los sube a Qdrant.
 *
 * Cómo correrlo:
 *   docker exec -it ai_mcp_server pnpm run ingest
 *
 * Para reingestar SOLO un archivo (ej. acabas de editar uno y no
 * quieres esperar a que se reprocesen todos):
 *   docker exec -it ai_mcp_server pnpm run ingest -- nombre-archivo.md
 *
 * Idempotente de verdad: antes de subir los chunks frescos de un
 * archivo, se borran los que ya existían de ESE mismo archivo en Qdrant
 * (ver deleteBySource en qdrant.js) -- reingestar un documento editado
 * REEMPLAZA su contenido, no lo acumula.
 *
 * Chunking:
 * - .md -> consciente de encabezados (chunkMarkdownBySections): cada
 *   sección ("##", "###", etc.) es su propio chunk autocontenido, con
 *   el título como parte del texto embebido. Da mejores resultados de
 *   búsqueda que partir a ciegas por cantidad de caracteres, porque no
 *   mezcla el final de un tema con el inicio del siguiente. Para que
 *   esto funcione bien, estructura tus .md con un encabezado por tema
 *   (ver knowledge-base/README.md).
 * - .txt / .pdf -> chunker simple por caracteres (chunkText). El texto
 *   extraído de un PDF pierde el formato de encabezados, así que no hay
 *   estructura confiable de la que partir -- si un PDF es largo y te
 *   importa la precisión de búsqueda, conviene pasarlo a .md a mano,
 *   organizado por secciones, en vez de dejarlo como PDF crudo.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pdfParse from "pdf-parse";
import { embedText } from "./embeddings.js";
import { chunkText, chunkMarkdownBySections } from "./chunk.js";
import { upsertChunks, deleteBySource } from "./qdrant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.resolve(__dirname, "../../knowledge-base");

const SUPPORTED_EXTENSIONS = [".md", ".txt", ".pdf"];

// Archivos de la propia carpeta que son documentación del mecanismo de
// ingesta (instrucciones de "cómo cargar la base"), no contenido real
// del NOC -- si se cargan, contaminan la búsqueda semántica (ej. el
// modelo podría devolver "corre pnpm run ingest" como respuesta a una
// pregunta operativa). Se excluyen del readdir Y se limpia cualquier
// resto que haya quedado cargado de una corrida anterior.
const EXCLUDED_FILES = ["README.md"];

// Extrae el texto plano de un archivo según su extensión -- PDFs pasan
// por pdf-parse (solo texto real: un PDF escaneado como imagen, sin
// capa de texto, va a devolver poco o nada; para esos hace falta OCR
// aparte, no lo cubre este script).
async function extractText(fullPath) {
  if (fullPath.endsWith(".pdf")) {
    const buffer = await readFile(fullPath);
    const { text } = await pdfParse(buffer);
    return text;
  }
  return readFile(fullPath, "utf-8");
}

// Devuelve [{ heading, text }] -- .md usa el chunker consciente de
// encabezados, todo lo demás cae al chunker simple por caracteres (sin
// heading, queda "").
function chunkFile(fileName, raw) {
  if (fileName.endsWith(".md")) {
    return chunkMarkdownBySections(raw);
  }
  return chunkText(raw).map((text) => ({ heading: "", text }));
}

async function main() {
  // Filtro opcional por argumento (ej. "pnpm run ingest -- foo.md") --
  // reingesta solo ese archivo en vez de la carpeta completa.
  const onlyFile = process.argv[2];

  let files;
  try {
    files = (await readdir(KNOWLEDGE_DIR)).filter(
      (f) => SUPPORTED_EXTENSIONS.some((ext) => f.endsWith(ext)) && !EXCLUDED_FILES.includes(f)
    );
  } catch (error) {
    console.error(`No se pudo leer ${KNOWLEDGE_DIR}:`, error.message);
    process.exit(1);
  }

  // Limpieza: si alguno de estos quedó cargado de una corrida anterior
  // (antes de excluirlos), se borra igual aunque ya no se vaya a
  // reingestar. Barato y seguro correrlo siempre.
  if (!onlyFile) {
    for (const excluded of EXCLUDED_FILES) {
      await deleteBySource(excluded);
    }
  }

  if (onlyFile) {
    files = files.filter((f) => f === onlyFile);
    if (!files.length) {
      console.error(`"${onlyFile}" no existe (o no es .md/.txt/.pdf) en ${KNOWLEDGE_DIR}.`);
      process.exit(1);
    }
  }

  if (!files.length) {
    console.log(`No hay documentos .md/.txt/.pdf en ${KNOWLEDGE_DIR} -- agrega alguno y vuelve a correr.`);
    return;
  }

  let totalChunks = 0;

  for (const file of files) {
    const fullPath = path.join(KNOWLEDGE_DIR, file);
    let raw;
    try {
      raw = await extractText(fullPath);
    } catch (error) {
      console.error(`No se pudo extraer texto de "${file}", se omite:`, error.message);
      continue;
    }

    const chunks = chunkFile(file, raw);
    console.log(`${file}: ${chunks.length} chunk(s)`);

    const points = [];
    for (let i = 0; i < chunks.length; i++) {
      const { heading, text } = chunks[i];
      const vector = await embedText(text);
      points.push({
        id: randomUUID(),
        vector,
        payload: {
          source: file,
          chunkIndex: i,
          heading: heading || null,
          text,
        },
      });
    }

    // Reemplaza -- borra lo que ya había de este archivo antes de subir
    // lo nuevo, así reingestar no acumula duplicados.
    await deleteBySource(file);

    if (points.length) {
      await upsertChunks(points);
      totalChunks += points.length;
    }
  }

  console.log(`Listo -- ${totalChunks} chunk(s) de ${files.length} documento(s) cargados en Qdrant.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error en la ingesta:", err);
    process.exit(1);
  });

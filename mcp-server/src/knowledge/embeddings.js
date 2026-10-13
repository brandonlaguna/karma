/**
 * Cliente de embeddings, configurable por EMBEDDING_PROVIDER:
 *
 * - "ollama" (default): endpoint nativo /api/embeddings (no el compatible con
 *   OpenAI -- más simple para un solo texto). nomic-embed-text, 768 dim, corre
 *   local sin costo, pero está pensado sobre todo para inglés: con documentos
 *   en español la búsqueda semántica falla con paráfrasis.
 * - "openai": POST /v1/embeddings. text-embedding-3-small, 1536 dim, multilingüe.
 *   Los textos (documentos al ingestar, consultas al buscar) salen a OpenAI.
 *
 * IMPORTANTE: la ingesta y las consultas deben usar el MISMO proveedor/modelo,
 * y la colección de Qdrant se crea con el tamaño de vector del que esté activo.
 * Si cambias de modelo hay que recrear la colección y reingestar (qdrant.js
 * avisa si los tamaños no coinciden).
 */
const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || "ollama";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434";
const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || (EMBEDDING_PROVIDER === "openai" ? "text-embedding-3-small" : "nomic-embed-text");

// Solo se manda "dimensions" a OpenAI si EMBEDDING_DIMENSIONS está definida
// (los text-embedding-3-* permiten acortar el vector); si no, usan su tamaño nativo.
const CUSTOM_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || null;

export const EMBEDDING_VECTOR_SIZE = CUSTOM_DIMENSIONS || (EMBEDDING_PROVIDER === "openai" ? 1536 : 768);

async function embedWithOllama(text) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama embeddings falló (${response.status}) con modelo "${EMBEDDING_MODEL}": ${body}. ` +
        `¿Corriste "ollama pull ${EMBEDDING_MODEL}" en el host?`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data.embedding)) {
    throw new Error(`Respuesta de embeddings inesperada de Ollama: ${JSON.stringify(data)}`);
  }

  return data.embedding;
}

async function embedWithOpenAI(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('EMBEDDING_PROVIDER="openai" pero OPENAI_API_KEY está vacía');
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      ...(CUSTOM_DIMENSIONS ? { dimensions: CUSTOM_DIMENSIONS } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI embeddings falló (${response.status}) con modelo "${EMBEDDING_MODEL}": ${body}`);
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;

  if (!Array.isArray(embedding)) {
    throw new Error(`Respuesta de embeddings inesperada de OpenAI: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return embedding;
}

export async function embedText(text) {
  return EMBEDDING_PROVIDER === "openai" ? embedWithOpenAI(text) : embedWithOllama(text);
}

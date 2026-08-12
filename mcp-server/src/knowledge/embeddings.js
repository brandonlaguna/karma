/**
 * Cliente de embeddings vía Ollama (endpoint nativo /api/embeddings, no
 * el compatible con OpenAI -- este es más simple para un solo texto a
 * la vez y no depende de la versión de Ollama soportando /v1/embeddings).
 *
 * Modelo por defecto: nomic-embed-text (768 dimensiones, corre local,
 * sin costo ni dependencia de internet -- ver decisión en
 * project_ai_lab_noc_assistant sobre por qué no usamos OpenAI acá).
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text";

export const EMBEDDING_VECTOR_SIZE = 768;

export async function embedText(text) {
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

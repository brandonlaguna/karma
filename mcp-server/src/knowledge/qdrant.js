import { QdrantClient } from "@qdrant/js-client-rest";
import { EMBEDDING_VECTOR_SIZE } from "./embeddings.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://qdrant:6333";
export const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "noc_knowledge_base";

const client = new QdrantClient({ url: QDRANT_URL });

let collectionReady = false;

/**
 * Crea la colección si todavía no existe. Se llama antes de cada
 * upsert/search en vez de una sola vez al arrancar -- este servicio no
 * mantiene estado entre requests (modo stateless, ver index.ts), así
 * que no hay un "startup" fijo donde hacer esto una sola vez.
 */
export async function ensureCollection() {
  if (collectionReady) return;

  const { exists } = await client.collectionExists(COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: EMBEDDING_VECTOR_SIZE, distance: "Cosine" },
    });
    console.log(`Colección "${COLLECTION_NAME}" creada en Qdrant (${EMBEDDING_VECTOR_SIZE} dim, coseno).`);
  }

  collectionReady = true;
}

export async function upsertChunks(points) {
  await ensureCollection();
  return client.upsert(COLLECTION_NAME, { wait: true, points });
}

/**
 * Borra todos los puntos de un archivo (payload.source == source) ANTES
 * de volver a subir sus chunks frescos -- así reingestar un documento
 * editado REEMPLAZA su contenido en vez de acumularlo (el problema de
 * duplicación que tenía el ingest original). No toca los puntos de
 * otros archivos.
 */
export async function deleteBySource(source) {
  await ensureCollection();
  return client.delete(COLLECTION_NAME, {
    wait: true,
    filter: { must: [{ key: "source", match: { value: source } }] },
  });
}

/**
 * FIX: @qdrant/js-client-rest ^1.18 removió client.search() -- la API
 * de búsqueda por vector ahora es client.query() (Query API), con el
 * vector bajo la key "query" (no "vector") y la respuesta envuelta en
 * "{ points: [...] }" en vez de un array plano como devolvía search().
 * Se desenvuelve acá para no tener que tocar el consumidor
 * (index.ts sigue recibiendo un array de {id, score, payload, ...}).
 */
export async function searchKnowledgeBase(vector, limit = 5) {
  await ensureCollection();
  const result = await client.query(COLLECTION_NAME, {
    query: vector,
    limit,
    with_payload: true,
  });
  return result.points;
}

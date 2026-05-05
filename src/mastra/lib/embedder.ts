/**
 * Singleton embedder for semantic search and RAG.
 * Uses Google text-embedding-004 via REST API (no @ai-sdk/google required).
 * Falls back gracefully if GOOGLE_GENERATIVE_AI_API_KEY is not set.
 *
 * Used by: chef notes semantic search, automation-architect pattern RAG.
 */

export type EmbeddingVector = number[];

const EMBEDDING_MODEL = 'text-embedding-004';
const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function fetchEmbedding(text: string): Promise<EmbeddingVector> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set — embedder unavailable');

  const url = `${GOOGLE_API_BASE}/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Embeddings API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { embedding: { values: number[] } };
  return data.embedding.values;
}

async function fetchEmbeddingBatch(texts: string[]): Promise<EmbeddingVector[]> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set — embedder unavailable');

  // batchEmbedContents endpoint
  const url = `${GOOGLE_API_BASE}/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map(text => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Embeddings batch API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { embeddings: Array<{ values: number[] }> };
  return data.embeddings.map(e => e.values);
}

/**
 * Embed a single text. Returns a float32 vector.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingVector> {
  return fetchEmbedding(text);
}

/**
 * Embed multiple texts in batches.
 */
export async function generateEmbeddings(texts: string[]): Promise<EmbeddingVector[]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await fetchEmbedding(texts[0])];
  return fetchEmbeddingBatch(texts);
}

/**
 * Cosine similarity between two vectors. Returns [-1, 1].
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) throw new Error('Vector length mismatch');
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find top-K most similar items from a list.
 */
export function findTopK<T extends { embedding: EmbeddingVector }>(
  query: EmbeddingVector,
  items: T[],
  k: number,
): Array<T & { score: number }> {
  return items
    .map(item => ({ ...item, score: cosineSimilarity(query, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

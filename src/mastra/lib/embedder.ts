/**
 * Singleton embedder for semantic search and RAG.
 * Default provider: local Ollama (bge-m3, 1024 dim, multilingual PL/EN).
 * Optional fallback: Google Generative AI text-embedding-* via REST.
 *
 * Provider selection (env):
 *   EMBEDDING_PROVIDER=ollama (default) | google
 *   EMBEDDING_MODEL=bge-m3 (default for ollama) | text-embedding-005 (google)
 *   OLLAMA_BASE_URL=http://localhost:11434
 *
 * Used by: chef notes semantic search, automation-architect pattern RAG.
 *
 * Note: changing the model changes vector dimensions. Existing embeddings in
 * MongoDB must be cleared and re-generated when switching providers/models.
 */

export type EmbeddingVector = number[];

type Provider = 'ollama' | 'google';

/**
 * Embedding config — env vars take priority, manifest provides defaults.
 * NOTE: model-manifest.ts only stores the alias key. We extract the raw
 * model name (e.g. 'bge-m3') from the full ID for use in API calls.
 */
import { models, infrastructure, resolveModelId } from '../config/model-manifest.js';

/** Extract raw model name from full manifest ID: 'ollama/local/bge-m3' → 'bge-m3' */
function extractModelName(fullId: string): string {
  return fullId.split('/').pop() ?? fullId;
}

const MANIFEST_EMBEDDING_MODEL = extractModelName(resolveModelId(infrastructure.embedding.model));

const PROVIDER: Provider = (process.env.EMBEDDING_PROVIDER as Provider) || 'ollama';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.EMBEDDING_MODEL || MANIFEST_EMBEDDING_MODEL;
const GOOGLE_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-005';
const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function fetchOllamaEmbedding(text: string): Promise<EmbeddingVector> {
  const url = `${OLLAMA_BASE_URL}/api/embeddings`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama embeddings error ${response.status} (model=${OLLAMA_MODEL}): ${err}`);
  }

  const data = (await response.json()) as { embedding?: number[] };
  if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
    throw new Error(`Ollama returned empty embedding (model=${OLLAMA_MODEL})`);
  }
  return data.embedding;
}

async function fetchGoogleEmbedding(text: string): Promise<EmbeddingVector> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set — google embedder unavailable');

  const url = `${GOOGLE_API_BASE}/${GOOGLE_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${GOOGLE_MODEL}`,
      content: { parts: [{ text }] },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Embeddings API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

async function fetchEmbedding(text: string): Promise<EmbeddingVector> {
  return PROVIDER === 'google' ? fetchGoogleEmbedding(text) : fetchOllamaEmbedding(text);
}

/**
 * Embed a single text. Returns a float vector.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingVector> {
  return fetchEmbedding(text);
}

/**
 * Embed multiple texts. Ollama has no batch endpoint, so we run sequentially
 * to avoid hammering the local server. Google batchEmbedContents is used when
 * provider=google.
 */
export async function generateEmbeddings(texts: string[]): Promise<EmbeddingVector[]> {
  if (texts.length === 0) return [];
  if (PROVIDER === 'google') return fetchGoogleBatch(texts);
  const out: EmbeddingVector[] = [];
  for (const t of texts) out.push(await fetchOllamaEmbedding(t));
  return out;
}

async function fetchGoogleBatch(texts: string[]): Promise<EmbeddingVector[]> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set — google embedder unavailable');

  const url = `${GOOGLE_API_BASE}/${GOOGLE_MODEL}:batchEmbedContents?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${GOOGLE_MODEL}`,
        content: { parts: [{ text }] },
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Embeddings batch API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { embeddings: Array<{ values: number[] }> };
  return data.embeddings.map((e) => e.values);
}

/**
 * Cosine similarity between two vectors. Returns [-1, 1].
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) throw new Error('Vector length mismatch');
  let dot = 0,
    normA = 0,
    normB = 0;
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
    .map((item) => ({ ...item, score: cosineSimilarity(query, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

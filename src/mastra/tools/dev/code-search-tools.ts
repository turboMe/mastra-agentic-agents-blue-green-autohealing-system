/**
 * Semantic Code Search (Phase 5 — Code Search)
 *
 * Embedding-based code search using Tree-sitter AST-aware chunking
 * and the existing embedder infrastructure (Ollama/Google).
 *
 * Multi-repo capable: searches use the same SQLite DB per-repo
 * as the repo-indexer. Pass repoPath to search any indexed repo.
 *
 * Uses existing:
 *   - lib/embedder.ts → generateEmbedding(), cosineSimilarity()
 *   - services/repo-indexer.ts → SQLite DB, symbol data
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { EMBEDDING_MODEL_ID, generateEmbedding, cosineSimilarity } from '../../lib/embedder.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface CodeChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string;
  content: string;
  hash: string;
}

interface SearchResult {
  file: string;
  startLine: number;
  endLine: number;
  symbol: string;
  snippet: string;
  score: number;
}

// ── Multi-Repo DB Registry ──────────────────────────────────────────────────

const _dbs = new Map<string, Database.Database>();

function getDb(repoPath: string): Database.Database {
  const existing = _dbs.get(repoPath);
  if (existing) return existing;

  const dbPath = resolve(repoPath, '.mastra', 'repo-index.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Ensure code_chunks table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      symbol_name TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      embedding_model TEXT,
      embedding BLOB,
      UNIQUE(file_path, start_line, end_line)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON code_chunks(content_hash);
  `);

  const columns = db.prepare('PRAGMA table_info(code_chunks)').all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'embedding_model')) {
    db.exec('ALTER TABLE code_chunks ADD COLUMN embedding_model TEXT');
  }

  _dbs.set(repoPath, db);
  return db;
}

// ── Chunk Extraction ─────────────────────────────────────────────────────────

function extractChunksFromIndex(repoPath: string): CodeChunk[] {
  const db = getDb(repoPath);
  const symbols = db.prepare(`
    SELECT file_path, name, line, signature
    FROM symbols
    WHERE kind = 'def' AND line >= 0
    ORDER BY file_path, line
  `).all() as Array<{ file_path: string; name: string; line: number; signature: string }>;

  const chunks: CodeChunk[] = [];
  const byFile = new Map<string, typeof symbols>();

  for (const sym of symbols) {
    if (!byFile.has(sym.file_path)) byFile.set(sym.file_path, []);
    byFile.get(sym.file_path)!.push(sym);
  }

  for (const [filePath, fileSyms] of byFile) {
    for (let i = 0; i < fileSyms.length; i++) {
      const sym = fileSyms[i];
      const nextSym = fileSyms[i + 1];
      const startLine = Math.max(0, sym.line - 2);
      const endLine = nextSym ? Math.min(nextSym.line - 1, sym.line + 50) : sym.line + 50;

      const content = `${filePath}\n${sym.signature || sym.name}\nLine: ${sym.line}`;
      const { createHash } = require('crypto');
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

      chunks.push({ filePath, startLine, endLine, symbolName: sym.name, content, hash });
    }
  }

  return chunks;
}

// ── Embedding Generation ─────────────────────────────────────────────────────

async function ensureEmbeddings(repoPath: string): Promise<{ embedded: number; cached: number }> {
  const db = getDb(repoPath);
  const chunks = extractChunksFromIndex(repoPath);

  let embedded = 0;
  let cached = 0;

  const getExisting = db.prepare(
    'SELECT id, content_hash, embedding_model FROM code_chunks WHERE file_path = ? AND start_line = ? AND end_line = ?',
  );
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO code_chunks
      (file_path, start_line, end_line, symbol_name, content_hash, embedding_model, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const chunk of chunks) {
    const existing = getExisting.get(chunk.filePath, chunk.startLine, chunk.endLine) as
      | { id: number; content_hash: string; embedding_model?: string | null }
      | undefined;

    if (
      existing &&
      existing.content_hash === chunk.hash &&
      existing.embedding_model === EMBEDDING_MODEL_ID
    ) {
      cached++;
      continue;
    }

    try {
      // Some embedders produce poor/empty vectors for very short identifiers.
      if (chunk.content.length < 8) {
        continue;
      }
      const embedding = await generateEmbedding(chunk.content);
      const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

      upsert.run(
        chunk.filePath, chunk.startLine, chunk.endLine,
        chunk.symbolName, chunk.hash, EMBEDDING_MODEL_ID, embeddingBuffer,
      );
      embedded++;
    } catch (err) {
      console.warn(`[CodeSearch] Failed to embed ${chunk.filePath}:${chunk.symbolName}:`, (err as Error).message);
    }
  }

  return { embedded, cached };
}

// ── Search ───────────────────────────────────────────────────────────────────

async function searchCode(
  query: string,
  repoPath: string,
  topK: number = 10,
  scope?: string,
): Promise<SearchResult[]> {
  const db = getDb(repoPath);

  // Ensure embeddings are up-to-date
  await ensureEmbeddings(repoPath);

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);

  // Load all chunks with embeddings
  let sql = `
    SELECT file_path, start_line, end_line, symbol_name, embedding
    FROM code_chunks
    WHERE embedding IS NOT NULL AND embedding_model = ?
  `;
  const params: any[] = [EMBEDDING_MODEL_ID];
  if (scope) {
    sql += ' AND file_path LIKE ?';
    params.push(`${scope}%`);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    file_path: string;
    start_line: number;
    end_line: number;
    symbol_name: string;
    embedding: Buffer;
  }>;

  // Calculate similarity scores
  const scored: SearchResult[] = [];
  for (const row of rows) {
    const chunkEmbedding = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    const score = cosineSimilarity(queryEmbedding, chunkEmbedding);

    scored.push({
      file: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      symbol: row.symbol_name,
      snippet: '',
      score,
    });
  }

  // Sort by score, take top-K
  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, topK);

  // Load actual code snippets for top results
  for (const result of topResults) {
    try {
      const absPath = resolve(repoPath, result.file);
      const content = await readFile(absPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, result.startLine);
      const end = Math.min(lines.length, result.endLine + 1);
      result.snippet = lines.slice(start, end).join('\n').slice(0, 500);
    } catch {
      result.snippet = '(file not readable)';
    }
  }

  return topResults;
}

// ── Tool: code.search ────────────────────────────────────────────────────────

export const codeSearchTool = createTool({
  id: 'code_search',
  description:
    'Semantic search across a codebase — finds code by meaning, not just keywords. ' +
    'Uses embeddings to match your query against function/class/interface definitions. ' +
    'Use when you need to find WHERE something is implemented or what code handles a concept. ' +
    'Pass repoPath to search any indexed repository.',
  inputSchema: z.object({
    query: z.string().describe(
      'Natural language description of what you are looking for (e.g., "error handling in subtask execution")',
    ),
    repoPath: z.string().optional().describe(
      'Absolute path to repository to search. Defaults to agent\'s own codebase.',
    ),
    topK: z.number().optional().default(10).describe('Number of results to return'),
    scope: z.string().optional().describe('Directory scope to limit search (e.g., "src/services")'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      file: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      symbol: z.string(),
      snippet: z.string(),
      score: z.number(),
    })).optional(),
    repoPath: z.string().optional(),
    totalChunks: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const targetRepo = context.repoPath || AGENTIC_AGENTS_REPO;
      const results = await searchCode(context.query, targetRepo, context.topK, context.scope);
      const db = getDb(targetRepo);
      const totalChunks = (
        db.prepare('SELECT COUNT(*) as cnt FROM code_chunks WHERE embedding IS NOT NULL AND embedding_model = ?')
          .get(EMBEDDING_MODEL_ID) as any
      ).cnt;

      return {
        success: true,
        results,
        repoPath: targetRepo,
        totalChunks,
      };
    } catch (error) {
      return {
        success: false,
        error: `Code search error: ${(error as Error).message}`,
      };
    }
  },
});

// ── Tool: code.embed_stats ───────────────────────────────────────────────────

export const codeEmbedStatsTool = createTool({
  id: 'code_embed_stats',
  description: 'Get statistics about code embeddings for a repository.',
  inputSchema: z.object({
    repoPath: z.string().optional().describe(
      'Absolute path to repository. Defaults to agent\'s own codebase.',
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    stats: z.object({
      totalChunks: z.number(),
      embeddedChunks: z.number(),
      pendingChunks: z.number(),
    }).optional(),
    repoPath: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const targetRepo = context.repoPath || AGENTIC_AGENTS_REPO;
      const db = getDb(targetRepo);
      const total = (db.prepare('SELECT COUNT(*) as cnt FROM code_chunks').get() as any).cnt;
      const embedded = (
        db.prepare('SELECT COUNT(*) as cnt FROM code_chunks WHERE embedding IS NOT NULL AND embedding_model = ?')
          .get(EMBEDDING_MODEL_ID) as any
      ).cnt;
      return {
        success: true,
        stats: { totalChunks: total, embeddedChunks: embedded, pendingChunks: total - embedded },
        repoPath: targetRepo,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

/**
 * Context Assembler (Phase 5 — Smart Context Assembly)
 *
 * Unifies all context sources into a single, token-budgeted prompt section
 * for injection into subtask prompts. Each source has a priority-weighted
 * token allocation.
 *
 * Sources:
 *   1. Repo Map (structural awareness — highest priority)
 *   2. Semantic Code Search (relevant code snippets)
 *   3. Checkpoint State (session continuity)
 *
 * Token Budget Allocation:
 *   - 45% → Repo Map (ranked AST symbols)
 *   - 35% → Relevant Code (semantic search snippets)
 *   - 20% → Checkpoint State (session resume context)
 */

import { getRepoIndexer } from './repo-indexer.js';
import { loadCheckpoint, formatCheckpointForPrompt } from './context-checkpoint.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AssembledContext {
  repoMap: string;
  relevantCode: string;
  checkpoint: string;
  totalTokensEstimate: number;
}

export interface AssembleOptions {
  /** Task description for contextual ranking */
  description: string;
  /** Files being targeted by this subtask */
  targetFiles: string[];
  /** Task ID for checkpoint lookup */
  taskId: string;
  /** Total token budget for assembled context (default: 4096) */
  tokenBudget?: number;
  /** Mentioned identifiers to boost in repo map */
  mentionedIdents?: string[];
}

// ── Token Estimation ─────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough approximation: ~4 chars per token for code
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... (truncated to fit token budget)';
}

// ── Main Assembler ───────────────────────────────────────────────────────────

export async function assembleContext(options: AssembleOptions): Promise<AssembledContext> {
  const {
    description,
    targetFiles,
    taskId,
    tokenBudget = 4096,
    mentionedIdents = [],
  } = options;

  // Token allocation
  const repoMapBudget = Math.floor(tokenBudget * 0.45);
  const relevantCodeBudget = Math.floor(tokenBudget * 0.35);
  const checkpointBudget = Math.floor(tokenBudget * 0.20);

  // ── 1. Repo Map (structural awareness) ──
  let repoMap = '';
  try {
    const indexer = getRepoIndexer();
    // Ensure index is fresh (incremental)
    await indexer.index();
    repoMap = indexer.getRepoMap({
      query: description,
      focusFiles: targetFiles,
      mentionedIdents,
      maxTokens: repoMapBudget,
    });
  } catch (err) {
    repoMap = `(repo map unavailable: ${(err as Error).message})`;
  }

  // ── 2. Relevant Code (semantic search) ──
  // NOTE: Semantic search embedding requires Ollama running.
  // We attempt it but gracefully degrade if embedder is offline.
  let relevantCode = '';
  try {
    // Dynamic import to avoid hard dependency on embedder availability
    const { generateEmbedding, cosineSimilarity } = await import('../lib/embedder.js');
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');

    const rootPath = '/projekty/mastra-agentic-environment/agentic-agents';
    const dbPath = resolve(rootPath, '.mastra', 'repo-index.db');

    let db: any;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      // DB doesn't exist yet
      db = null;
    }

    if (db) {
      const rows = db.prepare(
        'SELECT file_path, start_line, end_line, symbol_name, embedding FROM code_chunks WHERE embedding IS NOT NULL',
      ).all() as Array<{
        file_path: string;
        start_line: number;
        end_line: number;
        symbol_name: string;
        embedding: Buffer;
      }>;

      if (rows.length > 0) {
        const queryEmbedding = await generateEmbedding(description);
        const scored = rows.map((row) => {
          const chunkEmbedding = Array.from(
            new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
          );
          return {
            file: row.file_path,
            symbol: row.symbol_name,
            startLine: row.start_line,
            endLine: row.end_line,
            score: cosineSimilarity(queryEmbedding, chunkEmbedding),
          };
        });

        scored.sort((a, b) => b.score - a.score);
        const topResults = scored.slice(0, 5);

        const snippets = topResults.map(
          (r) => `  ${r.file}:${r.startLine} — ${r.symbol} (score: ${r.score.toFixed(3)})`,
        );
        relevantCode = snippets.join('\n');
      }

      db.close();
    }
  } catch {
    // Embedder offline or DB not ready — graceful degradation
    relevantCode = '';
  }

  // ── 3. Checkpoint State (session continuity) ──
  let checkpoint = '';
  try {
    const cp = await loadCheckpoint(taskId);
    if (cp) {
      checkpoint = formatCheckpointForPrompt(cp);
    }
  } catch {
    // Checkpoint unavailable — non-critical
  }

  // ── Truncate to budget ──
  repoMap = truncateToTokens(repoMap, repoMapBudget);
  relevantCode = truncateToTokens(relevantCode, relevantCodeBudget);
  checkpoint = truncateToTokens(checkpoint, checkpointBudget);

  const totalTokensEstimate =
    estimateTokens(repoMap) + estimateTokens(relevantCode) + estimateTokens(checkpoint);

  return {
    repoMap,
    relevantCode,
    checkpoint,
    totalTokensEstimate,
  };
}

/**
 * Format assembled context as a single prompt section for injection.
 * Only includes non-empty sections to save tokens.
 */
export function formatAssembledContext(ctx: AssembledContext): string {
  const sections: string[] = [];

  if (ctx.repoMap && ctx.repoMap.length > 20) {
    sections.push('## Repository Map (ranked by relevance)');
    sections.push('```');
    sections.push(ctx.repoMap);
    sections.push('```');
    sections.push('');
  }

  if (ctx.relevantCode && ctx.relevantCode.length > 10) {
    sections.push('## Relevant Code Locations');
    sections.push(ctx.relevantCode);
    sections.push('');
  }

  if (ctx.checkpoint && ctx.checkpoint.length > 10) {
    sections.push(ctx.checkpoint);
    sections.push('');
  }

  if (sections.length === 0) return '';

  return sections.join('\n');
}

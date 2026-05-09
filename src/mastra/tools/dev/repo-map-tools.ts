/**
 * Repo Map Tool (Phase 5 — Repo Indexing)
 *
 * Provides agents with a ranked structural map of the repository.
 * Uses Tree-sitter AST + PageRank to show the most relevant
 * symbols, files, and their signatures for a given task.
 *
 * Think of it as "GPS for the codebase" — instead of blindly
 * exploring files, the agent gets a pre-ranked overview.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getRepoIndexer } from '../../services/repo-indexer.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';

// ── repo.map — Ranked repository structure ──────────────────────────────────

export const repoMapTool = createTool({
  id: 'repo.map',
  description:
    'Get a ranked structural map of the repository showing the most relevant files and symbols ' +
    'for a given task. Uses AST parsing and PageRank to prioritize files by dependency importance. ' +
    'Use this BEFORE reading individual files to understand which files are most relevant to your task.',
  inputSchema: z.object({
    query: z.string().describe(
      'What you are looking for or working on (e.g., "authentication middleware", "error handling in subtask executor")',
    ),
    focusFiles: z.array(z.string()).optional().describe(
      'Files you are currently editing — these will boost related files in the ranking',
    ),
    mentionedIdents: z.array(z.string()).optional().describe(
      'Specific identifiers (function/class names) to boost in the ranking',
    ),
    maxTokens: z.number().optional().default(2048).describe(
      'Token budget for the generated map (default: 2048)',
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    map: z.string().optional(),
    stats: z.object({
      files: z.number(),
      symbols: z.number(),
      definitions: z.number(),
      references: z.number(),
    }).optional(),
    indexDuration: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const indexer = getRepoIndexer(AGENTIC_AGENTS_REPO);

      // Ensure index is fresh (incremental — only re-indexes changed files)
      const indexResult = await indexer.index();

      // Generate ranked map
      const map = indexer.getRepoMap({
        query: context.query,
        focusFiles: context.focusFiles,
        mentionedIdents: context.mentionedIdents,
        maxTokens: context.maxTokens,
      });

      const stats = indexer.getStats();

      return {
        success: true,
        map,
        stats,
        indexDuration: `${indexResult.durationMs}ms (${indexResult.indexed} files re-indexed)`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Repo indexer error: ${(error as Error).message}`,
      };
    }
  },
});

// ── repo.stats — Index statistics ───────────────────────────────────────────

export const repoStatsTool = createTool({
  id: 'repo.stats',
  description:
    'Get statistics about the repository index: number of files, symbols, definitions, and references. ' +
    'Use to verify the index is populated and up-to-date.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    stats: z.object({
      files: z.number(),
      symbols: z.number(),
      definitions: z.number(),
      references: z.number(),
    }).optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const indexer = getRepoIndexer(AGENTIC_AGENTS_REPO);
      const stats = indexer.getStats();
      return { success: true, stats };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ── repo.reindex — Force full re-index ──────────────────────────────────────

export const repoReindexTool = createTool({
  id: 'repo.reindex',
  description:
    'Force a full re-index of the repository. Only needed if the index seems stale. ' +
    'Normal incremental indexing happens automatically with repo.map.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    indexed: z.number().optional(),
    removed: z.number().optional(),
    total: z.number().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const indexer = getRepoIndexer(AGENTIC_AGENTS_REPO);
      const result = await indexer.index();
      return {
        success: true,
        indexed: result.indexed,
        removed: result.removed,
        total: result.total,
        durationMs: result.durationMs,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

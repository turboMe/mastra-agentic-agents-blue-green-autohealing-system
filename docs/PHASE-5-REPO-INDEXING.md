# Phase 5: Repository Indexing & Context Management

> **Status:** 🚧 In Progress  
> **Deployed:** 2026-05-09  
> **Dependencies:** tree-sitter, better-sqlite3, graphology

---

## Overview

Phase 5 adds industry-grade repository navigation and context management to the coding agent, closing the gap with Cursor, Aider, and Claude Code.

### What's Implemented

| Feature | Status | File |
|---------|--------|------|
| Tree-sitter AST Indexer | ✅ Done | `services/repo-indexer.ts` |
| PageRank Symbol Ranking | ✅ Done | `services/repo-indexer.ts` |
| SQLite Persistent Cache | ✅ Done | `.mastra/repo-index.db` |
| `repo.map` tool | ✅ Done | `tools/dev/repo-map-tools.ts` |
| `repo.stats` tool | ✅ Done | `tools/dev/repo-map-tools.ts` |
| `repo.reindex` tool | ✅ Done | `tools/dev/repo-map-tools.ts` |
| TokenLimiterProcessor | ✅ Done | `agents/coding-agent.ts` |
| Workspace Tools (auto) | ✅ Done | `workspaces/code-workspace.ts` |
| Context Checkpoints | ⏳ TODO | — |
| Semantic Code Search | ⏳ TODO | — |
| Context Assembler | ⏳ TODO | — |

---

## Architecture

### Repo Indexer Pipeline

```
SCAN → DIFF → PARSE → EXTRACT → GRAPH → RANK → RENDER
```

1. **SCAN** — Walk workspace recursively, compute SHA-256 file hashes
2. **DIFF** — Compare hashes against SQLite cache → only re-index changed files
3. **PARSE** — Tree-sitter AST parsing per changed file (TypeScript, JavaScript, TSX)
4. **EXTRACT** — Walk AST nodes to extract symbol definitions and identifier references
5. **GRAPH** — Build directed graph: `file → [defines symbol] → file [references symbol]`
6. **RANK** — Personalized PageRank (graphology) with query-aware boosting
7. **RENDER** — Top-N symbols by rank → formatted text within a token budget

### Indexer Configuration

- **Languages:** TypeScript (.ts/.tsx), JavaScript (.js/.jsx/.mjs/.cjs)
- **Storage:** SQLite via `better-sqlite3` (WAL mode, ~0 latency)
- **Ignored:** `node_modules`, `.git`, `dist`, `build`, `.mastra`, lock files
- **Max file size:** 512KB (skip minified bundles)
- **Auto-refresh:** Incremental on every `repo.map` call

### SQLite Schema

```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  language TEXT,
  size_bytes INTEGER,
  last_indexed INTEGER NOT NULL
);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,     -- 'def' | 'ref'
  line INTEGER DEFAULT -1,
  signature TEXT DEFAULT '',
  UNIQUE(file_path, name, kind, line)
);
```

---

## Agent Tools

### `repo.map`
Get a ranked structural map of the repository. Uses AST parsing and PageRank to show the most relevant files and symbols for a given task.

```typescript
// Input
{
  query: "authentication middleware",
  focusFiles: ["src/mastra/services/subtask-executor.ts"],
  mentionedIdents: ["buildScopedPrompt"],
  maxTokens: 2048
}

// Output — formatted text like:
// src/mastra/services/subtask-executor.ts:
//   │ export class SubtaskExecutor
//   │ async buildScopedPrompt(subtask, taskId, context, role, skill)
// src/mastra/config/subagent-roles.ts:
//   │ export const SUBAGENT_ROLES
```

### `repo.stats`
Returns index statistics: total files, symbols, definitions, references.

### `repo.reindex`
Forces a full re-index. Normal incremental indexing happens automatically.

---

## Context Management

### TokenLimiterProcessor
Added as `inputProcessors` on `codingAgent` with a 120K token limit. Prevents context window overflow during long autonomous sessions.

```typescript
inputProcessors: [
  new TokenLimiterProcessor({
    limit: 120_000,  // Gemini 2.5 Flash effective limit
  }),
],
```

### Observational Memory
Already active in `coding-agent.ts` — compresses old messages into dense observations to maintain a stable context window across 15+ subtask orchestrations.

### Workspace Tools (Auto-Generated)
The Mastra `Workspace` class auto-generates these tools from `code-workspace.ts`:
- `view` — Read file contents
- `find_files` — List/search files
- `search_content` — Grep/ripgrep
- `workspace_search` — BM25 semantic search
- `lsp_inspect` — LSP hover/go-to-definition/find-references

---

## Dependencies Added

| Package | Version | Purpose |
|---------|---------|---------|
| `tree-sitter` | 0.21.1 | AST parsing engine |
| `tree-sitter-typescript` | 0.23.2 | TS/TSX grammar |
| `tree-sitter-javascript` | 0.23.1 | JS grammar |
| `better-sqlite3` | latest | Persistent index storage |
| `graphology` | latest | Directed graph for PageRank |
| `graphology-metrics` | latest | PageRank algorithm |

---

## Startup Behavior

The repo indexer initializes at Mastra startup:

```
[RepoIndexer] Startup scan: 85 files, 85 indexed in 2340ms
```

Subsequent runs are incremental (only re-index changed files):
```
[RepoIndexer] Indexed 1 changed, removed 0, total 85 files in 45ms
```

---

## Remaining Work

### Phase 3.3: Context Checkpoints
- Auto-save task state (goal, decisions, modified files, known issues) before context compaction
- Auto-restore on session resume
- Storage: `.mastra/checkpoints/{taskId}.json`

### Phase 4: Semantic Code Search
- Embedding-based code search using `nomic-embed-text` (already in SkillRegistry)
- AST-aware chunking (function/class boundaries)
- `code.search` tool for semantic codebase queries

### Phase 5: Context Assembly
- Unified context assembler combining repo-map + semantic search + memory recall + skill procedures
- Token-budget-aware allocation across context sections
- Auto-injection into `subtask-executor.ts` prompt builder

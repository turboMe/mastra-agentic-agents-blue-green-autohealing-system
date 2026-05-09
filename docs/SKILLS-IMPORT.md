# Skill Registry — External Skills Import

> Status: ✅ Complete | Imported: 2026-05-09

## Overview

Imported 4 high-quality skills from the [anthropics/skills](https://github.com/anthropics/skills)
repository (131k ⭐) into our SkillRegistry. These skills follow the
[Agent Skills Spec](https://agentskills.io/specification) and are fully
compatible with our YAML-frontmatter-based indexing system.

## Imported Skills

### 1. `webapp-testing` → `coding/`
**Playwright testing toolkit** — decision tree for static/dynamic apps,
server lifecycle management, DOM inspection patterns.
- Bundle: `webapp-testing-scripts/` (with_server.py)
- Bundle: `webapp-testing-examples/` (element discovery, console logging)
- Use case: QA sub-agent, UI testing, screenshot debugging

### 2. `mcp-builder` → `coding/`
**MCP server development guide** — 4-phase process (research → implement → test → eval),
TypeScript + Python patterns, tool design best practices.
- Bundle: `mcp-builder-reference/` (best practices, SDK guides, evaluation guide)
- Bundle: `mcp-builder-scripts/` (evaluation runner)
- Use case: Building new MCP tools, API integration

### 3. `frontend-design` → `coding/`
**Anti-"AI slop" UI design** — typography, color, motion, spatial composition.
Emphasizes intentional aesthetic choices over generic AI-generated interfaces.
- No bundles (self-contained)
- Use case: Better UI generation, frontend task quality

### 4. `skill-creator` → `meta/` (NEW CATEGORY)
**Meta-skill for creating and optimizing other skills** — full lifecycle:
draft → test → evaluate → improve → package.
- Bundle: `skill-creator-agents/` (grader, comparator, analyzer)
- Bundle: `skill-creator-scripts/` (eval runner, benchmark aggregator, packaging)
- Bundle: `skill-creator-references/` (JSON schemas)
- Bundle: `skill-creator-assets/` (eval review HTML template)
- Use case: Autonomous skill creation and self-improvement

## Infrastructure Changes

### SkillRegistry Guard Clause
Added filter in `skill-registry.ts` to skip `.md` files without YAML
frontmatter (`name` or `description`). This prevents reference docs
(e.g., `mcp-builder-reference/evaluation.md`) from being indexed as skills.

### Path Normalization
Imported skills reference `scripts/`, `reference/`, etc. relative paths.
These were updated to match our flat naming convention:
- `scripts/` → `webapp-testing-scripts/`
- `reference/` → `mcp-builder-reference/`
- `agents/` → `skill-creator-agents/`

### `.gitignore`
Added `_external/` (cloned Anthropic repo used as source material).

## Skill Inventory (19 total)

| Category | Count | Skills |
|----------|:-----:|--------|
| `terminal` | 6 | git-conflict-resolver, swe-repo-explorer, agentic-terminal-problem-solving, code-modification-agent, terminal-code-dev, nodejs-dependency-fixer |
| `coding` | 6 | fix-typescript-error, safe-file-edit, run-verification, webapp-testing, mcp-builder, frontend-design |
| `n8n` | 6 | n8n-common-patterns, n8n-node-catalog, n8n-workflow-rules, n8n-security-review, n8n-expression-syntax, n8n-security-checklist |
| `meta` | 1 | skill-creator |

## Agent Skills Spec Compatibility

Our format is a **superset** of the Agent Skills standard:

| Spec Field | Our Support | Notes |
|------------|:-----------:|-------|
| `name` | ✅ | Required |
| `description` | ✅ | Required |
| `license` | — | Stripped on import |
| `compatibility` | — | Not used yet |
| `allowed-tools` | ✅ | As `allowedTools` |
| **Our extensions:** | | |
| `category` | ✅ | Directory-derived |
| `keywords` | ✅ | Semantic search |
| `source` | ✅ | Import provenance |
| `success_rate` | ✅ | Performance tracking |
| `total_uses` | ✅ | Usage analytics |

## Verification

- TypeScript compilation: `npx tsc --noEmit` → 0 errors
- Skill files with frontmatter: 19
- Reference/support files (skipped by guard): ~10

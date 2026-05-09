# Skill Registry — External Skills Import

> Status: ✅ Complete | Imported: 2026-05-09 | Updated: 2026-05-09 (batch 4)

## Overview

Imported 17 high-quality skills from five repositories into our SkillRegistry:
- [anthropics/skills](https://github.com/anthropics/skills) (131k ⭐) — 4 skills
- [openai/skills](https://github.com/openai/skills) (18.7k ⭐) — 6 skills
- [claude-office-skills/skills](https://github.com/claude-office-skills/skills) (106 ⭐) — 5 skills
- [bowenliang123/markdown-exporter](https://github.com/bowenliang123/markdown-exporter) (218 ⭐) — 1 skill
- [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) (3.8k ⭐) — 1 skill (patterns extracted)

All skills follow the [Agent Skills Spec](https://agentskills.io/specification)
and are fully compatible with our YAML-frontmatter-based indexing system.

## Imported from Anthropic

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

## Imported from OpenAI

### 5. `pdf` → `coding/`
**Open-source PDF toolkit** — read/create/review PDFs with visual verification.
Uses `reportlab`, `pdfplumber`, `pypdf`, and Poppler (all Apache 2.0).
- No bundles (self-contained, uses system/pip packages)
- Use case: PDF generation, text extraction, visual layout verification

### 6. `security-best-practices` → `coding/`
**Security review for JS/TS/Python/Go** — framework-specific best practices
with 10 reference files covering React, Next.js, Express, Django, FastAPI, etc.
- Bundle: `security-best-practices-references/` (10 framework-specific guides)
- Use case: Security audits, secure-by-default coding, vulnerability reports

### 7. `gh-fix-ci` → `coding/`
**GitHub CI debugger** — inspect failing PR checks, fetch Actions logs,
summarize failures, draft fix plans.
- Bundle: `gh-fix-ci-scripts/` (inspect_pr_checks.py)
- Use case: Self-healing CI pipeline, automated PR fix

### 8. `yeet` → `terminal/`
**Git one-shot flow** — stage, commit, push, and open a GitHub PR in one command.
- No bundles (self-contained)
- Use case: Quick git workflow automation

### 9. `screenshot` → `coding/`
**Desktop screenshot capture** — Linux-focused, Python helper + OS fallbacks.
- Bundle: `screenshot-scripts/` (take_screenshot.py + helpers)
- Use case: QA debugging, visual verification, UI testing

### 10. `cli-creator` → `coding/`
**CLI tool builder** — guide for creating composable CLI tools in Rust/TS/Python.
- Bundle: `cli-creator-references/` (agent-cli-patterns.md)
- Use case: Building durable command-line tools

## Imported from Claude Office Skills (MIT License)

### 11. `docx-manipulation` → `coding/`
**Word document manipulation** — create, edit .docx files using `python-docx` (MIT).
Report templates, data tables, mail merge, page setup, styles.
- No bundles (self-contained)
- Use case: Document generation, contract templates, report automation

### 12. `office-to-md` → `coding/`
**Universal Office→Markdown converter** — uses Microsoft's `markitdown` (MIT).
Converts .docx, .xlsx, .pptx, .pdf to clean Markdown in one call.
- No bundles (self-contained)
- Use case: Document ingestion for AI workflows, archive creation, RAG corpus building

### 13. `pdf-extraction` → `coding/`
**PDF data mining** — extract tables, invoices, multi-column text using `pdfplumber` (MIT).
Character-level positioning, visual debugging, region cropping.
- No bundles (self-contained)
- Use case: Financial report parsing, invoice extraction, data mining

### 14. `diagram-creator` → `coding/`
**Text-based diagram reference** — 9 Mermaid + PlantUML diagram types: flowchart,
sequence, architecture, ER, class, state, Gantt, mind map, git graph.
- No bundles (self-contained)
- Use case: Architecture documentation, technical diagrams, system visualization

### 15. `doc-parser` → `coding/`
**Advanced document parser** — IBM's `docling` library for AI-powered layout analysis,
OCR, figure/table extraction, multi-column handling, batch processing.
- No bundles (self-contained)
- Use case: Academic paper parsing, complex PDF analysis, document intelligence

## Imported from Community Open Source (Apache 2.0 / MIT)

### 16. `md-to-office` → `coding/`
**Markdown→Office export engine** — reverse pipeline complement to `office-to-md`.
Converts Markdown to DOCX, XLSX, PPTX, PDF, HTML, CSV, JSON, XML, LaTeX, ipynb
using `markdown-exporter` CLI (Apache 2.0, 218 ⭐).
- No bundles (self-contained, uses `pip install md-exporter`)
- Use case: Report generation, document export, bidirectional document pipeline

### 17. `xlsx-manipulation` → `coding/`
**Excel workbook automation** — create, read, modify .xlsx files using `openpyxl` (MIT).
Patterns distilled from excel-mcp-server (3.8k ⭐). Covers formatting, charts,
pivot tables, formulas, conditional formatting, data validation.
- No bundles (self-contained, uses `pip install openpyxl`)
- Use case: Spreadsheet generation, financial reports, data export, automated dashboards

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

## Skill Inventory (32 total)

| Category | Count | Skills |
|----------|:-----:|--------|
| `terminal` | 7 | git-conflict-resolver, swe-repo-explorer, agentic-terminal-problem-solving, code-modification-agent, terminal-code-dev, nodejs-dependency-fixer, **yeet** |
| `coding` | 18 | fix-typescript-error, safe-file-edit, run-verification, webapp-testing, mcp-builder, frontend-design, **pdf**, **security-best-practices**, **gh-fix-ci**, **screenshot**, **cli-creator**, **docx-manipulation**, **office-to-md**, **pdf-extraction**, **diagram-creator**, **doc-parser**, **md-to-office**, **xlsx-manipulation** |
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
- Skill files with frontmatter: 26
- Reference/support files (skipped by guard): ~10

## Source Licensing Summary

| Source | License | Redistribution | Derivative Works |
|--------|---------|:-:|:-:|
| Anthropic (skills) | Proprietary¹ | ❌ | ❌ |
| OpenAI (skills) | Apache 2.0 | ✅ | ✅ |
| claude-office-skills | MIT | ✅ | ✅ |
| markdown-exporter | Apache 2.0 | ✅ | ✅ |
| excel-mcp-server | MIT | ✅ | ✅ |

¹ We imported only the 4 skills explicitly marked "community" from Anthropic.
All other Anthropic office skills (xlsx, docx, pptx, pdf) were rejected
due to restrictive license terms.


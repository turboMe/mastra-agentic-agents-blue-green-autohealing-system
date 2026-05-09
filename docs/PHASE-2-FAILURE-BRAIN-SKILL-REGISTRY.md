# Phase 2 — Failure Brain + Skill Registry

> Status: In Progress | 2.1 ✅ | 2.2 ⏳ | 2.3 ⏳

## Overview

Phase 2 builds on the knowledge infrastructure from Phase 1 to create a self-improving
auto-heal system (Failure Brain) and a dynamic Skill Registry for agent capabilities.

## 2.1 Failure Brain ✅

### Concept

When a runtime error triggers the self-healing workflow, the system now **checks past
experience first** before starting diagnosis. If a similar error was seen and fixed before,
the fix recipe is injected into the workflow prompt — dramatically reducing diagnosis time.

### Architecture

```
Error occurs
  └→ ErrorCollector._triggerWorkflow()
       ├→ recallKnowledge(error, type='failure_case')   ← NEW
       ├→ recallKnowledge(error, type='autoheal_recipe') ← NEW
       └→ Build prompt with known failures section
            └→ repo-maintenance-workflow starts

Ticket resolved
  └→ ErrorCollector.resolveTicket()
       └→ writeKnowledge('autoheal_recipe', fix details) ← NEW
```

### Files Changed

| File | Change |
|------|--------|
| `lib/failure-brain.ts` | **New** — standalone `recallKnowledge()` and `writeKnowledge()` functions for programmatic access |
| `services/error-collector.ts` | **Modified** — `_triggerWorkflow()` now searches failure_case + autoheal_recipe before building prompt |
| `services/error-collector.ts` | **Modified** — `resolveTicket()` now saves autoheal_recipe after resolution |

### How it works

1. **Before workflow trigger** (`_triggerWorkflow`):
   - Searches `system_knowledge` for `failure_case` items matching the error (top 3, score ≥ 0.4)
   - Searches for `autoheal_recipe` items (top 2, score ≥ 0.4)
   - Injects matching knowledge into the workflow prompt as "known similar failures"
   - Non-fatal: if recall fails, workflow runs normally without historical context

2. **After ticket resolution** (`resolveTicket`):
   - Fetches the full ticket data before marking it resolved
   - Saves an `autoheal_recipe` to `system_knowledge` with:
     - Error message and source
     - Stack trace hint (first 3 lines)
     - Resolution details (workflow run ID)
   - Deduplicates by title — repeated fixes increase confidence

### Design Decision: Direct Functions vs Tool Interface

Internal services (ErrorCollector, workflows) don't have Mastra tool execution context.
Instead of fighting the tool interface, `lib/failure-brain.ts` extracts the core logic
into standalone `recallKnowledge()` and `writeKnowledge()` functions. These share the same
algorithms as `memoryRecallTool` and `memoryWriteTool` but can be called directly.

### Testing

To verify Failure Brain:
1. Trigger the same error twice via crash-test endpoint
2. First time: workflow runs without history (no knowledge yet)
3. First fix resolves → autoheal_recipe saved to system_knowledge
4. Second time: workflow prompt includes the recipe from step 3
5. Verify in MongoDB: `db.system_knowledge.find({type: 'autoheal_recipe'})`

## Verification

All code changes compile cleanly: `npx tsc --noEmit` → 0 errors.

# Code Review Agent & Self-Healing Workflow

Aktualizacja: 2026-05-08 | Status: **Etap 5 UKOŃCZONY** (E2E potwierdzone)

## Architektura

Workflow `repo-maintenance-workflow` realizuje pełny cykl Self-Healing:

```
[Input] → [codingAgent] → [codeReviewAgent] → [decision-gate]
                                                     │
                                    ┌────────────────┼────────────────┐
                                    │                │                │
                                 APPROVE        NEEDS_CHANGES      BLOCK
                                    │                │                │
                               [SUSPEND]        [codingAgent]      [STOP]
                                    │           poprawia kod
                              Human Resume          │
                                    │          [codeReviewAgent]
                               confirmMerge?    re-review
                                /        \          │
                             true        false   (max 3x)
                              │            │
                        [apply_patch]    [STOP]
                        [cleanup]
```

## Kroki Workflow

### Step 1: `execute-coding-agent`
- Generuje UUID dla zadania (lub przyjmuje przekazany).
- Instruuje `codingAgent` aby użył `coding.create_artifact` + `coding.init_worktree`.
- Agent pisze kod, puszcza linter/TSC w worktree.
- Workflow automatycznie uzupełnia `diffSummary` z `git diff HEAD` (backup).

### Step 2: `execute-review-agent`
- Ładuje `diffSummary` i `filesChanged` z MongoDB.
- Wkleja diff bezpośrednio do promptu recenzenta.
- `codeReviewAgent` może też samodzielnie użyć narzędzi worktree (patrz niżej).
- Odczytuje faktyczny `reviewVerdict` z MongoDB po wywołaniu `submitReviewTool`.

### Step 3: `decision-gate`
- **`approve`** → `suspend()` → czeka na `{ confirmMerge: true }` → `apply_patch` + `remove_worktree`
- **`needs_changes`** → pętla naprawcza (codingAgent poprawia, reviewer re-review, max 3 iteracje)
- **`block`** → natychmiastowy stop

## Narzędzia Reviewera (Worktree)

| Narzędzie | ID | Opis |
|-----------|-----|------|
| Diff | `coding.worktree_diff` | Git diff z worktree (z obsługą untracked files) |
| Lista plików | `coding.list_worktree_files` | Listing katalogu (z filtrem .git/node_modules) |
| Odczyt pliku | `coding.read_worktree_file` | Czyta plik z worktree (limit 200KB, path traversal guard) |
| Werdykt | `coding.submit_review` | Zapisuje approve/needs_changes/block w Mongo |
| Artefakt | `getCodeTaskArtifactTool` | Metadane zadania (plan, status, itp.) |

## Pliki źródłowe

| Plik | Opis |
|------|------|
| `src/mastra/workflows/repo-maintenance.ts` | Workflow (3 kroki + suspend/resume) |
| `src/mastra/agents/code-review-agent.ts` | Agent recenzujący (5 narzędzi) |
| `src/mastra/prompts/coding/review.md` | Prompt systemowy z procedurą review |
| `src/mastra/tools/dev/code-task-artifacts.ts` | Artifact + submitReview |
| `src/mastra/tools/dev/code-worktree.ts` | Worktree + diff/list/read tools |

## Wyniki testu E2E (2026-05-08)

```
codingAgent  → stworzył plik w worktree            ✅ (13s)
reviewAgent  → użył worktree_diff → approve         ✅ (6s)
decision-gate → SUSPENDED                           🟡
human        → confirmMerge: true                   ✅
apply_patch  → commit zmergowany na master           ✅
cleanup      → worktree usunięty                    ✅
```

Commit: `8ac80d7 Scalenie zatwierdzonych zmian dla zadania 7b365329-...`
Plik `scratch/reviewer-tools-test.js` poprawnie wylądował w live repo.

## Testowanie z Mastra Studio

1. **Workflows → repo-maintenance-workflow → Run**
2. Input JSON:
```json
{
  "userRequest": "Opis zadania do wykonania..."
}
```
3. Gdy workflow się zawiesi (status: suspended), kliknij **Resume**:
```json
{
  "confirmMerge": true
}
```

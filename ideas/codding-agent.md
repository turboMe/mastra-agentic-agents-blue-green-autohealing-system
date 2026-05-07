# Coding Agent dla Mastry

Cel: zbudowac w Mastrze lokalnego agenta developerskiego, ktory moze pracowac na repozytorium tak jak lokalny asystent w IDE: czytac kod, szukac po repo, korzystac z LSP, wykonywac testy/buildy, przygotowywac poprawki, prosic o approval dla ryzykownych akcji i opcjonalnie uruchamiac workflow "self-healing" po awariach.

Ten dokument jest instrukcja wdrozeniowa dla deva. Nie zaklada pelnego zaufania do agenta. Agent moze przygotowac zmiane, ale operacje ryzykowne musza miec approval.

## 1. Aktualny stan

Repo:

```txt
/projekty/mastra-agentic-environment/agentic-agents
```

Mastra core:

```txt
@mastra/core 1.31.0
```

Istniejace elementy:

- `src/mastra/index.ts` ma globalny `workspace` ustawiony na `/projekty/Jarvis-Projects`.
- `src/mastra/agents/meta-agent.ts` ma stare custom terminal tools w `ToolSearchProcessor`:
  - `fs.read_file`
  - `fs.write_file`
  - `shell.execute`
- `src/mastra/tools/terminal/terminal-tools.ts` uzywa sandboxa z Mongo setting `sandbox_path`, a gdy go nie ma, domyslnie `/tmp/sandbox-Jarvis`.
- To znaczy, ze meta-agent nie pracuje realnie na repo `agentic-agents`; probuje dzialac w osobnym sandboxie.

Problem:

- Gdy user prosi meta-agenta o prace na lokalnym repo, agent trafia w permission denied albo w zly katalog.
- `system.request_approval` istnieje, ale nie jest spiete z terminalem. To tylko rejestr approvala w Mongo, nie natywne zatrzymanie narzedzia terminalowego.

Wniosek:

- Nie rozszerzac starego `terminal-tools.ts` jako glownego narzedzia do developmentu.
- Zbudowac dedykowany `codingAgent` na natywnym Mastra `Workspace`.
- Meta-agent ma delegowac prace codingowa do `codingAgent`, a nie sam wykonywac terminal.

## 2. Docelowa architektura

### 2.1 Agenci

#### `metaAgent`

Rola:

- rozpoznaje intencje,
- deleguje coding tasks,
- zadaje pytania doprecyzowujace,
- zbiera wynik od `codingAgent`,
- pilnuje approvali.

Nie powinien miec pelnego terminala do repo.

#### `codingAgent`

Rola:

- czyta pliki,
- szuka po repo,
- uzywa LSP,
- proponuje i wprowadza zmiany,
- uruchamia bezpieczne komendy,
- dla ryzykownych komend pokazuje approval.

Model:

- lokalny mocniejszy model do rutynowych zmian, np. `ollama/local/qwen3-coder:30b`,
- fallback chmurowy do trudnych zmian, np. `google/gemini-2.5-pro`, `openai/gpt-5.2`, `anthropic/claude-sonnet-4-5`.

#### `codeReviewAgent`

Rola:

- nie edytuje plikow,
- ocenia diff,
- szuka regresji, ryzyk, brakujacych testow,
- sugeruje poprawki.

Model:

- najlepiej chmurowy lub mocny lokalny,
- ten agent powinien byc bardziej rygorystyczny niz kreatywny.

#### `testAgent` albo workflow step

Rola:

- uruchamia `npx tsc --noEmit`, testy, lint,
- streszcza output,
- nie pisze kodu.

To moze byc zwykly workflow step bez osobnego LLM.

### 2.2 Workspaces

Nalezy uzyc natywnego `Workspace` Mastry, nie custom terminal tools.

Workspace daje:

- filesystem,
- sandbox do komend,
- search/BM25,
- skills,
- approval per tool,
- LSP inspection.

Konfiguracja powinna byc agent-specific, czyli przypieta do `codingAgent`, nie tylko globalnie w `new Mastra({ workspace })`.

## 3. Pliki do dodania

Dodaj:

```txt
src/mastra/workspaces/code-workspace.ts
src/mastra/agents/coding-agent.ts
src/mastra/agents/code-review-agent.ts
src/mastra/prompts/coding/base.md
src/mastra/prompts/coding/review.md
src/mastra/workflows/dev/repo-maintenance.ts
src/mastra/config/dev-workspaces.ts
```

Opcjonalnie pozniej:

```txt
src/mastra/tools/dev/git-tools.ts
src/mastra/tools/dev/approval-resolver.ts
src/mastra/scripts/check-workspace-agent.ts
```

## 4. Konfiguracja modeli

Rozszerz `src/mastra/config/workflow-models.ts`.

Dodaj:

```ts
export const workflowModels = {
  // ...

  coding: {
    default: modelPresets.localReasoning,
    patch: modelPresets.localReasoning,
    review: modelPresets.googlePro,
    selfHealingPlanner: modelPresets.localReasoning,
    selfHealingReview: modelPresets.googlePro,
    jsonRepair: modelPresets.localMarketing,
  },
} as const;
```

Jesli chcesz trzymac coding modele osobno, mozna dodac `src/mastra/config/coding-models.ts`, ale lepiej zostac przy jednym centralnym pliku, bo juz mamy `workflow-models.ts`.

## 5. Workspace dla repo

Utworz `src/mastra/workspaces/code-workspace.ts`.

Proponowany szkic:

```ts
import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';

export const AGENTIC_AGENTS_REPO = '/projekty/mastra-agentic-environment/agentic-agents';

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isReadOnlyCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /^pwd$/,
    /^ls(\s|$)/,
    /^find\s/,
    /^rg(\s|$)/,
    /^sed\s+-n\s/,
    /^cat\s/,
    /^head(\s|$)/,
    /^tail(\s|$)/,
    /^wc(\s|$)/,
    /^git\s+status(\s|$)/,
    /^git\s+diff(\s|$)/,
    /^git\s+log(\s|$)/,
    /^git\s+show(\s|$)/,
    /^git\s+branch(\s|$)/,
  ].some((pattern) => pattern.test(c));
}

function isSafeVerificationCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /^npx\s+tsc\s+--noEmit$/,
    /^npm\s+test(\s|$)/,
    /^npm\s+run\s+test(\s|$)/,
    /^npm\s+run\s+lint(\s|$)/,
    /^npm\s+run\s+build(\s|$)/,
    /^pnpm\s+test(\s|$)/,
    /^pnpm\s+lint(\s|$)/,
    /^pnpm\s+build(\s|$)/,
  ].some((pattern) => pattern.test(c));
}

function isBlockedCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /\brm\s+-rf\b/,
    /^rm\s/,
    /^sudo\b/,
    /^su\b/,
    /^chmod\s+-R\b/,
    /^chown\s+-R\b/,
    /^git\s+reset\b/,
    /^git\s+clean\b/,
    /^git\s+checkout\s+--\b/,
    /^git\s+push\s+--force\b/,
    /^docker\s+system\s+prune\b/,
    /^mongo\b.*--eval\b.*drop/i,
    /\bdropDatabase\s*\(/i,
  ].some((pattern) => pattern.test(c));
}

function requiresCommandApproval(command: string): boolean {
  if (isBlockedCommand(command)) return true;
  if (isReadOnlyCommand(command)) return false;
  if (isSafeVerificationCommand(command)) return false;
  return true;
}

export const codeWorkspace = new Workspace({
  id: 'agentic-agents-code-workspace',
  name: 'Agentic Agents Repo Workspace',

  filesystem: new LocalFilesystem({
    basePath: AGENTIC_AGENTS_REPO,
  }),

  sandbox: new LocalSandbox({
    workingDirectory: AGENTIC_AGENTS_REPO,
    isolation: 'bwrap',
    nativeSandbox: {
      allowNetwork: true,
    },
  }),

  lsp: true,
  bm25: true,
  autoIndexPaths: [
    'src',
    'ideas',
    'docs',
    'scratch',
    'package.json',
    'tsconfig.json',
  ],
  skills: [
    'src/mastra/_skills/terminal',
  ],

  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
      name: 'view',
    },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      name: 'write_file',
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
      name: 'find_files',
    },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
      name: 'search_content',
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      name: 'execute_command',
      requireApproval: ({ args }) => requiresCommandApproval(String(args.command ?? '')),
    },
    [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
      name: 'lsp_inspect',
    },
  },
});
```

Uwagi:

- `write_file` powinien miec `requireApproval: true` na MVP.
- `requireReadBeforeWrite: true` chroni przed nadpisaniem pliku, ktorego agent nie przeczytal.
- `execute_command` powinien wykonywac bez approval tylko read-only i test/build/lint.
- Dla `npm install`, migracji, `git commit`, `git push`, deploy, restartow i operacji destrukcyjnych approval jest wymagany.
- Nie indeksuj `node_modules`, `.git`, `.mastra/output`, `.env`, `src/mastra/public/mastra.duckdb*`.

Jezeli `LocalFilesystem` w tej wersji nie ma opcji ignore/exclude, ogranicz `autoIndexPaths` tylko do bezpiecznych katalogow, jak wyzej.

## 6. Prompt coding agenta

Utworz `src/mastra/prompts/coding/base.md`.

Tresciowo:

```md
# Coding Agent

Jestes lokalnym agentem developerskim dla repo GastroBridge / Agentic Agents.

## Zasady

- Pracujesz tylko w skonfigurowanym workspace repo.
- Najpierw czytasz kod i szukasz kontekstu, potem edytujesz.
- Nie zgadujesz API. Sprawdz pliki, typy, importy i lokalne wzorce.
- Preferuj male, odwracalne zmiany.
- Nie usuwasz zmian uzytkownika.
- Przed edycja pliku zawsze go przeczytaj.
- Po zmianach uruchom najtansza sensowna weryfikacje:
  - TypeScript: `npx tsc --noEmit`
  - testy/lint tylko jesli dotycza zmiany.
- Jesli komenda wymaga approval, popros o zgode i nie obchodz zabezpieczen.
- Nie wykonuj `git reset`, `git clean`, `rm`, `git push`, deploy ani migracji DB bez approval.

## Styl pracy

1. Zidentyfikuj pliki.
2. Przeczytaj minimalny potrzebny kontekst.
3. Zaproponuj krotki plan.
4. Edytuj.
5. Uruchom weryfikacje.
6. Podsumuj:
   - zmienione pliki,
   - wynik testow,
   - ryzyka,
   - nastepny krok.

## Narzedzia workspace

- `find_files` do listowania.
- `search_content` do szukania.
- `view` do czytania.
- `write_file` do edycji.
- `execute_command` do testow i diagnostyki.
- `lsp_inspect` do symboli, definicji i typow.
```

## 7. `codingAgent`

Utworz `src/mastra/agents/coding-agent.ts`.

Szkic:

```ts
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { loadPrompt } from '../lib/prompt-loader.js';
import { codeWorkspace } from '../workspaces/code-workspace.js';
import { workflowModels } from '../config/workflow-models.js';

export const codingAgent = new Agent({
  id: 'coding-agent',
  name: 'Coding Agent',
  instructions: await loadPrompt('coding/base'),
  model: workflowModels.coding.default,
  workspace: codeWorkspace,
  memory: new Memory({
    options: {
      lastMessages: 20,
    },
  }),
});
```

Wazne:

- Nie dodawaj starych `terminal-tools.ts`.
- Nie dawaj agentowi Gmail/CRM/n8n, chyba ze osobna potrzeba.
- Ten agent ma byc skoncentrowany na repo.

## 8. `codeReviewAgent`

Utworz `src/mastra/prompts/coding/review.md`.

```md
# Code Review Agent

Jestes rygorystycznym reviewerem.

Priorytety:

1. Bugi i regresje.
2. Bezpieczenstwo.
3. Brakujace testy.
4. Niezgodnosc ze stylem repo.
5. Nadmierny zakres zmian.

Nie przepisuj calego rozwiazania, jesli nie trzeba.
Zwracaj wynik po polsku.

Format:

## Findings
- [severity] file:line - opis problemu i konsekwencja

## Test gaps
- ...

## Verdict
approve | needs_changes | block
```

Utworz `src/mastra/agents/code-review-agent.ts`.

```ts
import { Agent } from '@mastra/core/agent';
import { loadPrompt } from '../lib/prompt-loader.js';
import { workflowModels } from '../config/workflow-models.js';

export const codeReviewAgent = new Agent({
  id: 'code-review-agent',
  name: 'Code Review Agent',
  instructions: await loadPrompt('coding/review'),
  model: workflowModels.coding.review,
});
```

Na start review agent nie musi miec workspace. Wystarczy, ze workflow poda mu diff i wyniki testow. Pozniej mozna mu dac read-only workspace.

## 9. Rejestracja agentow

W `src/mastra/index.ts`:

Dodaj importy:

```ts
import { codingAgent } from './agents/coding-agent';
import { codeReviewAgent } from './agents/code-review-agent';
```

Dodaj do `agents`:

```ts
agents: {
  // ...
  codingAgent,
  codeReviewAgent,
}
```

Opcjonalnie:

- usun globalny `workspace` z `new Mastra({ ... })`, jesli nie jest uzywany,
- albo zmien globalny workspace na repo, ale bezpieczniej jest miec workspace agent-specific.

Nie rekomenduje globalnego workspace jako glownego mechanizmu dla wszystkich agentow, bo marketing/sales/analytics nie potrzebuja terminala do repo.

## 10. Integracja z meta-agentem

### 10.1 Usunac albo ograniczyc legacy terminal tools

W `src/mastra/agents/meta-agent.ts` obecnie w `ToolSearchProcessor` sa:

```ts
readFileTool,
writeFileTool,
shellExecuteTool,
```

Docelowo:

- usun je z meta-agenta,
- albo zostaw tylko jako `legacy sandbox`, ale zmien opisy promptu, zeby meta-agent nie uzywal ich do repo.

Rekomendacja: usunac z poola meta-agenta, zeby nie mylil `/tmp/sandbox-Jarvis` z prawdziwym repo.

### 10.2 Dodac delegacje coding taskow

`system.delegate_task` musi wspierac `codingAgent`.

Sprawdz `src/mastra/tools/system/delegate-task.ts`.

Dodaj `codingAgent` do enum/listy targetow i routingu.

Opis:

```txt
codingAgent -> lokalna praca na repo, czytanie/edycja plikow, testy, build, LSP, przygotowywanie patchy.
codeReviewAgent -> review diffu, ryzyka, brakujace testy.
```

W `src/mastra/prompts/meta/base.md` dodaj do tabeli ekspertow:

```md
| `codingAgent` | Praca na lokalnym repo: analiza kodu, poprawki, testy, LSP | Workspace repo, terminal z approval |
| `codeReviewAgent` | Review diffu i ryzyk technicznych | Read-only review |
```

Dodaj regule:

```md
Jesli user prosi o prace na kodzie/repo/testach/terminalu, deleguj do `codingAgent`.
Nie uzywaj legacy `shell.execute` do repo.
```

## 11. Approval policy

### 11.1 Bez approval

Mozna wykonywac:

```txt
pwd
ls
find
rg
sed -n
cat
head
tail
wc
git status
git diff
git log
git show
npx tsc --noEmit
npm test
npm run test
npm run lint
npm run build
```

### 11.2 Approval wymagany

Wymagaj approval dla:

```txt
npm install
pnpm install
npm update
git commit
git push
git pull
git merge
git rebase
docker compose up/down
mastra start/dev jezeli uruchamia dlugi proces
migracje DB
skrypty dotykajace produkcyjnych danych
deploy
```

### 11.3 Zawsze blokuj albo wymagaj bardzo mocnego approval

```txt
rm
rm -rf
git reset
git clean
git checkout --
git push --force
chmod -R
chown -R
dropDatabase
docker system prune
```

### 11.4 Edycje plikow

MVP:

- kazdy `write_file` wymaga approval,
- `requireReadBeforeWrite: true`.

Po ustabilizowaniu:

- mozna pozwolic bez approval na edycje plikow w `ideas/`, `scratch/`, test fixtures,
- kod produkcyjny `src/` dalej approval albo approval tylko przy pierwszym zapisie w danym turnie.

## 12. Repo maintenance workflow

Dodaj `src/mastra/workflows/dev/repo-maintenance.ts`.

Cel:

- samodzielna naprawa problemow po logach/testach,
- ale z approval przed zapisem finalnym, commitem albo restartem.

Input:

```ts
z.object({
  issue: z.string(),
  logs: z.string().optional(),
  failingCommand: z.string().optional(),
  allowedScope: z.array(z.string()).optional(),
  autoApply: z.boolean().default(false),
})
```

Kroki:

1. `collect-context`
   - `codingAgent` szuka plikow i zbiera kontekst.
   - Output: podejrzane pliki, hipotezy, plan.

2. `diagnose`
   - `codingAgent` analizuje logi i kod.
   - Output: root cause, minimal patch plan.

3. `prepare-patch`
   - `codingAgent` edytuje pliki.
   - Jesli `write_file` ma approval, Studio pokaze approval card.

4. `verify`
   - uruchom:
     - `npx tsc --noEmit`,
     - testy specyficzne dla zmiany,
     - ewentualnie lint/build.
   - Output: status, raw logs skrocone do istotnych fragmentow.

5. `review`
   - pobierz `git diff`.
   - `codeReviewAgent` ocenia diff + test output.
   - Output: `approve | needs_changes | block`.

6. `repair-loop`
   - jezeli `needs_changes`, wroc do `prepare-patch`.
   - max 3 iteracje.

7. `human-approval`
   - workflow `suspend()` przed:
     - commitem,
     - pushem,
     - restartem,
     - deployem,
     - migracja DB.

8. `finalize`
   - po approval wykonaj tylko zatwierdzone akcje.

Pseudokod suspend step:

```ts
const humanApprovalStep = createStep({
  id: 'human-approval',
  inputSchema: z.object({
    summary: z.string(),
    diff: z.string(),
    tests: z.string(),
  }),
  suspendSchema: z.object({
    summary: z.string(),
    diff: z.string(),
    tests: z.string(),
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),
  outputSchema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      return await suspend(inputData);
    }
    return {
      approved: resumeData.approved,
      feedback: resumeData.feedback,
    };
  },
});
```

Mastra zapisuje snapshot workflow przy `suspend()`, wiec run mozna wznowic po restarcie.

## 13. Self-healing system

Self-healing nie powinien znaczyc "agent sam deployuje poprawke".

Bezpieczny self-healing:

1. Trigger:
   - blad workflow,
   - failing trace,
   - test failure,
   - blad z logow terminala,
   - reczny request usera.

2. Agent robi:
   - diagnoze,
   - patch,
   - test,
   - review.

3. Agent NIE robi bez approval:
   - commit,
   - push,
   - deploy,
   - restart produkcji,
   - migracja danych.

4. Agent zapisuje wynik:
   - `reports` albo `shared_memory`,
   - `lesson_learned`,
   - link do diffu/trace.

### 13.1 Kolekcja Mongo na zadania naprawcze

Dodaj kolekcje `maintenance_tasks`:

```ts
{
  id: string,
  status: 'new' | 'diagnosing' | 'patching' | 'testing' | 'reviewing' | 'waiting_approval' | 'done' | 'failed',
  source: 'manual' | 'trace' | 'workflow' | 'test' | 'log',
  issue: string,
  logs?: string,
  suspectedFiles?: string[],
  changedFiles?: string[],
  testCommand?: string,
  testResult?: string,
  reviewVerdict?: 'approve' | 'needs_changes' | 'block',
  createdAt: string,
  updatedAt: string
}
```

### 13.2 Automatyczne lessons

Po udanej naprawie:

```ts
shared_memory.push_signal({
  type: 'lesson_learned',
  data: {
    task_pattern: 'repo maintenance failure fix',
    lesson: 'Co bylo przyczyna, jak wykryto, jaki patch zadzialal.',
    changedFiles: [...]
  },
  ttlHours: 720
})
```

## 14. GitHub i lokalny git

Rozdziel te dwie rzeczy:

- Workspace/local sandbox = lokalne pliki, lokalny git, testy.
- GitHub MCP/API = issue, PR, CI, review comments, remote branches.

MVP nie wymaga GitHub MCP.

Kolejnosc:

1. Najpierw lokalny `codingAgent`.
2. Potem workflow `repo-maintenance`.
3. Potem GitHub MCP albo GitHub app:
   - create PR,
   - read review comments,
   - check CI,
   - comment on PR.

Nie rob commit/push w pierwszej wersji. Najpierw pokazuj diff i testy.

## 15. Scorery i guardrails

Dodaj scorer `codingPatchCompletenessScorer`.

Plik:

```txt
src/mastra/scorers/coding-agent-scorer.ts
```

Sprawdzaj:

- czy agent przeczytal pliki przed edycja,
- czy uruchomil test/tsc,
- czy nie wykonal blokowanej komendy,
- czy final zawiera liste zmienionych plikow,
- czy nie zmienil plikow spoza scope.

Dodaj do `src/mastra/index.ts` w `scorers`.

## 16. Minimalny MVP

Zakres pierwszego PR:

1. `code-workspace.ts`
2. `coding-agent.ts`
3. `coding/base.md`
4. rejestracja `codingAgent` w `index.ts`
5. rozszerzenie `workflow-models.ts`
6. meta prompt update z informacja, ze coding idzie przez `codingAgent`
7. usuniecie legacy terminal tools z meta-agent ToolSearchProcessor albo jasne oznaczenie ich jako legacy sandbox

Nie rob jeszcze:

- self-healing workflow,
- GitHub MCP,
- commit/push automation,
- remote sandbox.

Acceptance criteria MVP:

- W Mastra Studio widac `codingAgent`.
- Agent potrafi:
  - `find_files`,
  - `search_content`,
  - `view`,
  - `lsp_inspect`,
  - `execute_command: npx tsc --noEmit`.
- Proba wykonania `npm install` pokazuje approval.
- Proba `rm -rf` nie wykonuje sie bez approval.
- Agent potrafi zrobic mala zmiane w `ideas/*.md`.
- Edycja wymaga read-before-write.
- `npx tsc --noEmit` przechodzi po dodaniu agenta.

## 17. Drugi etap

Zakres drugiego PR:

1. `code-review-agent.ts`
2. `coding/review.md`
3. `repo-maintenance.ts`
4. `maintenance_tasks` indexes w `init-db.ts`
5. workflow registration w `index.ts`
6. meta prompt: "dla awarii kodu uruchom repo-maintenance"

Acceptance criteria:

- Workflow przyjmuje log bledu i znajduje podejrzane pliki.
- Przygotowuje patch.
- Uruchamia `npx tsc --noEmit`.
- Pobiera `git diff`.
- `codeReviewAgent` zwraca verdict.
- Workflow zatrzymuje sie na `suspend()` przed finalizacja.

## 18. Trzeci etap

Zakres:

- GitHub MCP/app integration,
- PR creation,
- CI check,
- review comments loop,
- optional branch management.

Approval wymagany dla:

- commit,
- push,
- PR open,
- merge,
- rerun CI,
- deploy.

## 19. Ryzyka

### 19.1 Agent nadpisze zmiany usera

Mitigacja:

- `requireReadBeforeWrite`,
- przed finalem `git diff --name-only`,
- zakaz `git checkout --`,
- zakaz `git reset`,
- final summary z lista plikow.

### 19.2 Agent uruchomi dlugi proces

Mitigacja:

- timeouty,
- approval dla `npm run dev`, `mastra dev`, `docker compose up`,
- uzycie background process manager dopiero w pozniejszym etapie.

### 19.3 Agent przeczyta sekrety

Mitigacja:

- nie indeksowac `.env`,
- prompt: nie czytac secrets bez wyraznej prosby,
- `SensitiveDataFilter` juz jest w observability,
- najlepiej dodac workspace exclude/allowed policy jesli dostepna w uzywanej wersji.

### 19.4 Agent sam naprawia wlasny runtime i psuje Mastrę

Mitigacja:

- self-healing robi patch + test + review,
- deploy/restart tylko po approval,
- zostawic mozliwosc recznego revertu przez czlowieka.

## 20. Test manualny po wdrozeniu

Po restarcie Mastry:

1. Zapytaj `codingAgent`:

```txt
Pokaż strukturę repo i znajdź plik definicji meta-agenta.
```

Oczekiwane:

- uzywa `find_files` albo `search_content`,
- znajduje `src/mastra/agents/meta-agent.ts`.

2. Zapytaj:

```txt
Uruchom npx tsc --noEmit.
```

Oczekiwane:

- wykonuje bez approval,
- zwraca status i istotny output.

3. Zapytaj:

```txt
Zmień literówkę w ideas/codding-agent.md.
```

Oczekiwane:

- najpierw czyta plik,
- prosi o approval dla write,
- po approval zapisuje.

4. Zapytaj:

```txt
Uruchom npm install lodash.
```

Oczekiwane:

- prosi o approval,
- nie wykonuje bez approval.

5. Zapytaj:

```txt
Usuń node_modules przez rm -rf node_modules.
```

Oczekiwane:

- blokuje albo wymaga bardzo jawnego approval,
- rekomenduje bezpieczniejsza alternatywe.

## 21. Decyzje projektowe

Rekomendowane decyzje:

- Meta-agent zostaje orkiestratorem.
- Coding agent dostaje workspace.
- Review agent jest osobny.
- Terminal legacy zostaje tylko dla izolowanych eksperymentow albo zostaje usuniety z meta-agent pool.
- Self-healing przygotowuje poprawki, ale nie deployuje bez czlowieka.
- GitHub MCP dopiero po lokalnym MVP.

## 22. Zrodla

Mastra Workspaces:

```txt
https://mastra.ai/blog/announcing-mastra-workspaces
```

Mastra LSP inspection:

```txt
https://mastra.ai/blog/lsp-inspection-for-mastra-workspaces
```

Mastra human-in-the-loop / approval placement:

```txt
https://mastra.ai/blog/hitl-where-to-put-approval-in-agents-and-workflows
```

Mastra suspend/resume:

```txt
https://mastra.ai/docs/workflows/suspend-and-resume
```


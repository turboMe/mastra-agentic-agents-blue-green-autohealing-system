# 7.6 Agent Evaluation Dashboard — Plan Implementacji

> **Status:** 📋 Plan szczegółowy | **Data:** 2026-05-09
> **Wykonalność:** ✅ TAK, w pełni realne — mamy ~70% fundamentów
> **Estymacja:** 4-6 dni roboczych dla MVP

---

## TL;DR — Czy to możliwe?

**TAK, w 100% wykonalne.** Cały szkielet infrastruktury już istnieje:
- ✅ `agent_events` collection ma już `status`, `durationMs`, `model`, `tokenUsage`
- ✅ `BudgetTracker` zlicza requesty per provider/model
- ✅ `registerApiRoute()` działa — możemy dodać `/api/dashboard/*` bez patchowania Mastra
- ✅ MongoDB 7.0+ wspiera `$percentile` (latency P50/P95/P99)
- ⚠️ Brakuje: persystencji wyników scorerów, mappingu skill→event, kalkulacji USD, prostego UI

**Co NIE działa od razu:** Mastra Studio (UI na localhost:4111) jest read-only. Nie da się dodać własnego panelu bez forkowania. Rozwiązanie: **osobny dashboard** jako statyczny HTML/React serwowany przez Mastra (nie wymaga osobnego serwera).

---

## Co JUŻ mamy (audyt fundamentów)

### ✅ `agent_events` — solidna baza danych telemetry
Plik: `src/mastra/lib/agent-event-log.ts`
- 23 typy eventów: `task_started`, `task_completed`, `task_failed`, `tool_called`, `tool_error`, `delegation`, `retry_*`, `autoheal_*`, `lesson_learned`, `skill_used`, `approval_*`
- Pola gotowe do agregacji: `agentId`, `taskId`, `model`, `status`, `durationMs`, `tokenUsage` (prompt + completion)
- Indeksy: `(type, timestamp)`, `(agentId, timestamp)`, `(taskId)` — wystarczą do query'ów dashboardowych
- Helper `queryAgentEvents()` z filtrami
- TTL 30 dni — wystarcza dla "ostatnich N dni" widoku

### ✅ `BudgetTracker` — model usage
Plik: `src/mastra/services/budget-tracker.ts`
- Liczy: `requests`, `totalTokens`, `byModel` per provider
- Daily reset, in-memory state
- Już eksponowany przez `/deploy/cloud-free-status`

### ✅ Mastra observability framework
- `@mastra/observability` z DefaultExporter + CloudExporter
- DuckDBStore podpięty jako `observability` storage
- **Niewykorzystywany** — pole gotowe do wypełnienia metrykami

### ✅ API routes infrastructure
- `registerApiRoute()` z Mastra Core
- Już istnieją: `/deploy/health`, `/deploy/gpu-status`, `/deploy/model-status`, `/deploy/cloud-free-status`

---

## Co BRAKUJE (gap analysis)

| Wymaganie z planu | Stan obecny | Brakuje |
|-------------------|-------------|---------|
| Success rate per agent | `agent_events.status` istnieje | Pre-computed aggregation endpoint |
| Success rate per skill | `skill_used` event istnieje | Skill ID nie jest poprawnie linkowany z task outcome |
| Model usage breakdown | `model` w events + BudgetTracker | Brak per-agent × per-model crosstab |
| Cost per task | Tokeny ✅, **USD ❌** | Token→USD pricing table + kalkulator |
| Latency percentiles (P50/P95/P99) | `durationMs` ✅ | Aggregation pipeline z `$percentile` |
| **Scorer results** | Scorery są zarejestrowane, ale wyniki **nie są persystowane** 🔴 KRYTYCZNE | Nowa kolekcja `eval_results` + hook do scorer execution |
| Dashboard UI | Brak | Statyczny React (Vite) lub HTML+htmx |

---

## Architektura proponowanego rozwiązania

```
┌─────────────────────────────────────────────────────────────┐
│  DATA LAYER (MongoDB)                                        │
│  ├─ agent_events (already exists, 30-day TTL)                │
│  ├─ eval_results (NEW — scorer outputs)                      │
│  ├─ model_pricing (NEW — token→USD reference table)          │
│  └─ tasks (already exists)                                   │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ aggregation pipelines
                            │
┌─────────────────────────────────────────────────────────────┐
│  AGGREGATION LAYER (TS services)                             │
│  ├─ services/dashboard-stats.ts (NEW)                        │
│  │   ├─ getAgentSuccessRates(window)                         │
│  │   ├─ getSkillUsageStats(window)                           │
│  │   ├─ getModelBreakdown(window)                            │
│  │   ├─ getLatencyPercentiles(window)                        │
│  │   └─ getCostBreakdown(window)                             │
│  └─ services/cost-calculator.ts (NEW — token×price→USD)      │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │
┌─────────────────────────────────────────────────────────────┐
│  API LAYER (Mastra apiRoutes)                                │
│  ├─ GET /api/dashboard/agents          (success rates)       │
│  ├─ GET /api/dashboard/skills          (skill usage)         │
│  ├─ GET /api/dashboard/models          (model breakdown)     │
│  ├─ GET /api/dashboard/latency         (P50/P95/P99)         │
│  ├─ GET /api/dashboard/cost            (cost analysis)       │
│  ├─ GET /api/dashboard/timeline        (events over time)    │
│  └─ GET /dashboard                     (static HTML UI)      │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ fetch
                            │
┌─────────────────────────────────────────────────────────────┐
│  UI LAYER (statyczny Vite/React build, serwowany przez Mastra) │
│  ├─ Dashboard.tsx (overview + filters)                       │
│  ├─ AgentStatsCard, SkillUsageChart, ModelPie, LatencyHist   │
│  └─ CostTrendLine, RecentTasksTable                          │
└─────────────────────────────────────────────────────────────┘

PLUS: Tool `system.agent_performance_report` — zwraca JSON do agentów,
żeby meta-agent mógł sam analizować swoje performance.
```

---

## Etap 1 — Persystencja scorerów (1.5 dnia) 🔴 KRYTYCZNE

**Cel:** Bez tego nie mamy success rates per skill ani jakości odpowiedzi.

### 1.1 Nowa kolekcja `eval_results`
Schema:
```typescript
interface EvalResult {
  evalId: string;           // UUID
  timestamp: Date;
  agentId: string;
  taskId?: string;
  scorerId: string;         // np. 'tool-call-appropriateness'
  score: number;            // 0.0 - 1.0
  threshold?: number;       // próg "passed"
  passed: boolean;
  details?: Record<string, unknown>;  // breakdown z scorera
  model?: string;
  expiresAt: Date;          // 30-day TTL
}
```

Dodać indeksy w `lib/mongo.ts → ensureIndexes()`:
- `(scorerId, timestamp)` 
- `(agentId, timestamp)`
- `(taskId)`
- `(expiresAt)` z `expireAfterSeconds: 0`

### 1.2 Helper `lib/eval-results.ts`
```typescript
export async function logEvalResult(result: Omit<EvalResult, 'evalId' | 'timestamp' | 'expiresAt'>): Promise<void>
export async function queryEvalResults(filters: { agentId?, scorerId?, since?, limit? }): Promise<EvalResult[]>
```

### 1.3 Hook do Mastra scorers
Mastra evaluuje scorery przez `scorers: { ... }` przy agencie. Trzeba:
- Sprawdzić czy Mastra emituje event po wyliczeniu score'a (prawdopodobnie tak — `@mastra/observability`)
- Albo: wrapper `withEvalLogging(scorer)` który po `evaluate()` zapisuje wynik
- Zarejestrować wrapper w każdym agencie zamiast surowego scorera

### 1.4 Walidacja
- Wywołać agenta, sprawdzić czy `eval_results` ma nowe rekordy
- Sprawdzić TTL działa (insert + setTimeout test)

---

## Etap 2 — Cost Calculator + Pricing Table (0.5 dnia)

### 2.1 Kolekcja `model_pricing`
```typescript
interface ModelPricing {
  model: string;            // np. 'claude-sonnet-4-6', 'gpt-4o'
  provider: string;
  inputCostPer1M: number;   // USD
  outputCostPer1M: number;  // USD
  effectiveFrom: Date;
  effectiveTo?: Date;
}
```

Seed wartości dla głównych modeli:
- Claude Sonnet 4.6: $3 / $15 per 1M
- Claude Opus 4.7: $15 / $75 per 1M  
- Claude Haiku 4.5: $1 / $5 per 1M
- GPT-4o: $2.50 / $10 per 1M
- Gemini 2.5 Pro: $1.25 / $5 per 1M
- Local Ollama (qwen3:4b itd.): $0 / $0

### 2.2 `services/cost-calculator.ts`
```typescript
export async function calculateCost(model: string, promptTokens: number, completionTokens: number): Promise<number>
export async function aggregateCostByAgent(window: TimeWindow): Promise<{ agentId, totalUsd }[]>
```

Cache pricing in memory (TTL 1h).

---

## Etap 3 — Aggregation Service (1 dzień)

`services/dashboard-stats.ts` — wszystkie funkcje agregujące.

### Przykładowy pipeline: latency percentiles
```typescript
export async function getLatencyPercentiles(window: TimeWindow): Promise<{
  agentId: string;
  p50: number; p95: number; p99: number;
  count: number;
}[]> {
  const db = await getDb();
  return db.collection('agent_events').aggregate([
    { $match: { type: 'task_completed', timestamp: { $gte: window.from, $lt: window.to } } },
    { $group: {
      _id: '$agentId',
      latencies: { $push: '$durationMs' },
      count: { $sum: 1 }
    }},
    { $project: {
      agentId: '$_id',
      count: 1,
      percentiles: { $percentile: { input: '$latencies', p: [0.5, 0.95, 0.99], method: 'approximate' } }
    }},
    { $project: {
      agentId: 1, count: 1,
      p50: { $arrayElemAt: ['$percentiles', 0] },
      p95: { $arrayElemAt: ['$percentiles', 1] },
      p99: { $arrayElemAt: ['$percentiles', 2] },
    }}
  ]).toArray();
}
```

### Funkcje do zaimplementowania:
- `getAgentSuccessRates(window)` — `task_completed` / (`task_completed` + `task_failed`) per agentId
- `getSkillUsageStats(window)` — count `skill_used` per skillId, plus avg eval score (join z `eval_results`)
- `getModelBreakdown(window)` — count + tokens + cost per model
- `getLatencyPercentiles(window)` — jak wyżej
- `getCostBreakdown(window)` — total USD per agent, per model, per day
- `getTimelineEvents(window, granularity)` — bucket-by-hour count of events per type

---

## Etap 4 — API Routes (0.5 dnia)

W `src/mastra/index.ts` dodać:
```typescript
import { registerApiRoute } from '@mastra/core/server';
import * as stats from './services/dashboard-stats.js';

apiRoutes: [
  // ... existing routes
  registerApiRoute('/api/dashboard/agents', { method: 'GET', handler: async (c) => {
    const window = parseTimeWindow(c.req.query());
    return c.json(await stats.getAgentSuccessRates(window));
  }}),
  registerApiRoute('/api/dashboard/skills', { method: 'GET', handler: ... }),
  registerApiRoute('/api/dashboard/models', { method: 'GET', handler: ... }),
  registerApiRoute('/api/dashboard/latency', { method: 'GET', handler: ... }),
  registerApiRoute('/api/dashboard/cost', { method: 'GET', handler: ... }),
  registerApiRoute('/api/dashboard/timeline', { method: 'GET', handler: ... }),
]
```

Query params: `?from=2026-05-01&to=2026-05-09&agentId=meta-agent`

---

## Etap 5 — Tool dla agentów (0.5 dnia)

`tools/system/agent-performance-report.ts`:
```typescript
export const agentPerformanceReportTool = createTool({
  id: 'system.agent_performance_report',
  description: 'Generuje raport wydajności agentów: success rate, model usage, koszt, latency. Używaj gdy user pyta "jak działa system", "który agent jest najwolniejszy", "ile wydaliśmy".',
  inputSchema: z.object({
    since: z.string().describe('ISO date (e.g. "2026-05-01") lub względny ("7d", "24h")'),
    agentId: z.string().optional(),
    includeBreakdown: z.array(z.enum(['agents', 'skills', 'models', 'latency', 'cost'])).optional().default(['agents', 'cost'])
  }),
  outputSchema: z.object({
    success: z.boolean(),
    period: z.object({ from: z.string(), to: z.string() }),
    summary: z.object({
      totalTasks: z.number(),
      successRate: z.number(),
      totalCostUsd: z.number(),
      avgLatencyMs: z.number(),
    }),
    breakdown: z.record(z.string(), z.unknown()),
    error: z.string().optional(),
  }),
  execute: async (ctx) => {
    // Wywołuje funkcje z services/dashboard-stats.ts
  }
});
```

Zarejestrować w meta-agencie i analytics-agencie.

---

## Etap 6 — UI Dashboard (1.5 dnia)

### 6.1 Stack
- **Vite + React + TypeScript** (osobny build w `dashboard/`)
- **Recharts** dla wykresów (lightweight, ~100kb)
- **Tailwind CSS** dla stylowania
- Build output → `dist/dashboard/` → serwowany przez Mastra jako static files

### 6.2 Strony i komponenty
```
dashboard/
├── index.html
├── src/
│   ├── App.tsx (routing + filters bar)
│   ├── components/
│   │   ├── AgentStatsCard.tsx     (success rate + tasks count per agent)
│   │   ├── SkillUsageChart.tsx    (bar chart top-10 skills)
│   │   ├── ModelBreakdownPie.tsx  (pie chart usage)
│   │   ├── LatencyHistogram.tsx   (P50/P95/P99 per agent)
│   │   ├── CostTrendLine.tsx      (USD per day)
│   │   ├── EventTimeline.tsx      (events/hour stacked area)
│   │   └── RecentTasksTable.tsx   (last 50 tasks z drill-down)
│   ├── api.ts                     (fetch z /api/dashboard/*)
│   └── filters.tsx                (date range, agent picker)
└── vite.config.ts
```

### 6.3 Serwowanie z Mastra
Dwa warianty:

**Wariant A (rekomendowany):** static asset route
```typescript
import { serveStatic } from '@hono/node-server/serve-static';
apiRoutes: [
  registerApiRoute('/dashboard/*', { method: 'GET', handler: serveStatic({ root: './dist/dashboard' }) }),
]
```

**Wariant B:** osobny port (Next.js dev server podczas dev, deploy razem)

### 6.4 Filters bar
- Date range picker (7d/30d/custom)
- Agent multi-select
- Auto-refresh toggle (15s polling)

---

## Etap 7 — Dokumentacja + skill (0.5 dnia)

### 7.1 Skill `_skills/meta/agent-performance-analysis.md`
Jak analizować performance system'u, jak interpretować metryki, kiedy alarmować.

### 7.2 Dokumentacja `docs/AGENT-EVALUATION-DASHBOARD.md`
- Architektura
- Jak dodać nowy scorer
- Jak rozszerzyć dashboard o nowy wykres
- Disaster recovery (co jeśli `eval_results` urośnie?)

---

## Definicja ukończenia (Acceptance Criteria)

- [ ] Kolekcja `eval_results` istnieje, scorery zapisują wyniki automatycznie
- [ ] Kolekcja `model_pricing` zaseedowana 6+ modelami
- [ ] 6 endpointów API zwraca poprawne dane
- [ ] Tool `system.agent_performance_report` działa i jest w meta + analytics agentach
- [ ] Dashboard widoczny pod `/dashboard`, pokazuje:
  - [ ] Success rate per agent (bar chart)
  - [ ] Top 10 skills (bar chart) 
  - [ ] Model usage (pie chart)
  - [ ] Latency P50/P95/P99 (histogram per agent)
  - [ ] Cost trend (line chart, USD/day)
- [ ] Filtry: date range, agent picker
- [ ] Auto-refresh (15s)
- [ ] Dokumentacja + skill napisane
- [ ] TypeScript: ✅ czysty
- [ ] Smoke test: 1 dzień produkcyjnego użycia, dashboard pokazuje sensowne dane

---

## Ryzyka i mitigacje

| Ryzyko | Mitigacja |
|--------|-----------|
| `agent_events` rośnie szybko (>100k/dzień) | TTL 30 dni już jest; rozważyć rollup do `agent_events_daily` |
| `$percentile` wymaga MongoDB 7.0+ | Sprawdzić wersję — fallback: liczyć w aplikacji |
| Brak wszystkich modeli w `model_pricing` | Default fallback 0 USD + warning w logach |
| Mastra scorers nie emitują eventu | Plan B: wrapper scorera z manualnym `logEvalResult` |
| Cost dla local Ollama = 0 zaniża analizy | Dodać kolumnę `localGpuTimeMs` do alternatywnego "kosztu" |
| UI: refresh co 15s + 6 endpointów = obciążenie | Cache wyniki agregacji w Redis/memory na 60s |

---

## Estymacja czasowa

| Etap | Czas | Krytyczność |
|------|------|-------------|
| 1. Eval persistence | 1.5 dnia | 🔴 Krytyczne |
| 2. Cost calculator | 0.5 dnia | 🟡 Ważne |
| 3. Aggregation service | 1 dzień | 🔴 Krytyczne |
| 4. API routes | 0.5 dnia | 🔴 Krytyczne |
| 5. Tool dla agentów | 0.5 dnia | 🟡 Ważne |
| 6. UI Dashboard | 1.5 dnia | 🟢 Nice-to-have (start z agent tool) |
| 7. Dokumentacja | 0.5 dnia | 🟡 Ważne |
| **TOTAL MVP** | **~5 dni** | |
| **TOTAL bez UI** | **~3.5 dnia** | |

---

## Sugerowana kolejność wdrażania

1. **Sprint 1 (MVP "data-only"):** Etapy 1-4 + 5 (3.5 dnia)
   - Po tym: meta-agent może odpowiadać na pytania "jak działają agenci" przez tool
   - API gotowe do konsumpcji przez dowolny UI
   - **Już można pisać do produkcji.**

2. **Sprint 2 (Visual UI):** Etap 6 (1.5 dnia)
   - Po tym: pełny dashboard pod `/dashboard`

3. **Sprint 3 (Polish):** Etap 7 + iteracje na podstawie real usage (0.5 dnia)

---

## Quick wins przed pełną implementacją

Już TERAZ można zrobić w 30 min, bez czekania na pełny dashboard:

```typescript
// W tools/system/agent-performance-report.ts (uproszczony tool)
// — używa tylko już istniejących danych:
// agent_events.status, durationMs, model, tokenUsage

const stats = await db.collection('agent_events').aggregate([
  { $match: { timestamp: { $gte: since } } },
  { $group: {
    _id: '$agentId',
    total: { $sum: 1 },
    completed: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
    failed: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
    avgDuration: { $avg: '$durationMs' },
    totalTokens: { $sum: '$tokenUsage.total' }
  }}
]).toArray();
```

Da to: success rate per agent, avg latency, token usage — bez scorers i bez UI.
**To jest realny minimal MVP zrobiony w pół dnia.**

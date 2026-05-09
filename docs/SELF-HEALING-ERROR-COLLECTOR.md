# Etap 7: Self-Healing — Error Collector & Auto-Heal Trigger

Aktualizacja: 2026-05-09

## Cel

Automatyczny "Łowca Błędów" — serwis nasłuchujący wyjątki runtime i automatycznie inicjujący `repo-maintenance-workflow` w celu naprawy kodu.

## Architektura

```
┌──────────────────────────────────────────────────┐
│  Mastra Runtime                                   │
│                                                    │
│  ┌──────────────────┐    ┌──────────────────────┐ │
│  │ Global Error     │───>│  ErrorCollector       │ │
│  │ Handlers         │    │  (singleton)          │ │
│  │ - uncaughtExc.   │    │                       │ │
│  │ - unhandledRej.  │    │  ┌─ hashError()       │ │
│  └──────────────────┘    │  ├─ dedup (Mongo)     │ │
│                          │  ├─ cooldown (60s)    │ │
│  ┌──────────────────┐    │  ├─ max active (3)    │ │
│  │ /deploy/         │───>│  └─ TTL (24h)        │ │
│  │   crash-test     │    └──────────┬───────────┘ │
│  └──────────────────┘              │              │
│                                    ▼              │
│                          ┌──────────────────────┐ │
│                          │ repo-maintenance-wf  │ │
│                          │ (Coding → Review →   │ │
│                          │  Gate → Deploy)       │ │
│                          └──────────────────────┘ │
└──────────────────────────────────────────────────┘
```

## Pliki

| Plik | Opis |
|------|------|
| `src/mastra/services/error-collector.ts` | Serwis ErrorCollector — dedup, cooldown, trigger workflow |
| `src/mastra/services/global-error-handler.ts` | Bootstrap globalnych handlerów `process.on(...)` |
| `src/mastra/index.ts` | Rejestracja handlerów + endpointy crash-test i status |
| `src/mastra/lib/mongo.ts` | Indeksy dla `auto_healing_tickets` |
| `src/mastra/workflows/repo-maintenance.ts` | Integracja ticket cleanup po deploy |

## Kolekcja MongoDB: `auto_healing_tickets`

```json
{
  "ticketId": "heal-a1b2c3d4-1715214000000",
  "errorSignature": "a1b2c3d4e5f6g7h8",
  "errorMessage": "Cannot read property 'value' of undefined",
  "stackTrace": "TypeError: Cannot read...\n    at ...",
  "context": {
    "source": "uncaughtException",
    "origin": "uncaughtException",
    "metadata": { "processUptime": 3600 }
  },
  "status": "pending | in_progress | resolved | failed | expired",
  "workflowRunId": "run-uuid",
  "createdAt": "2026-05-09T01:30:00.000Z",
  "updatedAt": "2026-05-09T01:30:00.000Z",
  "expiresAt": "2026-05-10T01:30:00.000Z"
}
```

### Indeksy

- `ticketId` — unique
- `errorSignature + status` — deduplikacja
- `status + createdAt` — sortowanie aktywnych
- `expiresAt` — TTL (automatyczne usuwanie)

## Mechanizmy bezpieczeństwa

### 1. Deduplikacja

Błąd jest haszowany (`sha256` z `name + message + top 3 stack lines`) na 16-znakową sygnaturę. Jeśli istnieje ticket z tą samą sygnaturą w statusie `pending` lub `in_progress`, nowy workflow NIE jest odpalany.

### 2. Cooldown

Między kolejnymi triggerami workflow musi upłynąć minimum `ERROR_COLLECTOR_COOLDOWN_MS` (domyślnie 60s). Chroni przed lawiną workflow przy kaskadowych błędach.

### 3. Limit aktywnych

Maksymalnie `ERROR_COLLECTOR_MAX_ACTIVE` (domyślnie 3) jednoczesnych ticketów `pending` + `in_progress`. Po przekroczeniu limitu nowe błędy są ignorowane.

### 4. TTL

Tickety automatycznie wygasają po `ERROR_COLLECTOR_TTL_HOURS` (domyślnie 24h) dzięki indeksowi TTL w MongoDB.

### 5. Self-protection

Błędy rzucone wewnątrz samego `ErrorCollector` NIE triggerują kolejnego heal. Flagą `selfProtectionStack` zapobiegamy nieskończonej rekurencji.

### 6. Ticket resolution

Po udanym `deploy-and-verify` w workflow, jeśli `taskId` zaczyna się od `heal-`, ticket jest automatycznie oznaczany jako `resolved`.

## Konfiguracja ENV

| Zmienna | Domyślna | Opis |
|---------|----------|------|
| `ERROR_COLLECTOR_ENABLED` | `true` | Wyłącza cały ErrorCollector |
| `ERROR_COLLECTOR_COOLDOWN_MS` | `60000` | Cooldown między triggerami (ms) |
| `ERROR_COLLECTOR_MAX_ACTIVE` | `3` | Max jednoczesnych ticketów |
| `ERROR_COLLECTOR_TTL_HOURS` | `24` | TTL ticketów (godziny) |

## Endpointy

### `GET /deploy/crash-test`

Symuluje błąd i odpala ErrorCollector. Parametr `?type=TypeError` kontroluje typ błędu.

Odpowiedź:
```json
{
  "crashSimulated": true,
  "healingTriggered": true,
  "reason": "Workflow triggered",
  "ticketId": "heal-a1b2c3d4-1715214000000",
  "timestamp": "2026-05-09T01:30:00.000Z"
}
```

### `GET /deploy/auto-heal-status`

Zwraca aktywne tickety auto-healing.

Odpowiedź:
```json
{
  "activeTickets": 1,
  "tickets": [...],
  "timestamp": "2026-05-09T01:30:00.000Z"
}
```

## Flow E2E

1. Użytkownik uderza w zepsuty endpoint → błąd runtime
2. `process.on('uncaughtException')` łapie wyjątek
3. `GlobalErrorHandler` przekazuje do `ErrorCollector.reportError()`
4. ErrorCollector:
   - Haszuje błąd → sygnatura
   - Sprawdza dedup (Mongo) → brak duplikatu
   - Sprawdza cooldown → OK
   - Sprawdza limit aktywnych → OK
   - Tworzy ticket w `auto_healing_tickets`
   - Fire-and-forget: `repoMaintenanceWorkflow.createRun().start()`
5. Workflow:
   - `codingAgent` diagnozuje i tworzy patch w worktree
   - `codeReviewAgent` reviewuje diff
   - `decision-gate` → suspend na zatwierdzenie przez człowieka
   - Po `resume(confirmMerge: true)` → `apply_patch` + `remove_worktree`
   - `deploy-and-verify` → dry-run build + ticket resolution
6. Człowiek dostaje jedynie: *"Fix gotowy. Proszę o zatwierdzenie."*

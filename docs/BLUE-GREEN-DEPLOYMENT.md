# Etap 6: Blue-Green Deployment dla Self-Healing

Aktualizacja: 2026-05-08

## Problem

Po `apply_patch` (git merge) pliki na dysku się zmieniają, ale uruchomiony proces Node.js
nadal korzysta ze starego kodu w pamięci. Aby nowy kod zaczął działać, trzeba zrestartować Mastrę.

Ryzyka:
- Nowy kod może crashować przy starcie → agent sam się ubił
- Brak mechanizmu automatycznego powrotu do działającej wersji
- Agent nie może naprawić samego siebie jeśli już nie działa

## Architektura Blue-Green

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  LIVE (slot A)              │     │  STAGING (slot B)           │
│  Port: 4111                 │     │  Port: 4222                 │
│  Dir: agentic-agents/       │     │  Dir: agentic-agents-stg/   │
│  Status: AKTYWNY            │     │  Status: TESTOWY            │
│  PID: zapisany w pidfile    │     │  PID: zapisany w pidfile    │
└─────────────────────────────┘     └─────────────────────────────┘
             │                                    │
             │            ┌──────────┐            │
             └────────────│ Deployer │────────────┘
                          │ Script   │
                          └──────────┘
                               │
                        health-check
                        swap portów
                        rollback
```

## Komponenty do zbudowania

### 1. Health-check endpoint (`/health`)
- Zwraca JSON z: status, uptime, version (git SHA), timestamp
- Mastra go serwuje automatycznie (custom server hook lub middleware)
- Plik: `src/mastra/server/health.ts`

### 2. Deploy config (`deploy.config.json`)
- Definicje slotów (A/B), porty, ścieżki, PID files
- Plik: `deploy.config.json`

### 3. Deploy script (`scripts/deploy-blue-green.sh`)
Procedura po zatwierdzonym `apply_patch`:
1. Zbuduj nowy kod w STAGING (`mastra build`)
2. Uruchom STAGING na porcie 4222
3. Czekaj max 30s na health-check
4. Jeśli health OK → zamień porty (STAGING ↔ LIVE)
5. Jeśli health FAIL → `git revert`, wyłącz STAGING, LIVE pozostaje nietkniętą

### 4. Integracja z workflow
- `decision-gate` po `apply_patch` wywołuje deploy script
- Nowy krok `deploy-and-verify` w workflow

## Plan implementacji

- [ ] Krok 1: Health endpoint + deploy config
- [ ] Krok 2: Deploy script (build → start → verify → swap/rollback)
- [ ] Krok 3: Integracja z `repo-maintenance-workflow`
- [ ] Krok 4: Test E2E: workflow → coding → review → merge → deploy → health

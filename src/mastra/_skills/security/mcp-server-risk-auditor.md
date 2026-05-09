---
name: mcp-server-risk-auditor
category: security
description: >-
  Procedura audytu nowych MCP serwerów przed dodaniem do mcp.ts.
  Checklist obejmuje: uprawnienia, ryzyko exfiltracji danych,
  model autoryzacji, jakość kodu, zależności.
keywords: [security, mcp, audit, risk, server, permissions, exfiltration]
allowedTools: [fs.read_file, shell.execute, search_web]
minComplexity: moderate
estimatedTokens: 10000
outputFormat: text
tags: [security, mcp, audit]
version: 1
success_rate: null
total_uses: 0
last_used: null
---
# MCP Server Risk Auditor

## Trigger
Przed dodaniem nowego MCP serwera do `mcp.ts` — OBOWIĄZKOWY audyt.

## Checklist Audytu

### 1. Identyfikacja serwera
- [ ] Nazwa pakietu NPM / GitHub repo
- [ ] Autor / organizacja
- [ ] Licencja (MIT/Apache/GPL?)
- [ ] Ostatnia aktualizacja (> 6 miesięcy = 🔴)
- [ ] Ilość gwiazdek / downloads

### 2. Analiza uprawnień
- [ ] Jakie tools serwer eksponuje?
- [ ] Które tools czytają vs piszą dane?
- [ ] Czy serwer wymaga dostępu do filesystem?
- [ ] Czy serwer wykonuje komendy powłoki?
- [ ] Czy serwer komunikuje się z zewnętrznymi API?

### 3. Ryzyko exfiltracji danych
| Kategoria | Pytanie | Ryzyko |
|-----------|---------|--------|
| Network | Czy serwer wysyła dane do zewnętrznych endpoint'ów? | 🔴 High |
| Filesystem | Czy serwer czyta pliki poza workspace? | 🟡 Medium |
| Env | Czy serwer potrzebuje API keys w env? | 🟡 Medium |
| Persistence | Czy serwer zapisuje dane lokalnie? | 🟢 Low |

### 4. Model autoryzacji
- [ ] Czy serwer wymaga uwierzytelnienia? (API key, OAuth?)
- [ ] Czy token jest scope-limited? (read-only vs full access?)
- [ ] Gdzie przechowywane są credentials? (.env vs hardcoded?)

### 5. Jakość kodu
```bash
# Sprawdź zależności
npm audit --json 2>/dev/null | jq '.vulnerabilities | length'

# Sprawdź licencję zależności
npx license-checker --summary 2>/dev/null
```

### 6. Konfiguracja w mcp.ts
```typescript
// Wzorcowa konfiguracja z ograniczeniami
'new-server': {
  command: 'npx',
  args: ['@scope/server@latest'],
  env: {
    // Tylko wymagane zmienne — NIGDY nie przekazuj wszystkich env
    SERVER_API_KEY: process.env.SERVER_API_KEY,
  },
}
```

## Severity Matrix

| Kombinacja | Ocena | Decyzja |
|------------|-------|---------|
| Network write + no auth | 🔴 Critical | BLOCK |
| Filesystem write + outside workspace | 🔴 Critical | BLOCK |
| Network read + auth | 🟡 Medium | CONFIRM + restrict env |
| Filesystem read + workspace only | 🟢 Low | ALLOW |
| No network + no filesystem | 🟢 Safe | ALLOW |

## Raport końcowy
```markdown
### MCP Server Audit: [nazwa]
- **Ryzyko ogólne:** Low / Medium / High / Critical
- **Uprawnienia:** [lista tools z ocean]
- **Exfiltracja:** [tak/nie + szczegóły]
- **Auth model:** [opis]
- **Rekomendacja:** ALLOW / ALLOW with restrictions / BLOCK
- **Warunki:** [jeśli ALLOW with restrictions]
```

## Success Criteria
- Nowy MCP server ma raport audytu przed merge do `mcp.ts`
- Raport zawiera severity assessment
- Env vars ograniczone do minimum

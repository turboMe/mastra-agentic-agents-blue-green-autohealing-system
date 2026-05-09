---
name: terminal-safety-guard
category: security
description: >-
  Terminal Safety Guard — trzy-warstwowy system zabezpieczeń komend powłoki.
  Przechwytuje komendy bash przed wykonaniem i klasyfikuje je jako:
  BLOCK (natychmiastowe odrzucenie), CONFIRM (wymaga zatwierdzenia),
  lub ALLOW (bezpieczne do wykonania). Chroni przed rm -rf /, fork bombami,
  DROP DATABASE, eksfiltracja SSH keys i innymi niebezpiecznymi operacjami.
keywords: [security, terminal, safety, guard, bash, shell, destructive, command, blocker]
allowedTools: [shell.execute, fs.read_file]
minComplexity: simple
estimatedTokens: 8000
outputFormat: text
tags: [security, terminal, safety, critical]
version: 1
success_rate: null
total_uses: 0
last_used: null
---
# Terminal Safety Guard

> Wzorowane na projektach: [dcg](https://github.com/topics/destructive-command-guard),
> [sh-guard](https://github.com/topics/shell-safety),
> [AgentGuard](https://github.com/topics/agent-security).

## Trigger
Aktywny AUTOMATYCZNIE — każda komenda `shell.execute` przechodzi przez guard.
Nie trzeba wywoływać tego skilla ręcznie.

## Architektura

```
Agent → shell.execute(cmd) → checkCommand(cmd) → Verdict
                                   │
                              ┌────┼────────┐
                              ▼    ▼         ▼
                           BLOCK  CONFIRM   ALLOW
                             │      │         │
                             │      ▼         ▼
                             │   logWarning  execute
                             ▼
                          REJECT + logEvent
```

## Kategorie Reguł

### 🔴 BLOCK (22 reguły) — natychmiastowe odrzucenie
| Kategoria | Przykłady |
|-----------|-----------|
| Filesystem | `rm -rf /`, `dd of=/dev/sda`, `mkfs`, `shred` |
| System | fork bomb `:(){ :|:& };:`, `shutdown`, `kill 1` |
| Database | `DROP DATABASE`, `TRUNCATE TABLE`, `db.dropDatabase()` |
| Network | `curl ... | bash`, `wget ... | sh`, env exfiltration |
| Crypto/Secrets | `cat ~/.ssh/id_rsa`, `cat .env` |
| Permissions | `chmod 777 /`, `chown root /` |

### 🟡 CONFIRM (12 reguł) — wymaga zatwierdzenia
| Kategoria | Przykłady |
|-----------|-----------|
| Filesystem | `rm -r`, `chmod`, `git push --force`, `git reset --hard` |
| System | `sudo`, `systemctl stop`, `docker rm`, `npm install -g` |
| Database | `deleteMany({})`, `updateMany({}, ...)` |
| Network | `curl -X POST`, `iptables` |

### ✅ ALLOW — domyślne
Wszystko co nie pasuje do BLOCK ani CONFIRM.

## Workspace Safe Paths
Operacje na tych ścieżkach mają złagodzone reguły (np. `rm -rf node_modules/` jest OK):
- `/projekty/`
- `/tmp/sandbox*`
- `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`

## Pliki implementacji
- `lib/terminal-safety-guard.ts` — główna logika
- `tools/terminal/terminal-tools.ts` — integracja z `shell.execute`

## Diagnostyka
```typescript
import { getRuleStats } from './terminal-safety-guard.js';
console.log(getRuleStats());
// { blockRules: 22, confirmRules: 12, total: 34 }
```

## Rozszerzanie reguł
Aby dodać nową regułę BLOCK:
```typescript
{
  id: 'my-new-rule',
  pattern: /\bnowa-niebezpieczna-komenda\b/,
  action: 'BLOCK',
  reason: 'Opis dlaczego to jest niebezpieczne',
  category: 'system',  // filesystem | database | network | system | crypto
}
```

## Success Criteria
- Każda komenda `shell.execute` przechodzi przez guard
- 22+ BLOCK patterns aktywne
- Zablokowane komendy logowane w `agent_events`
- False positive rate < 5% (workspace paths dozwolone)

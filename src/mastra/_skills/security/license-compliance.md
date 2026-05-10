---
name: license-compliance
category: security
description: >-
  Sprawdzenie licencji zależności npm przed ich dodaniem do projektu.
  Weryfikuje czy licencja jest kompatybilna z projektem (allowlist/blocklist)
  i generuje raport compliance.
keywords: [security, license, compliance, npm, legal, dependency, audit]
allowedTools: [shell_execute, fs_read_file]
minComplexity: simple
estimatedTokens: 5000
outputFormat: text
tags: [security, license, compliance]
version: 1
success_rate: null
total_uses: 0
last_used: null
---
# License Compliance Check

> Narzędzie: [license-checker](https://github.com/davglass/license-checker)

## Trigger
- Przed dodaniem nowej zależności
- Przed release do produkcji
- Cyklicznie (raz na miesiąc)

## Licencje — Allowlist / Blocklist

### ✅ Dozwolone (Permissive)
- MIT
- Apache-2.0
- BSD-2-Clause, BSD-3-Clause
- ISC
- CC0-1.0
- Unlicense
- 0BSD

### ⚠️ Wymagają przeglądu (Copyleft-weak)
- LGPL-2.1, LGPL-3.0 (OK jeśli linkowane dynamicznie)
- MPL-2.0 (OK jeśli zmiany w pliku źródłowym publiczne)
- CC-BY-4.0

### 🔴 Zablokowane (Copyleft-strong / Restrictive)
- GPL-2.0, GPL-3.0 (wymusza open-source całego projektu)
- AGPL-3.0 (nawet SaaS wymaga open-source)
- SSPL (Server Side Public License)
- CC-BY-NC (no commercial use)
- Proprietary / Unknown

## Procedura

### Step 1: Scan
```bash
npx license-checker --summary 2>/dev/null
```

### Step 2: Znajdź problematyczne
```bash
npx license-checker --excludePackages '' --json 2>/dev/null | jq 'to_entries[] | select(.value.licenses | test("GPL|AGPL|SSPL|Proprietary|UNKNOWN"; "i")) | {package: .key, license: .value.licenses}'
```

### Step 3: Raport
```markdown
## License Compliance Report
- **Packages scanned:** [ilość]
- **Permissive (OK):** [ilość]
- **Review needed:** [ilość]
- **Blocked:** [ilość]

### Action Items
| Package | License | Action |
|---------|---------|--------|
| ... | GPL-3.0 | Replace with alternative |
```

## Success Criteria
- 0 GPL/AGPL packages w produkcyjnym bundle
- Scan run przed każdym nowym `npm install`

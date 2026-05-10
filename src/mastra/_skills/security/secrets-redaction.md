---
name: secrets-redaction
category: security
description: >-
  Secrets Redactor — automatyczna redakcja kluczy API, tokenów, haseł
  i innych wrażliwych danych z logów agentów, promptów i outputów.
  Wykrywa 20+ typów sekretów (OpenAI, Anthropic, Google, AWS, Stripe,
  GitHub, Slack, Telegram, JWT, klucze prywatne) i zamienia na
  [REDACTED:typ-sekretu].
keywords: [security, secrets, redaction, api-key, token, password, sanitization, leak-prevention]
allowedTools: [fs_read_file]
minComplexity: simple
estimatedTokens: 6000
outputFormat: text
tags: [security, secrets, data-protection, critical]
version: 1
success_rate: null
total_uses: 0
last_used: null
---
# Secrets Redaction

> Wzory detekcji oparte na [gitleaks](https://github.com/gitleaks/gitleaks)
> i [detect-secrets](https://github.com/Yelp/detect-secrets).

## Trigger
**AUTOMATYCZNY** — zintegrowane z `agent-event-log.ts`.
Każdy event logowany do MongoDB przechodzi przez redakcję.

## Co jest redaktowane

| Provider | Wzór | Przykład |
|----------|------|---------|
| OpenAI | `sk-proj-*`, `sk-*T3BlbkFJ*` | `sk-proj-abc...xyz` → `[REDACTED:openai-api-key]` |
| Anthropic | `sk-ant-api03-*` | → `[REDACTED:anthropic-api-key]` |
| Google | `AIza*` | → `[REDACTED:google-api-key]` |
| AWS | `AKIA*`, `ASIA*` | → `[REDACTED:aws-access-key]` |
| Stripe | `sk_live_*`, `sk_test_*` | → `[REDACTED:stripe-api-key]` |
| GitHub | `ghp_*`, `gho_*` | → `[REDACTED:github-token]` |
| Slack | `xoxb-*`, `xoxp-*` | → `[REDACTED:slack-token]` |
| Telegram | `123456789:ABC...` | → `[REDACTED:telegram-bot-token]` |
| SendGrid | `SG.*.*` | → `[REDACTED:sendgrid-api-key]` |
| OpenRouter | `sk-or-v1-*` | → `[REDACTED:openrouter-key]` |
| JWT | `eyJ*.eyJ*.*` | → `[REDACTED:jwt-token]` |
| Private Keys | `-----BEGIN * PRIVATE KEY-----` | → `[REDACTED:private-key-block]` |
| Bearer Auth | `Bearer <token>` | → `Bearer [REDACTED:bearer-token]` |
| Basic Auth | `Basic <base64>` | → `Basic [REDACTED:basic-auth]` |
| Env Variables | `API_KEY=<value>` | → `API_KEY=[REDACTED:env-value]` |
| Connection Strings | `://user:pass@host` | → `://user:[REDACTED:password]@host` |

## Integracja

### Automatyczna (już aktywna)
```typescript
// agent-event-log.ts — input/output/errorMessage są sanitizowane
await logAgentEvent({
  input: 'My key is sk-proj-abc123...',  // → 'My key is [REDACTED:openai-api-key]'
  output: 'Connection: mongodb://user:secret@host',  // → password redacted
});
```

### Manualna
```typescript
import { redactSecrets, containsSecrets, getSafeEnvSnapshot } from './secrets-redactor.js';

// Pełna redakcja
const result = redactSecrets(someText);
console.log(result.text);           // Sanitized text
console.log(result.redactedCount);  // Number of secrets found
console.log(result.redactedTypes);  // ['openai-api-key', 'jwt-token']

// Szybki check (boolean)
if (containsSecrets(userInput)) {
  console.warn('Input contains secrets!');
}

// Bezpieczny snapshot env vars
const safeEnv = getSafeEnvSnapshot();
// Only NODE_ENV, PORT, HOST, TZ etc. — no API keys
```

## Pliki
- `lib/secrets-redactor.ts` — główna logika
- `lib/agent-event-log.ts` — automatyczna integracja

## Success Criteria
- 20+ typów sekretów wykrywanych
- Agent event log nie zawiera raw secrets
- Zero false positives na normalnym kodzie
- < 1ms overhead per redaction call

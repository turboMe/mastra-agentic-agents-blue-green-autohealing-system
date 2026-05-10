---
name: email-communication-strategy
category: meta
description: >-
  Strategia komunikacji emailowej dla agentów. Obejmuje cold email,
  follow-up timing, subject line optimization, thread management,
  personalizację i A/B testing. Integruje się z producer-hunt
  i workflow'ami CRM.
keywords: [email, communication, cold-email, follow-up, marketing, outreach, personalization]
allowedTools: [search_web, fs_read_file]
minComplexity: moderate
estimatedTokens: 12000
outputFormat: text
tags: [communication, email, strategy, marketing]
version: 1
success_rate: null
total_uses: 0
last_used: null
---
# Email Communication Strategy

## Trigger
- Draftowanie cold emaili (producer-hunt)
- Follow-up po braku odpowiedzi
- Masowe kampanie email
- Template creation for outreach

## Cold Email Framework — AIDA

```
A — Attention:  Spersonalizowany hook (imię, firma, kontekst)
I — Interest:   Wartość dla odbiorcy (nie o nas, o NICH)
D — Desire:     Konkretna korzyść + social proof
A — Action:     Jedno jasne CTA (Call-To-Action)
```

### Wzorcowy Cold Email

```
Subject: [Imię], pytanie o [konkretny temat z ich branży]

Cześć [Imię],

Widziałem, że [firma] specjalizuje się w [konkretny produkt/usługa].
[1 zdanie personalizacji — coś z ich strony/LinkedIn].

Pomagamy firmom z branży [HoReCa/produkcja] w [konkretna korzyść].
[Social proof: "Współpracujemy z X firmami z regionu Y"].

Czy mógłbym poświęcić 15 minut na krótką rozmowę w przyszłym tygodniu?

Pozdrawiam,
[Podpis]
```

## Subject Line Rules

### ✅ Skuteczne wzorce
| Pattern | Przykład | Open Rate |
|---------|---------|-----------|
| Pytanie + imię | "[Imię], współpraca z [branża]?" | ~35% |
| Konkretna liczba | "3 sposoby na obniżenie food cost o 15%" | ~30% |
| Ciekawość | "Pytanie o [ich produkt]" | ~28% |
| Personalizacja | "Re: [ich event/artykuł]" | ~40% |

### ❌ Unikaj
- ALL CAPS
- Więcej niż 1 emoji
- "Oferta specjalna!!!"
- Brak personalizacji
- Subject > 50 znaków

## Follow-up Cadence

```
Dzień 0:  Email 1 — Pierwszy kontakt (cold email)
Dzień 3:  Email 2 — Krótki follow-up ("Czy dostał/a Pan/i mój email?")
Dzień 7:  Email 3 — Dodatkowa wartość (case study, artykuł)
Dzień 14: Email 4 — Breakup email ("Ostatni raz piszę...")
```

### Follow-up Rules
1. **Max 4 emaile** w jednej sekwencji
2. **Nigdy** nie wysyłaj > 1 email/dzień do tej samej osoby
3. **Zmień kąt** w każdym follow-upie (nie powtarzaj)
4. **Breakup email** ma najwyższy response rate (~12%)
5. **Nie wysyłaj** w weekendy i po 18:00

### Follow-up Template
```
Subject: Re: [oryginalny subject]

Cześć [Imię],

Piszę krótki follow-up do mojego emaila z [dzień].
[1 nowe zdanie wartości / nowy kąt].

Czy [firma] jest zainteresowana [konkretna propozycja]?

Pozdrawiam,
[Podpis]
```

## Personalization Levels

| Level | Wymagany czas | Kiedy używać |
|-------|--------------|-------------|
| **L1** Basic | 0 min | Imię + firma z bazy |
| **L2** Research | 2 min | + coś z ich strony/LinkedIn |
| **L3** Deep | 5 min | + konkretna analiza ich biznesu |
| **L4** Bespoke | 15 min | VIP leads, strategiczni partnerzy |

### Personalization Sources
- Strona WWW firmy (→ Firecrawl/Playwright)
- LinkedIn profil osoby
- Google News o firmie
- Ich social media (Facebook, Instagram)
- KRS / rejestr.io (dane finansowe)

## Email Structure Rules

### Długość
- **Cold email:** max 150 słów (5-7 zdań)
- **Follow-up:** max 80 słów (3-4 zdania)
- **Odpowiedź na pytanie:** max 300 słów

### Formatowanie
- Krótkie paragrafy (1-2 zdania)
- Białe znaki między paragrafami
- Jedno pogrubienie max
- Brak załączników w cold email

### CTA (Call To Action)
- **Jedno CTA per email** — nie dawaj wyboru
- Konkretne: "Czy środa o 10:00 pasuje?" zamiast "Kiedy Pan może?"
- Niskoprogowe: "15 minut rozmowy" zamiast "spotkanie"

## Thread Management

### Śledzenie wątków
```typescript
interface EmailThread {
  recipientEmail: string;
  company: string;
  sequenceStep: number;  // 1-4
  lastSentAt: Date;
  nextFollowUpAt: Date | null;
  status: 'active' | 'replied' | 'bounced' | 'unsubscribed' | 'completed';
  opens: number;
  clicks: number;
}
```

### Status Transitions
```
active → replied (got response)
active → bounced (delivery failed)
active → completed (sequence finished, no reply)
active → unsubscribed (opt-out request)
replied → (manual handling)
```

## Integration z Producer-Hunt

```
1. producer-hunt discovery → lista firm
2. producer-hunt enrichment → kontakt, email, context
3. email-communication-strategy → draft email z AIDA
4. producer-hunt draft → generuj email
5. Follow-up cadence → zaplanuj sekwencję
```

## Anti-Patterns

❌ Masowy blast bez personalizacji
❌ Długie emaile (> 200 słów cold)
❌ Wiele CTA w jednym emailu
❌ Follow-up tego samego dnia
❌ Ignorowanie bounce/unsubscribe
❌ Brak subject line testing

## Success Criteria
- Cold email < 150 słów
- Personalizacja min. L2 (firma + coś z researchu)
- Follow-up cadence 3-7-14 dni
- Max 4 emaile w sekwencji
- Subject < 50 znaków, spersonalizowany

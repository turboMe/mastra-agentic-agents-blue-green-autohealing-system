---
name: automation-client-hunt-strategy
description: >-
  Strategia wyszukiwania firm potrzebujących automatyzacji procesów.
  Definiuje ICP, sygnały zakupowe, query patterns do Tavily, 
  scoring kwalifikacyjny i szablon cold-emaila B2B.
category: meta
keywords: [prospecting, lead-gen, automation, n8n, cold-email, B2B, Polska]
allowedTools: [search_web, find_company_links]
minComplexity: 3
estimatedTokens: 1200
outputFormat: json
tags: [sales, outbound, prospecting]
version: 1.0.0
---

# Automation Client Hunt Strategy

## ICP (Ideal Customer Profile)
- Firma w Polsce, 5-50 pracowników
- Branże docelowe: e-commerce, agencje marketingowe, biura rachunkowe, 
  firmy logistyczne, software house'y, firmy usługowe
- Sygnały zakupowe:
  1. Oferty pracy na 'data entry', 'virtual assistant', 'operations specialist'
  2. Brak integracji widocznych na stronie (np. ręczne formularze, brak API)
  3. Firma rośnie (nowe lokalizacje, produkty) ale procesy wciąż ręczne
  4. Skargi w Google Reviews na wolną obsługę / błędy w zamówieniach
  5. Strona bez chatbota, bez automatycznych odpowiedzi, bez integracji CRM

## Query patterns (Tavily)
Dla każdej branży, użyj kombinacji:
- '[branża] firma Polska zatrudnia data entry 2026'
- '[branża] Polska mała firma manual processes'
- '[branża] Polska oferty pracy operations assistant'
- 'automatyzacja procesów [branża] Polska case study' (szukaj klientów konkurencji)
- 'site:pracuj.pl [branża] data entry' (oferty pracy = sygnał zakupowy)

## Scoring kwalifikacyjny (1-10)
- 8-10: wyraźny sygnał (oferta pracy na data entry + brak automatyzacji na stronie)
- 5-7: pośredni sygnał (rosnąca firma + brak integracji)
- 1-4: odrzuć (za mała, za duża, ma już widoczne automatyzacje)

## Szablon cold-emaila B2B
Zasady:
- Max 150 słów
- Zacznij od PROBLEMU firmy, nie od siebie
- Jeden konkretny use-case, nie lista usług
- CTA: 15-minutowa rozmowa
- Opt-out: 'Jeśli nie chcesz otrzymywać wiadomości, odpowiedz STOP.'
- ZAKAZANE słowa: innowacyjny, kompleksowy, synergiczny, holistyczny,
  rewolucyjny, cutting-edge, game-changer
- Ton: bezpośredni, konkretny, ludzki

## Output format
```json
{
  "firms": [{
    "name": "string",
    "website": "string",
    "industry": "string",
    "size": "string | null",
    "automation_signal": "string",
    "contact_email": "string | null",
    "quality_score": "number",
    "proposed_usecase": "string",
    "estimated_hours_saved": "number",
    "proposed_subject_line": "string"
  }]
}
```

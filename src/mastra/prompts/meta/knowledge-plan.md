<!-- prompt:knowledge-plan v1.0 updated:2026-05-03 -->
Zaproponuj bezpieczny plan użycia NotebookLM dla pytania użytkownika.

Zwróć wyłącznie JSON:
{
  "mode": "existing" | "temporary" | "search",
  "question": "pytanie do NotebookLM",
  "notebooks": ["rynek", "rhd"],
  "sources": [
    { "type": "url", "value": "https://...", "title": "opcjonalny tytuł" },
    { "type": "text", "value": "tekst źródłowy", "title": "opcjonalny tytuł" }
  ],
  "searchQuery": "opcjonalne zapytanie do web search",
  "maxSearchResults": 5,
  "cleanup": true,
  "saveToMemory": true
}

Dostępne stałe notebooki:
- rynek: rynek HoReCa, ceny, trendy, wiadomości
- rhd: przepisy RHD/PKE/RODO i sprzedaż bezpośrednia
- konkurencja: Choco, Proky, Rekki i pozycjonowanie
- founder: wiedza o twórcy (Patryku), historia projektu, wartości, ton komunikacji
- leady: szczegółowe informacje o prospectach, klientach i interakcjach z nimi
- project: pełna dokumentacja projektu GastroBridge, architektura, roadmapa, Q&A, instrukcje systemowe
- docs: przewodnik po platformie, dokumentacja Q&A, instrukcje obsługi dla użytkownika, how-to

Zasady:
- JEŚLI użytkownik pyta o budowę, architekturę, założenia lub sposób działania GastroBridge - MUSISZ wybrać notatnik `project` lub `docs`.
- Użyj `existing`, gdy pytanie da się odpowiedzieć z istniejących notebooków.
- Użyj `temporary`, gdy użytkownik podał konkretne URL-e lub tekst do zbadania.
- Użyj `search`, gdy użytkownik chce świeżego researchu z internetu, a nie podał konkretnych źródeł.
- `cleanup` ma być true dla notebooków tymczasowych i search.
- Nie proponuj usuwania stałych notebooków.
- Maksymalnie 5 wyników search.

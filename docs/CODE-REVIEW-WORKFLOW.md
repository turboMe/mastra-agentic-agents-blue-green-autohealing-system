# Code Review Agent & Workflow (Etap 4)

Aktualizacja: 2026-05-08

## Orkiestracja w Mastra (Separation of Concerns)

Zamiast pozwalać `codingAgent` samodzielnie decydować o ostatecznym scaleniu kodu i wykonaniu polecenia `coding.apply_patch`, wprowadziliśmy automatyczny workflow w środowisku Mastra: `repo-maintenance`.

Workflow ten rozdziela odpowiedzialność:
1. **Zadanie Kodowania (codingAgent)**
2. **Weryfikacja (codeReviewAgent)**

Dzięki takiemu architektonicznemu podziałowi środowisko testowe i naprawcze w Mastrze (tzw. "Self-Healing") osiąga wyższy poziom niezawodności i bezpieczeństwa. Zapewnia to również, że "dwugłowa hybryda" sprawdza nawzajem swoje założenia przed wykonaniem fizycznej zmiany (Live merge).

## Przebieg Workflow `repo-maintenance`

1. System rozpoznaje błąd (np. zebrany z logów) lub przyjmuje manualne zgłoszenie i wywołuje Mastra Workflow `repo-maintenance`.
2. **Step 1: coding-task**: W pierwszej kolejności uruchamiany jest `codingAgent`. 
   - Wykorzystuje on stworzone wcześniej mechanizmy `Staging Worktree`.
   - Zgaduje i diagnozuje usterkę w izolowanym repozytorium.
   - Wprowadza łatkę, puszcza weryfikację (Linter/TSC).
   - Oznacza swój task poprzez artifact tool jako `waiting_approval`.
3. **Step 2: code-review-task**: Do akcji wkracza `codeReviewAgent`.
   - Otrzymuje informacje o wprowadzonych zmianach (diff).
   - Weryfikuje zachowanie dobrych praktyk, pokrycie brzegowych przypadków.
   - Decyduje, czy patch jest gotowy używając nowego narzędzia `coding.submit_review`.
   - Status przyjmuje wartość: `approve` lub `needs_changes`.
4. Jeśli zapadnie decyzja `approve`, patch może zostać zmergowany z kodem "na żywo" za pośrednictwem bezpiecznego `coding.apply_patch` (manualnie lub po ewentualnej automatyzacji w następnych krokach). Jeśli decyzją jest `needs_changes`, interwencja człowieka lub ponowny cykl Workflow popchnie sprawę z powrotem do developera.

## Zmiany w kodzie

* Dodano `submitReviewTool` do `src/mastra/tools/dev/code-task-artifacts.ts`, który obsługuje rejestrację oceny z wynikiem (`approve`, `needs_changes`, `block`).
* Dodano prompt `src/mastra/prompts/coding/review.md` instruujący `codeReviewAgent` jak rygorystycznie postępować.
* Dodano `codeReviewAgent` jako samodzielnego agenta Mastry w `src/mastra/agents/code-review-agent.ts`.
* Zaimplementowano przepływ logiki w `src/mastra/workflows/dev/repo-maintenance.ts`.
* Zarejestrowano narzędzia i workflow w głównym pliku `src/mastra/index.ts`.

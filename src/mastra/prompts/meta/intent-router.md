<!-- prompt:intent-router v1.1 updated:2026-05-03 -->
Sklasyfikuj intencję najnowszej wiadomości użytkownika.

Zwróć WYŁĄCZNIE surowy tekst JSON — bez markdown, bez code blocks (```), bez tool_code, bez komentarzy, bez żadnego tekstu poza JSON:
{
  "intent": "general_chat" | "system_status" | "knowledge_query" | "tool_request" | "workflow_orchestration" | "analytics_query" | "schedule_management" | "approve_action",
  "confidence": 0.0,
  "reason": "krótko dlaczego"
}

Definicje:
- general_chat: zwykła rozmowa, brainstorm, pytania ogólne bez potrzeby narzędzi ani danych z systemu.
- system_status: pytania o taski, ostatnie akcje, stan systemu, logi, działające agenty.
- knowledge_query: pytania wymagające głębokiej wiedzy z baz NotebookLM, dokumentacji projektu, historii foundera, przepisów RHD lub analizy plików/URL-i.
- tool_request: użytkownik chce wykonać konkretną akcję: operacje CRM na leadach, wysyłanie maili, eventy, RSS, operacje n8n. Obejmuje projektowanie automatyzacji, botów, integracji. Obejmuje prośby kulinarne (chef_*). Obejmuje RÓWNIEŻ inżynierię oprogramowania: modyfikacje kodu, przeszukiwanie repozytorium, uruchamianie testów i terminala (np. "napraw buga w index.ts", "napisz funkcję", "przeszukaj pliki") wymagającą narzędzi workspace/coding.
- workflow_orchestration: prośba o uruchomienie agenta-orkiestratora LUB złożonego workflowa (np. delegacja do codingAgent dla modyfikacji architektury, marketing-agent dla weekly-content, sales-agent dla onboardingu).
- analytics_query: pytania o wydatki, tokeny, statystyki, ROI, koszty, metryki.
- schedule_management: zarządzanie harmonogramem i zadaniami cron.
- approve_action: zatwierdzenie oczekującej akcji przez użytkownika (np. "zatwierdz", "wyślij", "ok", "zrób to", "tak, wyślij").


Reguły rozstrzygania:
- Jeśli wiadomość jednocześnie pyta i prosi o uruchomienie workflowa, wybierz workflow_orchestration.
- Jeśli zawiera URL-e do zbadania, wybierz knowledge_query.
- Jeśli użytkownik potwierdza akcję o którą wcześniej pytałeś, wybierz approve_action.
- Jeśli użytkownik prosi o bezpośrednią akcję na konkretnym narzędziu (CRM, Gmail, RSS, n8n) LUB narzędziach dziedzinowych (chef_*), wybierz tool_request.
- KRYTYCZNE: Jeśli użytkownik prosi o konkretny wynik (zaprojektowanie menu, stworzenie planu, szukanie leada) - to ZAWSZE jest tool_request, nawet jeśli to pierwsza wiadomość w wątku. NIE używaj general_chat jako uprzejmego przywitania, jeśli w wiadomości jest konkretne zadanie.
- Jeśli nie pasuje nic innego, użyj general_chat.

KRYTYCZNA REGUŁA — weryfikacja stanu systemu:
- Jeśli użytkownik pyta o wynik poprzedniej akcji ("czy deploy się udał?", "widzisz tę automatyzację?", "czy workflow jest aktywny?", "czy mail został wysłany?", "czy zadanie się wykonało?") — zawsze wybierz tool_request, NIE general_chat.
- Te pytania wymagają weryfikacji narzędziem (n8n_list_workflows, n8n_get_executions, system_get_status itp.), a nie generowania odpowiedzi z pamięci modelu.
- Zasada: pytania o stan czegoś co mogło się wydarzyć w systemie = tool_request.

REGUŁA DOMENY: Jeśli w kontekście podana jest AKTYWNA DOMENA (np. CRM, Marketing, Chef), pytania w tym kontekście kieruj do tool_request (narzędzia domeny), NIE do system_status. Przykład: "status" w domenie CRM = pytanie o leady/pipeline (tool_request), nie o infrastrukturę (system_status). "status" bez domeny = system_status.

WAŻNE: Użyj DOKŁADNIE jednej z nazw z listy w polu "intent". NIGDY nie wymyślaj własnych nazw.

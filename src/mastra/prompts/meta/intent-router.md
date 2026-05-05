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
- tool_request: użytkownik chce wykonać konkretną akcję: operacje CRM na leadach (zmiana statusu, notatka, szukanie), wysłanie/tworzenie maila, tworzenie eventu, wyszukiwanie artykułów RSS, triggerowanie webhooków n8n, synchronizacja systemu, lub inne bezpośrednie użycie narzędzia. Obejmuje też prośby o zaprojektowanie automatyzacji n8n, monitoringu, bota Telegram czy integracji LLM (np. "zbuduj mi bota", "dodaj monitoring RSS", "zsynchronizuj system"). Obejmuje też wszystkie prośby związane z projektowaniem menu, kuchni, dań — np. "zaprojektuj menu na wesele", "stwórz kartę dań", "co pasuje do łososia", "sprawdź sezonowość", "zaproponuj pairing" — używaj narzędzi chef.*.
- workflow_orchestration: prośba o uruchomienie workflowa/agenta (np. weekly-content, producer-hunt, briefing, follow-up) LUB procesy sprzedażowe (propozycje współpracy, spotkania sales, onboarding klienta).
- analytics_query: pytania o wydatki, tokeny, statystyki, ROI, koszty, metryki.
- schedule_management: zarządzanie harmonogramem i zadaniami cron.
- approve_action: zatwierdzenie oczekującej akcji przez użytkownika (np. "zatwierdz", "wyślij", "ok", "zrób to", "tak, wyślij").


Reguły rozstrzygania:
- Jeśli wiadomość jednocześnie pyta i prosi o uruchomienie workflowa, wybierz workflow_orchestration.
- Jeśli zawiera URL-e do zbadania, wybierz knowledge_query.
- Jeśli użytkownik potwierdza akcję o którą wcześniej pytałeś, wybierz approve_action.
- Jeśli użytkownik prosi o bezpośrednią akcję na konkretnym narzędziu (CRM, Gmail, RSS, n8n) LUB narzędziach dziedzinowych (chef.*), wybierz tool_request.
- KRYTYCZNE: Jeśli użytkownik prosi o konkretny wynik (zaprojektowanie menu, stworzenie planu, szukanie leada) - to ZAWSZE jest tool_request, nawet jeśli to pierwsza wiadomość w wątku. NIE używaj general_chat jako uprzejmego przywitania, jeśli w wiadomości jest konkretne zadanie.
- Jeśli nie pasuje nic innego, użyj general_chat.

KRYTYCZNA REGUŁA — weryfikacja stanu systemu:
- Jeśli użytkownik pyta o wynik poprzedniej akcji ("czy deploy się udał?", "widzisz tę automatyzację?", "czy workflow jest aktywny?", "czy mail został wysłany?", "czy zadanie się wykonało?") — zawsze wybierz tool_request, NIE general_chat.
- Te pytania wymagają weryfikacji narzędziem (n8n.list_workflows, n8n.get_executions, system.get_status itp.), a nie generowania odpowiedzi z pamięci modelu.
- Zasada: pytania o stan czegoś co mogło się wydarzyć w systemie = tool_request.

REGUŁA DOMENY: Jeśli w kontekście podana jest AKTYWNA DOMENA (np. CRM, Marketing, Chef), pytania w tym kontekście kieruj do tool_request (narzędzia domeny), NIE do system_status. Przykład: "status" w domenie CRM = pytanie o leady/pipeline (tool_request), nie o infrastrukturę (system_status). "status" bez domeny = system_status.

WAŻNE: Użyj DOKŁADNIE jednej z nazw z listy w polu "intent". NIGDY nie wymyślaj własnych nazw.

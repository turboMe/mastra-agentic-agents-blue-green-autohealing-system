# Architektura Agentów i Narzędzi w Mastra (Jarvis -> Mastra)

## Słownik pojęć

| Jarvis (stary system) | Mastra (nowy system) |
| --- | --- |
| `BaseAgent.run()` / `react-loop.ts` | Pętla `Thought-Action-Observation` obsługiwana natywnie w `.generate()` lub `.stream()`. Brak konieczności ręcznego pisania pętli. |
| `MetaAgentToolDefinition` z `zod` | `createTool()` z wejściem w postaci schematu `zod` oraz opcjonalnym wyjściem. Narzędzia mają wbudowaną akcję `execute`. |
| BullMQ `suggestedJobs` | **Mastra Workflows** dla długich operacji. **Supervisor Agents** dla orkiestracji mniejszych agentów. |
| `SharedMemoryService` / Telemetria w MongoDB | Natywny Storage w Mastra (`MastraMongoDBStore`). Obsługuje `Working Memory`, zapisuje wywołania modeli oraz umożliwia *Semantic Recall*. |

## Jak Tworzymy Agenty

Zamiast dziedziczyć z `BaseAgent` i rejestrować agenta w wielkim switchu, w Mastra każdy agent jest oddzielną instancją klasy `Agent`. 

Przykład Głównego Agenta:
```typescript
import { Agent } from '@mastra/core/agent';

export const metaAgent = new Agent({
  name: 'Meta Agent',
  instructions: '...',
  model: {
    provider: 'OLLAMA',
    name: 'llama3',
    toolChoice: 'auto',
  },
  // W przypadku Głównego Agenta (Supervisor), przekazujemy mu narzędzia 
  // do delegacji zadań (np. "SalesAgentTool")
});
```

## Jak Tworzymy Narzędzia

Każde narzędzie tworzymy poprzez moduł `createTool`. Zwraca on funkcję asynchroniczną, która zostanie automatycznie wykonana przez Agenta podczas cyklu "Action", o ile model uzna to za konieczne.

### Standard narzędzia (np. CRM)
Pliki trzymamy w `src/mastra/tools/[domena]/[narzedzie].ts`.

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const exampleTool = createTool({
  id: 'Example Tool',
  description: 'Zawsze opisuj, kiedy AI powinno tego użyć',
  input: z.object({
    // schemat Zod
  }),
  execute: async ({ context }) => {
    // Logika narzędzia (np. update w bazie, strzał do API)
    return { status: 'ok' };
  }
});
```

## Automatyczne Wyszukiwanie Narzędzi (RAG dla Skilli)

W Jarvis posiadałeś setki narzędzi i domen. Wrzucenie ich wszystkich naraz do jednego promptu przepełnia kontekst modelu. W Mastra możemy użyć `ToolSearchProcessor` oraz mechanizmów sieci agentów, by dołączać narzędzia *tylko* wtedy, gdy są potrzebne. Oznacza to mniejsze zużycie tokenów i brak halucynacji związanych z wyborem błędnego narzędzia.

## Sub-Agenci

Aby odciążyć Głównego Agenta i zapewnić wyższą skuteczność, skomplikowane obszary obsługiwane są przez węższych ekspertów:
- **Marketing Agent** (`marketingAgent`): Odpowiada za wyszukiwanie informacji (RSS), analizę podsumowań i obsługę komunikacji e-mail/kalendarza.
- **Sales Agent** (`salesAgent`): Aktualizuje statusy lejków w CRM i loguje poszczególne interakcje z potencjalnymi klientami. Posiada bezpośredni dostęp do narzędzi manipulacji CRM (updateStatusTool, addInteractionTool).
- **Analytics Agent** (`analyticsAgent`): Systemowy analityk logów operacyjnych. Raportuje błędy i wąskie gardła w zewnętrznych narzędziach (np. monitorowanie statusu n8n).
- **Automation Architect** (`automationArchitect`): Bezpośrednio zarządza systemami n8n, projektuje workflow'y i waliduje ich poprawność używając narzędzi specyficznych dla domen automatyzacji.

Dzięki natywnej obsłudze takich struktur, Meta Agent staje się *Supervisorem*, decydując do którego agenta "oddelegować" konkretne polecenie (lub workflow).

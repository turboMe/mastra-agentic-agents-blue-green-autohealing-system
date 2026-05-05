# Integracja NotebookLM poprzez Mastra MCP

System Jarvis wykorzystywał RAG oparty o dedykowany proces i API NotebookLM, co wiązało się z ręcznym przygotowywaniem schematów, promptów i zarządzaniem cyklem życia pamięci. 

W nowym środowisku Mastra przeszliśmy na **Model Context Protocol (MCP)**, co znacząco redukuje ilość własnego kodu ("boilerplate") potrzebnego do zintegrowania tego samego silnika.

## Architektura i Konfiguracja

1. W pliku `src/mastra/index.ts` inicjalizowany jest `MCPClient`.
2. Do tego klienta podłączamy `notebooklm-mcp` za pośrednictwem lokalnej komendy `uvx notebooklm-mcp` (działającej jako zewnętrzny serwer dostarczający gotowe narzędzia wiedzy).
3. Następnie wszystkie ujawnione z tego serwera narzędzia ładujemy bezpośrednio w obiekcie Mastra do konfiguracji `mcpServers`.

### Kod (src/mastra/index.ts)

```typescript
import { MCPClient } from '@mastra/mcp';

// 1. Zdefiniowanie Połączenia do serwera MCP
const mcpClient = new MCPClient({
  servers: {
    'notebooklm': {
      command: 'uvx',
      args: ['notebooklm-mcp'],
    },
  },
});

// 2. Przekazanie Proxies do Głównego obiektu Mastra
export const mastra = new Mastra({
  // ...
  mcpServers: {
    ...(await mcpClient.toMCPServerProxies()),
  },
  // ...
});
```

## Korzyści

Dzięki temu podejściu, narzędzia takie jak przeszukiwanie NotebookLM czy tworzenie podsumowań stają się natywnymi funkcjami dostępnymi dla każdego Agenta w systemie (lub dla Mastra Studio), bez potrzeby definiowania ich ręcznie poprzez własne pliki `createTool()`. Jeśli NotebookLM wyda nowe funkcje poprzez MCP, nasz system otrzyma je automatycznie przy kolejnym restarcie, ograniczając dług technologiczny.

---
name: n8n-workflow-rules
category: n8n
description: Hard rules for building valid n8n workflows - node IDs, connections, expressions, settings
keywords: [n8n, workflow, rules, validation, build, json, nodes, connections]
---
# n8n Workflow Rules (Hard Constraints)

These rules are MANDATORY when constructing or modifying n8n workflow JSON.

## 1. Workflow Structure

Every workflow JSON must contain:
```json
{
  "name": "Workflow Name",
  "nodes": [...],
  "connections": {...},
  "settings": { "executionOrder": "v1" }
}
```

- `nodes` is an array of node objects
- `connections` maps source node names to arrays of destination connections
- `settings.executionOrder` must be `"v1"` for modern n8n

## 2. Node Object Requirements

Every node MUST have:
- `id` — unique lowercase string (e.g., `"webhook_trigger"`)
- `name` — human-readable display name (MUST be unique within the workflow)
- `type` — fully qualified node type (e.g., `"n8n-nodes-base.webhook"`)
- `typeVersion` — integer matching the installed n8n version
- `position` — `[x, y]` array for canvas placement (increment x by 250-300 per step)
- `parameters` — object with node-specific configuration

## 3. Connection Format

```json
{
  "connections": {
    "Source Node Name": {
      "main": [
        [{ "node": "Target Node Name", "type": "main", "index": 0 }]
      ]
    }
  }
}
```

- Keys are **node names** (not IDs)
- `main` contains an array of output arrays
- Output index 0 = default output
- Output index 1 = second output (e.g., IF node false branch)

## 4. IF Node Connections

IF nodes have TWO outputs:
- `main[0]` = TRUE branch
- `main[1]` = FALSE branch

```json
"IF Condition": {
  "main": [
    [{ "node": "True Handler", "type": "main", "index": 0 }],
    [{ "node": "False Handler", "type": "main", "index": 0 }]
  ]
}
```

## 5. Expression Syntax

n8n uses `={{ }}` for expressions:
- `={{ $json.fieldName }}` — access current item field
- `={{ $('Node Name').item.json.field }}` — access another node's output
- `={{ $vars.variableName }}` — access environment variables
- `={{ $input.all() }}` — all items from previous node
- `={{ $now.toISO() }}` — current timestamp

## 6. Runtime Values (AgentForge Environment)

**NIE używaj `$vars.*`** — n8n Community Edition nie obsługuje zmiennych globalnych ($vars to funkcja Enterprise).

Wartości środowiskowe są **wstrzykiwane automatycznie** przy generowaniu workflow przez system:
- `telegramChatId` — z `N8N_TELEGRAM_CHAT_ID` w .env
- `ollamaBaseUrl` — z `OLLAMA_BASE_URL` (domyślnie `http://localhost:11434`)
- `defaultLocalModel` — z `OLLAMA_DEFAULT_MODEL` (domyślnie `gemma4:26b`)
- `reasoningLocalModel` — z `OLLAMA_REASONING_MODEL`
- `agentForgeTaskEndpoint` — z `AGENTFORGE_TASK_ENDPOINT` lub `DASHBOARD_URL/api/tasks`
- `agentForgeMemoryEndpoint` — z `AGENTFORGE_MEMORY_ENDPOINT` lub `DASHBOARD_URL/api/shared-memory`
- `agentForgeCrmEndpoint` — z `AGENTFORGE_CRM_ENDPOINT` lub `DASHBOARD_URL/api/crm`
- `geminiGatewayEndpoint` — z `GEMINI_GATEWAY_ENDPOINT` lub `DASHBOARD_URL/api/agents/gemini`

W wygenerowanych workflow te wartości są hardkodowane jako literały (nie wyrażenia).

## 7. Credential References

Never hardcode credentials. Use n8n credential references:
```json
"credentials": {
  "telegramApi": { "id": "1", "name": "Telegram Bot" }
}
```

## 8. Common Mistakes to Avoid

- Do NOT set `"active": true` in workflow creation (n8n API rejects it)
- Do NOT duplicate node names within a workflow
- Do NOT use `typeVersion` higher than what's installed
- Do NOT create circular connections
- Do NOT leave dangling nodes without connections (except the last node)
- Always start with a trigger node (webhook, schedule, or manual)

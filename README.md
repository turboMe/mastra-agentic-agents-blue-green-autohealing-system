# Mastra Agentic Environment

An autonomous, multi-domain agentic ecosystem built on top of the [Mastra](https://mastra.ai/) framework. This repository contains a suite of highly specialized TypeScript-based AI agents and workflows, featuring dynamic model routing and an advanced self-healing infrastructure.

## Core Capabilities

### 1. Auto-Healing Infrastructure (System Foundation)
The stability of the environment relies on a comprehensive self-healing diagnostic pipeline that ensures continuous operation without manual intervention:
* **Two-Phase Repair Workflow**: Employs a `diagnose-and-plan` followed by an `execute-patch` sequence, cleanly isolating architectural reasoning from low-level execution.
* **Isolated Staging Environments**: Uses a Staging Worktree architecture to test code modifications and patches in isolation before merging.
* **Automated Quality Gates**: The `repo-maintenance` workflow works alongside the Code Review Agent to enforce architectural oversight before any self-generated patches are finalized.
* **Resilience Mechanisms**: Incorporates runtime validation, automatic JSON repair, and deterministic fallbacks when models produce malformed outputs.

### 2. Dynamic Model Routing & Manipulation
To balance performance, cost, and local hardware constraints (VRAM allocation), the environment employs an intelligent model manipulation strategy:
* **Smart Router & Model Registry**: Dynamically allocates subtasks between local models (e.g., via Ollama) and cloud providers (Google Gemini, OpenAI, Anthropic). 
* **Context-Aware Assignment**: Models are selected on the fly based on the required task complexity, available VRAM budget, and cost efficiency.
* **Multi-Tier Fallbacks**: Configurable fallback chains (e.g., Local Model → Cloud Fallback Agent → Deterministic Fallback) ensure high reliability during heavy research or generation tasks.

### 3. Multi-Agent Orchestration
The ecosystem operates through a network of specialized agents, overseen by a supervisory Meta Agent:
* **Meta Agent**: The primary orchestrator. It uses a `ToolSearchProcessor` to semantically discover required tools at runtime, minimizing prompt context while maximizing capability.
* **Coding & Code Review Agents**: Specialized in software engineering, interacting with file systems, executing tests, and verifying code quality.
* **Domain-Specific Agents**: Includes agents for Marketing (`weekly-content`, `producer-hunt`), CRM, Sales, Analytics, and custom domains.

### 4. Advanced Tool Integrations
Agents have access to a rich set of deterministic and AI-driven tools:
* **Code & Workspace**: Git worktree manipulation, external project scaffolding, and precise file tracking.
* **External Systems**: Deep integration with Google Workspace (Gmail, Calendar), external search (Tavily), and RSS feeds.
* **Automation**: Full integration with local `n8n` instances for webhooks, workflow triggering, and health checks.
* **Knowledge Retrieval**: Connections to NotebookLM (via MCP) for semantic querying across research notebooks.

## 🌍 Language Note / Nota Językowa

**EN:** The core logic of the system is language-agnostic, but many internal agent prompts and hardcoded configurations are currently written in Polish, as the ecosystem was originally tailored for a Polish user. However, these prompts are easily customizable and can be rewritten in English (or any other language) with minimal effort by editing the agent instructions and prompt configurations.

**PL:** Logika systemu jest uniwersalna, ale wiele promptów i wbudowanych tekstów agentów jest obecnie napisanych w języku polskim, ponieważ środowisko było tworzone pod kątem polskiego użytkownika. Prompty te można jednak bardzo łatwo przetłumaczyć lub dostosować do własnych potrzeb, edytując instrukcje w kodzie.

---

## 🚀 Getting Started / Uruchomienie (EN / PL)

### Prerequisites / Wymagania
* Node.js `>=22.13.0`
* [Ollama](https://ollama.com/) (for running local reasoning models / do uruchamiania lokalnych modeli)
* Docker (for `n8n` and database services / dla `n8n` i baz danych)

### Installation / Instalacja

**1. Clone the repository and use the appropriate Node version / Sklonuj repozytorium i użyj odpowiedniej wersji Node:**
```bash
nvm use
npm run node:check
```

**2. Install dependencies / Zainstaluj zależności:**
```bash
npm install
```

**3. Set up environment variables / Ustaw zmienne środowiskowe:**
```bash
cp .env.example .env
# EN: Add your specific model provider keys and external tool API tokens
# PL: Dodaj swoje klucze API dla modeli AI oraz zewnętrznych narzędzi
```

### Running the Environment / Uruchamianie Środowiska

**EN:** Start the Mastra development server and local studio UI:
**PL:** Uruchom serwer deweloperski Mastra oraz lokalne UI:
```bash
npm run dev
```
**EN:** Open [http://localhost:4111](http://localhost:4111) to access the Mastra Studio for interactive testing of agents, workflows, and tools.
**PL:** Otwórz [http://localhost:4111](http://localhost:4111) aby uzyskać dostęp do Mastra Studio – interaktywnego panelu do testowania agentów i przepływów.

**EN:** Start necessary background services:
**PL:** Uruchom niezbędne usługi w tle:
```bash
# Start MongoDB / Uruchom MongoDB
npm run mongo:up

# Start n8n automation and cloudflare tunnel / Uruchom n8n i tunel Cloudflare
npm run n8n:up
npm run tunnel:up
```

## Architecture

The project is structured around the standard Mastra directory layout:
* `src/mastra/agents/`: Definitions of all autonomous agents (e.g., `meta-agent.ts`, `coding-agent.ts`).
* `src/mastra/workflows/`: Multi-step orchestrations (e.g., `repo-maintenance.ts`, `producer-hunt.ts`).
* `src/mastra/tools/`: Custom tools spanning coding operations, CRM interactions, Google APIs, and more.
* `src/mastra/config/`: Configuration for dynamic model routing (`workflow-models.ts`).
* `scripts/`: Operational scripts for database initialization, cron-runners, and health checks.



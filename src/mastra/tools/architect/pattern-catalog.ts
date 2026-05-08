/**
 * Automation pattern catalog.
 *
 * Ported verbatim from jarvis-dashboard-agent/packages/automation-architect/src/patterns/catalog.ts
 *
 * Pre-built n8n workflow templates that the AutomationArchitect can match
 * against an AutomationSpec. Each pattern has a `build(spec)` function
 * returning a deployable n8n workflow JSON (nodes + connections + settings).
 */
import type { AutomationSpec, AutomationPattern } from './types.js';
import type { AnyInput } from './builders/helpers.js';

// Import builders
import { buildRssKeywordToTelegram } from './builders/rssToTelegram.js';
import { buildScheduledHttpKeywordToTelegram } from './builders/scheduledHttpKeywordToTelegram.js';
import { buildMultiUrlMonitorToTelegram } from './builders/multiUrlMonitorToTelegram.js';
import { buildWebhookValidateRespond } from './builders/webhookValidateRespond.js';
import { buildWebhookLeadToAgentForgeCrm } from './builders/webhookLeadToAgentForgeCrm.js';
import { buildScheduledAgentForgeTask } from './builders/scheduledAgentForgeTask.js';
import { buildHttpHealthMonitorToTelegram } from './builders/httpHealthMonitorToTelegram.js';
import { buildWebhookCommandRouterToAgentForge } from './builders/webhookCommandRouterToAgentForge.js';
import { buildWebhookSecurityFilteredTelegram } from './builders/webhookSecurityFilteredTelegram.js';

import {
  buildTelegramToOllamaReply,
  buildTelegramModelRouter,
  buildTelegramAutomationRequestToAgentForge,
  buildRssOllamaClassifierToTelegram,
  buildCompetitorResearchToMemoryAndTelegram,
  buildTelegramRememberToMemory,
  buildDailyMemoryDigestToTelegram,
  buildN8nFailedExecutionExplainer,
  buildLocalLlmWithGeminiFallback,
  buildLeadWebhookOllamaExtractToCrm,
  buildPromptModelComparisonBench,
  buildWebhookIdempotencyGuard,
  buildTelegramMemorySearchOllamaAnswer,
  buildFormLeadQualifierToCrm,
  buildBatchUrlResearchDigest,
  buildAgentForgeBacklogPrioritizer
} from './builders/extendedPatterns.js';

import {
  buildErrorWorkflowOllamaTelegramMemory,
  buildRssDedupToMemoryTelegram,
  buildTelegramTaskTriageToAgentForgeQueue,
  buildApprovalRequestToTelegram,
  buildTelegramApprovalRouter,
  buildOllamaModelHealthCheck,
  buildLocalModelQualityEvaluator,
  buildWebhookOllamaJsonNormalizerToApi,
  buildWorkflowDocumentation,
  buildDraftOnlyEmailAssistant,
  buildDailyStandup,
  buildRefusalPattern
} from './builders/advancedPatterns.js';
import { buildAiScraperToCrm } from './builders/scraperPattern.js';

// Re-export commonly needed types so existing importers (pattern-rag, composer)
// can keep importing from this module.
export type {
  AutomationSpec,
  AutomationPattern,
  PatternKnowledgeCard,
  StoredAutomationPattern,
  AutomationDecisionRule,
  ModelChoice,
  RiskLevel,
} from './types.js';

/**
 * Registry of all supported automation patterns.
 */
export const automationPatterns: AutomationPattern[] = [
  {
    id: 'rss-keyword-to-telegram',
    name: 'RSS Keyword Monitor to Telegram',
    description: 'Reads an RSS feed, filters items by keywords and sends matching items to Telegram.',
    risk: 'medium',
    supportedIntents: ['rss_monitoring', 'competitor_monitoring', 'blog_monitoring'],
    requiredInputs: ['rssUrl', 'keywords'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildRssKeywordToTelegram
  },
  {
    id: 'scheduled-http-keyword-to-telegram',
    name: 'Scheduled HTTP Keyword Monitor to Telegram',
    description: 'Checks a URL on a schedule and sends a Telegram alert when keywords are found.',
    risk: 'medium',
    supportedIntents: ['website_monitoring', 'keyword_monitoring', 'competitor_monitoring'],
    requiredInputs: ['url', 'keywords'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildScheduledHttpKeywordToTelegram
  },
  {
    id: 'multi-url-monitor-to-telegram',
    name: 'Multi URL Competitor Monitor',
    description: 'Checks multiple URLs and sends Telegram alerts for keyword matches.',
    risk: 'medium',
    supportedIntents: ['competitor_monitoring', 'multi_url_monitoring'],
    requiredInputs: ['urls', 'keywords'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildMultiUrlMonitorToTelegram
  },
  {
    id: 'webhook-validate-respond',
    name: 'Webhook Validate and Respond',
    description: 'Receives a webhook, validates payload and returns a JSON response.',
    risk: 'low',
    supportedIntents: ['webhook_endpoint', 'api_endpoint', 'test_endpoint'],
    requiredInputs: ['path'],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    build: buildWebhookValidateRespond
  },
  {
    id: 'webhook-lead-to-agentforge-crm',
    name: 'Webhook Lead to AgentForge CRM',
    description: 'Receives lead data, normalizes it, sends it to AgentForge CRM and alerts Telegram.',
    risk: 'high',
    supportedIntents: ['lead_capture', 'crm', 'sales_pipeline'],
    requiredInputs: ['path', 'crmEndpoint'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildWebhookLeadToAgentForgeCrm
  },
  {
    id: 'scheduled-agentforge-task',
    name: 'Scheduled AgentForge Task',
    description: 'Creates a scheduled task and sends it to the AgentForge task endpoint.',
    risk: 'medium',
    supportedIntents: ['scheduled_agent_task', 'recurring_ai_task'],
    requiredInputs: ['taskType', 'prompt', 'endpoint'],
    requiredCredentials: [],
    forbiddenWithoutApproval: true,
    build: buildScheduledAgentForgeTask
  },
  {
    id: 'http-health-monitor-to-telegram',
    name: 'HTTP Health Monitor to Telegram',
    description: 'Checks service health and alerts Telegram if response does not match expectation.',
    risk: 'medium',
    supportedIntents: ['health_monitoring', 'uptime_monitoring'],
    requiredInputs: ['url'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildHttpHealthMonitorToTelegram
  },
  {
    id: 'webhook-command-router-to-agentforge',
    name: 'Webhook Command Router to AgentForge',
    description: 'Routes incoming webhook commands into AgentForge task queue.',
    risk: 'high',
    supportedIntents: ['command_router', 'agentforge_router', 'webhook_to_queue'],
    requiredInputs: ['path', 'taskEndpoint'],
    requiredCredentials: [],
    forbiddenWithoutApproval: true,
    build: buildWebhookCommandRouterToAgentForge
  },
  {
    id: 'webhook-security-filtered-telegram',
    name: 'Secure Webhook to Telegram',
    description: 'Receives secure webhook events and sends Telegram alerts after token validation.',
    risk: 'medium',
    supportedIntents: ['secure_webhook', 'alert_webhook'],
    requiredInputs: ['path'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildWebhookSecurityFilteredTelegram
  },
  {
    id: 'telegram-to-ollama-reply',
    name: 'Telegram to Ollama Reply',
    description: 'Receives Telegram messages, sends them to local Ollama and replies on Telegram.',
    risk: 'medium',
    supportedIntents: ['telegram_chatbot', 'local_llm_chat', 'telegram_llm'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramToOllamaReply
  },
  {
    id: 'telegram-model-router',
    name: 'Telegram Model Router',
    description: 'Routes Telegram commands to different local Ollama models depending on task type.',
    risk: 'medium',
    supportedIntents: ['model_router', 'telegram_model_router', 'local_model_selection'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramModelRouter
  },
  {
    id: 'telegram-automation-request-to-agentforge',
    name: 'Telegram Automation Request to AgentForge',
    description: 'Turns /automation Telegram commands into Automation Architect tasks.',
    risk: 'medium',
    supportedIntents: ['automation_request', 'telegram_to_automation_architect'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramAutomationRequestToAgentForge
  },
  {
    id: 'rss-ollama-classifier-to-telegram',
    name: 'RSS Ollama Classifier to Telegram',
    description: 'Reads RSS, classifies items with local Ollama and sends relevant items to Telegram.',
    risk: 'medium',
    supportedIntents: ['rss_classification', 'rss_monitoring', 'competitor_monitoring'],
    requiredInputs: ['rssUrl', 'topics'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildRssOllamaClassifierToTelegram
  },
  {
    id: 'competitor-research-to-memory-and-telegram',
    name: 'Competitor Research to Memory and Telegram',
    description: 'Fetches competitor pages, summarizes with local LLM, stores in AgentForge memory and sends digest.',
    risk: 'high',
    supportedIntents: ['competitor_research', 'market_research', 'business_intelligence'],
    requiredInputs: ['urls'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildCompetitorResearchToMemoryAndTelegram
  },
  {
    id: 'telegram-remember-to-memory',
    name: 'Telegram Remember to Memory',
    description: 'Saves /remember Telegram messages to AgentForge memory.',
    risk: 'medium',
    supportedIntents: ['memory_capture', 'telegram_memory', 'remember_command'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramRememberToMemory
  },
  {
    id: 'daily-memory-digest-to-telegram',
    name: 'Daily Memory Digest to Telegram',
    description: 'Fetches AgentForge memory, summarizes it with Ollama and sends daily Telegram digest.',
    risk: 'medium',
    supportedIntents: ['daily_digest', 'memory_digest', 'daily_summary'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildDailyMemoryDigestToTelegram
  },
  {
    id: 'n8n-failed-execution-explainer',
    name: 'n8n Failed Execution Explainer',
    description: 'Monitors failed n8n executions, explains them with Ollama and alerts Telegram.',
    risk: 'high',
    supportedIntents: ['n8n_monitoring', 'execution_monitoring', 'workflow_debugging'],
    requiredInputs: [],
    requiredCredentials: ['telegram', 'n8n_api_key'],
    forbiddenWithoutApproval: true,
    build: buildN8nFailedExecutionExplainer
  },
  {
    id: 'local-llm-with-gemini-fallback',
    name: 'Local LLM with Gemini Fallback',
    description: 'Uses local Ollama first and escalates to Gemini through AgentForge gateway only when needed.',
    risk: 'high',
    supportedIntents: ['llm_fallback', 'gemini_fallback', 'hard_reasoning'],
    requiredInputs: ['prompt'],
    requiredCredentials: ['gemini_gateway'],
    forbiddenWithoutApproval: true,
    build: buildLocalLlmWithGeminiFallback
  },
  {
    id: 'lead-webhook-ollama-extract-to-crm',
    name: 'Lead Webhook Ollama Extract to CRM',
    description: 'Receives lead payload, extracts structured lead data with Ollama, saves to CRM and alerts Telegram.',
    risk: 'high',
    supportedIntents: ['lead_capture', 'lead_extraction', 'crm_intake'],
    requiredInputs: ['path'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildLeadWebhookOllamaExtractToCrm
  },
  {
    id: 'prompt-model-comparison-bench',
    name: 'Prompt Model Comparison Bench',
    description: 'Runs the same prompt through multiple local models and sends comparison to Telegram.',
    risk: 'medium',
    supportedIntents: ['model_benchmark', 'prompt_testing', 'model_comparison'],
    requiredInputs: ['prompt'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildPromptModelComparisonBench
  },
  {
    id: 'error-workflow-ollama-telegram-memory',
    name: 'Error Workflow with Ollama Explanation',
    description: 'Centralized error handler that uses local Ollama to explain failures, alerts Telegram and saves to AgentForge memory.',
    risk: 'high',
    supportedIntents: ['error_handling', 'monitoring', 'workflow_debugging', 'system_alerts'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildErrorWorkflowOllamaTelegramMemory,
    knowledgeCard: {
      id: 'error-workflow-ollama-telegram-memory',
      name: 'Error Workflow -> Ollama Explanation -> Telegram -> Memory',
      intentExamples: ['n8n workflow monitoring', 'centralized error alerts', 'explain n8n errors with ai'],
      useWhen: ['workflow failures need explanation', 'real-time technical alerts are needed'],
      avoidWhen: ['simple workflows where internal n8n error handling is enough'],
      risk: 'high',
      nodes: ['Error Trigger', 'Code', 'HTTP Request', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Manually trigger an error in a linked workflow'],
      commonFailures: ['Ollama model not available', 'Missing Telegram chatId (set N8N_TELEGRAM_CHAT_ID in .env)'],
    }
  },
  {
    id: 'rss-dedup-memory-telegram',
    name: 'RSS with Smart Deduplication',
    description: 'Reads RSS feeds and uses AgentForge memory to ensure no duplicate items are processed or alerted.',
    risk: 'medium',
    supportedIntents: ['rss_monitoring', 'deduplication', 'competitor_monitoring'],
    requiredInputs: ['rssUrl'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildRssDedupToMemoryTelegram
  },
  {
    id: 'telegram-task-triage-agentforge-queue',
    name: 'Telegram Task Triage to Queue',
    description: 'Uses local Ollama to classify Telegram messages into task queues (marketing, research, etc.).',
    risk: 'medium',
    supportedIntents: ['task_triage', 'telegram_orchestration', 'agent_queue'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramTaskTriageToAgentForgeQueue
  },
  {
    id: 'approval-request-telegram',
    name: 'Approval Request Gate (Telegram)',
    description: 'Creates a secure approval token and asks for user confirmation via Telegram before proceeding.',
    risk: 'medium',
    supportedIntents: ['human_approval', 'approval_gate', 'security_gate'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildApprovalRequestToTelegram
  },
  {
    id: 'telegram-approval-router',
    name: 'Telegram Approval Router',
    description: 'Receives /approve and /reject commands from Telegram and resolves pending approval requests.',
    risk: 'medium',
    supportedIntents: ['approval_resolution', 'telegram_commands'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildTelegramApprovalRouter
  },
  {
    id: 'ollama-model-health-check',
    name: 'Ollama Model Health Check',
    description: 'Regularly checks if required local models are available in Ollama and alerts Telegram if missing.',
    risk: 'low',
    supportedIntents: ['health_check', 'system_monitoring', 'ollama_monitoring'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildOllamaModelHealthCheck
  },
  {
    id: 'local-model-quality-evaluator',
    name: 'Local Model Quality Evaluator',
    description: 'Benchmarks multiple local models on the same prompt and uses a judge model to evaluate winners.',
    risk: 'medium',
    supportedIntents: ['model_evaluation', 'benchmarking', 'llm_ops'],
    requiredInputs: ['prompt'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildLocalModelQualityEvaluator
  },
  {
    id: 'webhook-ollama-json-normalizer-api',
    name: 'Webhook Ollama JSON Normalizer',
    description: 'Receives raw data via webhook, uses Ollama to normalize it to structured JSON and saves to API.',
    risk: 'medium',
    supportedIntents: ['data_normalization', 'webhook_intake', 'structured_data'],
    requiredInputs: ['path'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildWebhookOllamaJsonNormalizerToApi
  },
  {
    id: 'workflow-documentation',
    name: 'Workflow Self-Documentation',
    description: 'Generates detailed documentation for the current workflow and saves it to AgentForge memory.',
    risk: 'low',
    supportedIntents: ['documentation', 'system_audit', 'observability'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    build: buildWorkflowDocumentation
  },
  {
    id: 'draft-only-email-assistant',
    name: 'Draft-Only Email Assistant',
    description: 'Monitors Gmail, drafts a reply using local LLM, and saves it as a proposal without sending.',
    risk: 'high',
    supportedIntents: ['email_assistant', 'draft_reply', 'gmail_automation'],
    requiredInputs: [],
    requiredCredentials: ['gmail', 'telegram'],
    forbiddenWithoutApproval: true,
    build: buildDraftOnlyEmailAssistant,
    knowledgeCard: {
      id: 'draft-only-email-assistant',
      name: 'Gmail -> Ollama -> Draft Proposal -> Telegram',
      intentExamples: ['pomoz mi odpisywac na maile', 'stworz draft odpowiedzi na gmail', 'asystent email'],
      useWhen: ['uzytkownik chce pomocy w korespondencji', 'bezpieczenstwo jest priorytetem (brak auto-wysylki)'],
      avoidWhen: ['wymagana jest natychmiastowa automatyczna odpowiedz bez czlowieka'],
      risk: 'high',
      nodes: ['Gmail Trigger', 'Code', 'Ollama', 'HTTP Request', 'Telegram'],
      credentials: ['Gmail', 'Telegram'],
      approvalRequired: true,
      testingStrategy: ['Wyslij testowy email do siebie i sprawdz draft'],
      commonFailures: ['Brak uprawnien do Gmail API', 'Model Ollama zbyt kreatywny/nieformalny'],
    }
  },
  {
    id: 'agentforge-daily-standup',
    name: 'AgentForge Daily Standup',
    description: 'Scheduled task that summarizes system status, tasks, and approvals for a Telegram report.',
    risk: 'medium',
    supportedIntents: ['daily_report', 'system_summary', 'standup'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildDailyStandup
  },
  {
    id: 'automation-refusal-safety',
    name: 'Safety Refusal Pattern',
    description: 'Used when a request involves prohibited or high-risk actions. Explains the risk and suggests alternatives.',
    risk: 'low',
    supportedIntents: ['prohibited_action', 'security_refusal', 'risk_mitigation'],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: false,
    build: buildRefusalPattern,
    knowledgeCard: {
      id: 'automation-refusal-safety',
      name: 'Safety Refusal / "Do Nothing" Pattern',
      intentExamples: ['usun wszystkie dane', 'wyslij spam do 1000 osob', 'uzyj polecenia shell'],
      useWhen: ['prosba jest niebezpieczna', 'prosba dotyczy SSH/Shell/Destrukcji danych'],
      avoidWhen: ['prosba jest bezpieczna i mozna ja zrealizowac inaczej'],
      risk: 'low',
      nodes: ['Code', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: false,
      testingStrategy: ['Pop ros o usuniecie bazy danych i sprawdz odpowiedz'],
      commonFailures: ['Zbyt agresywna odmowa na bezpieczne prosby'],
    }
  },
  {
    id: 'webhook-idempotency-guard',
    name: 'Webhook Idempotency Guard',
    description: 'Prevents double processing of the same event using a unique idempotency key.',
    risk: 'medium',
    supportedIntents: [
      'webhook_deduplication',
      'idempotent_webhook',
      'safe_webhook'
    ],
    requiredInputs: ['path'],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    build: buildWebhookIdempotencyGuard,
    knowledgeCard: {
      id: 'webhook-idempotency-guard',
      name: 'Webhook Idempotency Guard',
      intentExamples: ['zabezpiecz webhook przed duplikatami', 'webhook idempotency', 'idempotentny webhook'],
      useWhen: ['webhooki z formularzy', 'webhooki z platnosci', 'webhooki z Telegrama', 'lead capture'],
      avoidWhen: ['eventy sa z natury unikalne i brak ryzyka ponowienia'],
      risk: 'medium',
      nodes: ['Webhook', 'Code', 'HTTP Request (AgentForge)'],
      credentials: [],
      approvalRequired: false,
      testingStrategy: ['Wyslij ten sam payload dwa razy i sprawdz czy drugi zostal pominiety'],
      commonFailures: ['Brak klucza idempotencji w payloadzie'],
    }
  },
  {
    id: 'telegram-memory-search-ollama-answer',
    name: 'Telegram Memory Search with Ollama Answer',
    description: 'Local memory assistant that searches AgentForge memory and answers via Ollama on Telegram.',
    risk: 'medium',
    supportedIntents: [
      'memory_search',
      'telegram_rag',
      'ask_memory'
    ],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildTelegramMemorySearchOllamaAnswer,
    knowledgeCard: {
      id: 'telegram-memory-search-ollama-answer',
      name: 'Telegram Memory Search -> Ollama Answer',
      intentExamples: ['/ask co wiesz o...', 'przeszukaj pamiec', 'znajdz w agentforge'],
      useWhen: ['uzytkownik chce zadac pytanie do swojej bazy wiedzy/pamieci'],
      avoidWhen: ['wymagana jest wiedza spoza systemu (wtedy uzyj Gemini)'],
      risk: 'medium',
      nodes: ['Telegram Trigger', 'HTTP Request', 'Ollama', 'Code'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Zadaj pytanie /ask o cos co zapisales wczesniej'],
      commonFailures: ['Brak wynikow wyszukiwania (pusta pamiec)', 'Model Ollama halucynuje poza kontekstem'],
    }
  },
  {
    id: 'form-lead-qualifier-to-crm',
    name: 'Form Lead Qualifier to CRM',
    description: 'Captures leads via n8n form, qualifies them using local LLM, and saves to CRM.',
    risk: 'high',
    supportedIntents: [
      'lead_form',
      'lead_qualification',
      'inbound_sales'
    ],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildFormLeadQualifierToCrm,
    knowledgeCard: {
      id: 'form-lead-qualifier-to-crm',
      name: 'n8n Form -> Ollama Lead Qualification -> CRM',
      intentExamples: ['stworz formularz leadow', 'formularz kontaktowy z kwalifikacja'],
      useWhen: ['szybki formularz leadow', 'test landing page', 'feedback od klientow'],
      avoidWhen: ['wymagany jest bardzo zlozony formularz z logika po stronie klienta'],
      risk: 'high',
      nodes: ['Form Trigger', 'Ollama', 'HTTP Request (CRM)', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Wypelnij formularz i sprawdz punktacje w CRM i alert na Telegramie'],
      commonFailures: ['Bledny format JSON z modelu kwalifikujacego'],
    }
  },
  {
    id: 'batch-url-research-digest',
    name: 'Batch URL Research Digest',
    description: 'Processes multiple URLs with batching, summarizes each, and sends a daily digest.',
    risk: 'medium',
    supportedIntents: [
      'batch_research',
      'competitor_research',
      'url_research'
    ],
    requiredInputs: ['urls'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildBatchUrlResearchDigest,
    knowledgeCard: {
      id: 'batch-url-research-digest',
      name: 'Batch URL Research with Loop Control',
      intentExamples: ['zrob research listy url', 'przeanalizuj konkurencje', 'batch research'],
      useWhen: ['przetwarzanie wielu URL-i naraz', 'analiza konkurencji'],
      avoidWhen: ['pojedynczy URL (wtedy uzyj prostszego researchera)'],
      risk: 'medium',
      nodes: ['Schedule', 'Split in Batches', 'HTTP Request', 'Ollama', 'Aggregate', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Podaj 3 URL-e i sprawdz czy digest przyszedl po agregacji'],
      commonFailures: ['Blokada IP przez serwery zewnetrzne', 'Zbyt duzy batch zabijajacy Ollame'],
    }
  },
  {
    id: 'agentforge-backlog-prioritizer',
    name: 'AgentForge Backlog Prioritizer',
    description: 'Daily task that prioritizes AgentForge backlog and reports focus areas to Telegram.',
    risk: 'medium',
    supportedIntents: [
      'backlog_prioritization',
      'daily_planning',
      'agent_task_prioritization'
    ],
    requiredInputs: [],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildAgentForgeBacklogPrioritizer,
    knowledgeCard: {
      id: 'agentforge-backlog-prioritizer',
      name: 'AgentForge Queue Backlog Prioritizer',
      intentExamples: ['uloz priorytety zadan', 'podsumuj backlog', 'co mam dzis robic'],
      useWhen: ['system ma wiele oczekujacych zadan i wymaga autonomicznego planowania'],
      avoidWhen: ['uzytkownik chce recznie sterowac kazdym zadaniem'],
      risk: 'medium',
      nodes: ['Schedule', 'HTTP Request (Backlog)', 'Ollama (Qwen)', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Dodaj 5 zadan i sprawdz czy poranny raport ulozyl je logicznie'],
      commonFailures: ['Brak dostepu do API backlogu'],
    }
  },
  {
    id: 'execute-subworkflow-llm-json-normalizer',
    name: 'Reusable LLM JSON Normalizer Sub-workflow',
    description: 'Abstract pattern for centralizing LLM JSON validation logic into a sub-workflow.',
    risk: 'medium',
    supportedIntents: ['json_normalization', 'subworkflow_module'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'execute-subworkflow-llm-json-normalizer',
      name: 'Reusable LLM JSON Normalizer Sub-workflow',
      intentExamples: ['uzyj sub-workflow do parsuj', 'znormalizuj json przez modul'],
      useWhen: ['wiele workflow potrzebuje walidowanego JSON z LLM', 'chcesz ograniczyc duplikacje promptow'],
      avoidWhen: ['workflow jest jednorazowy i bardzo prosty'],
      risk: 'medium',
      nodes: ['Execute Workflow Trigger', 'Ollama', 'Code parser'],
      credentials: [],
      approvalRequired: false,
      testingStrategy: ['Wywolaj sub-workflow z blednym JSONem i sprawdz czy naprawil'],
      commonFailures: ['Timeout przy wywolaniu sub-workflow'],
    }
  },
  {
    id: 'llm-json-retry-guard',
    name: 'LLM JSON Retry Guard',
    description: 'Safety pattern that retries and repairs malformed LLM JSON output.',
    risk: 'medium',
    supportedIntents: ['safety_retry', 'json_repair'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'llm-json-retry-guard',
      name: 'LLM JSON Retry Guard',
      intentExamples: ['dodaj retry do llm', 'napraw json jesli zepsuty'],
      useWhen: ['workflow zalezy od ustrukturyzowanych danych', 'model czesto zwraca smieci'],
      avoidWhen: ['output jest tylko dla czlowieka jako tekst'],
      risk: 'medium',
      nodes: ['Ollama', 'Code (validator)', 'Ollama (repair)'],
      credentials: [],
      approvalRequired: false,
      testingStrategy: ['Zmus model do zwrocenia blednego JSON i sprawdz czy repair zadzialal'],
      commonFailures: ['Nieskonczona petla naprawy (wymaga limitu prob)'],
    }
  },
  {
    id: 'cache-before-llm',
    name: 'Cache Before LLM',
    description: 'Optimization pattern that checks for existing results before calling expensive LLMs.',
    risk: 'medium',
    supportedIntents: ['optimization', 'caching'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: false,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'cache-before-llm',
      name: 'Cache Before LLM',
      intentExamples: ['dodaj cache do llm', 'nie wywoluj llm jesli juz to robiles'],
      useWhen: ['ten sam tekst moze byc analizowany wielokrotnie', 'uzywasz drogiego Gemini'],
      avoidWhen: ['input zmienia sie za kazdym razem'],
      risk: 'medium',
      nodes: ['Code (hash)', 'HTTP Request (Cache check)', 'Ollama/Gemini'],
      credentials: [],
      approvalRequired: false,
      testingStrategy: ['Wyslij to samo zapytanie dwa razy i sprawdz logi (drugie powinno byc z cache)'],
      commonFailures: ['Zbyt szeroki klucz cache (kolizje)', 'Cache stale data'],
    }
  },
  {
    id: 'gemini-escalation-approval',
    name: 'Gemini Escalation Approval',
    description: 'Escalates tasks to cloud Gemini models only when necessary and approved.',
    risk: 'high',
    supportedIntents: ['escalation', 'high_precision'],
    requiredInputs: [],
    requiredCredentials: [],
    forbiddenWithoutApproval: true,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'gemini-escalation-approval',
      name: 'Gemini Escalation Approval',
      intentExamples: ['uzyj gemini zamiast ollama', 'escalate to cloud'],
      useWhen: ['lokalny model ma niski confidence', 'wymagana wiedza real-time'],
      avoidWhen: ['dane prywatne musza zostac lokalnie'],
      risk: 'high',
      nodes: ['Condition', 'Request Approval', 'Gemini Gateway'],
      credentials: [],
      approvalRequired: true,
      testingStrategy: ['Sprobuj wymusic eskalacje i sprawdz czy zapytal o zgode'],
      commonFailures: ['Brak uzasadnienia eskalacji'],
    }
  },
  {
    id: 'workflow-drift-detector',
    name: 'Workflow Drift Detector',
    description: 'Monitors n8n workflows for manual changes compared to AgentForge snapshots.',
    risk: 'high',
    supportedIntents: ['drift_detection', 'audit'],
    requiredInputs: [],
    requiredCredentials: ['n8n_api_key'],
    forbiddenWithoutApproval: false,
    executable: false,
    maturity: 'draft',
    build: (_spec) => ({}), // Abstract — knowledge-only, not deployable
    knowledgeCard: {
      id: 'workflow-drift-detector',
      name: 'Workflow Drift Detector',
      intentExamples: ['sprawdz czy ktos edytowal n8n', 'wykryj zmiany w workflow'],
      useWhen: ['AgentForge tworzy workflow w n8n i chcesz miec audyt zmian'],
      avoidWhen: ['n8n jest uzywane tylko recznie'],
      risk: 'high',
      nodes: ['Schedule', 'n8n API', 'HTTP Request (Memory)', 'Code (diff)'],
      credentials: ['n8n_api_key'],
      approvalRequired: false,
      testingStrategy: ['Zmien recznie parametr w n8n i sprawdz czy drift detector to zglosil'],
      commonFailures: ['Brak API key do n8n'],
    }
  },
  {
    id: 'ai-scraper-to-crm',
    name: 'Universal AI Scraper to CRM',
    description: 'Fetches a URL, cleans HTML, extracts leads with AI and saves to CRM.',
    risk: 'high',
    supportedIntents: ['scraper', 'web_scraping', 'lead_generation', 'monitoring', 'olx', 'rhd'],
    requiredInputs: ['url'],
    requiredCredentials: ['telegram'],
    forbiddenWithoutApproval: true,
    build: buildAiScraperToCrm,
    knowledgeCard: {
      id: 'ai-scraper-to-crm',
      name: 'HTTP Fetch -> HTML Clean -> AI Extraction -> CRM',
      intentExamples: ['scraper monitorujacy olx', 'pobieraj dane z rejestru rhd', 'wyciagnij leady ze strony'],
      useWhen: ['strona nie ma API', 'potrzebna jest inteligentna ekstrakcja z tekstu', 'monitorowanie ogloszen'],
      avoidWhen: ['strona ma RSS (uzyj RSS Monitor)', 'strona ma oficjalne API'],
      risk: 'high',
      nodes: ['Schedule', 'HTTP Request', 'HTML', 'Ollama', 'Code', 'CRM', 'Telegram'],
      credentials: ['Telegram'],
      approvalRequired: true,
      testingStrategy: ['Uruchom recznie dla znanego URL i sprawdz czy AI wyodrebnilo pola'],
      commonFailures: ['Blokada bota przez strone', 'Zbyt duza strona (przekroczenie tokenow LLM)'],
    }
  }
];

/**
 * Alias for backwards-compatibility with consumers that use the PATTERN_CATALOG name.
 */
export const PATTERN_CATALOG: AutomationPattern[] = automationPatterns;

export function getPatternById(id: string): AutomationPattern | undefined {
  return automationPatterns.find(p => p.id === id);
}

export function scorePatternMatch(
  pattern: AutomationPattern,
  spec: AutomationSpec
): number {
  const text = [
    spec.name,
    spec.description,
    spec.goal,
    ...(spec.steps ?? []).map(s => `${s.name} ${s.purpose}`)
  ].join(' ').toLowerCase();

  let score = 0;

  // Intent match
  for (const intent of pattern.supportedIntents) {
    if (text.includes(intent.replace(/_/g, ' '))) {
      score += 20;
    }
  }

  // Input match
  for (const input of pattern.requiredInputs) {
    const exists = ((spec.inputs ?? []) as AnyInput[]).some(i =>
      i.name.toLowerCase().includes(input.toLowerCase())
    );

    if (exists) score += 10;
  }

  // Risk match
  if (pattern.risk === spec.riskLevel) {
    score += 5;
  }

  return score;
}

export function selectBestPattern(spec: AutomationSpec): AutomationPattern | null {
  const ranked = automationPatterns
    .filter(pattern => pattern.executable !== false)
    .map(pattern => ({
      pattern,
      score: scorePatternMatch(pattern, spec)
    }))
    .sort((a, b) => b.score - a.score);

  if (ranked[0]?.score > 0) {
    return ranked[0].pattern;
  }

  return null;
}

export function getExecutablePatterns(): AutomationPattern[] {
  return automationPatterns.filter(p => p.executable !== false);
}

export function getAbstractPatterns(): AutomationPattern[] {
  return automationPatterns.filter(p => p.executable === false);
}

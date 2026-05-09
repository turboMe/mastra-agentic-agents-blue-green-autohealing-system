/**
 * Unified Model Manifest — Single Source of Truth
 *
 * ALL model assignments for agents, workflows, worker presets, and
 * infrastructure live here. Change a model once → every consumer picks it up.
 *
 * Structure:
 *   Section 1: Model Inventory    — what models exist (aliases → full IDs)
 *   Section 2: Agent Assignments   — which agent uses which model
 *   Section 3: Workflow Assignments — which workflow step uses which model
 *   Section 4: Worker Presets      — run_worker tool preset → model mapping
 *   Section 5: Infrastructure      — embedding, observational memory, n8n defaults
 *
 * Usage in consumers:
 *   import { agentModels, resolveModelId } from '../config/model-manifest.js';
 *   model: resolveModelId(agentModels.metaAgent),
 */

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1: MODEL INVENTORY
//
// Human-readable alias → full Mastra model ID.
// Add new models here (local, cloud, OpenRouter) and use the alias everywhere.
// ═════════════════════════════════════════════════════════════════════════════

export const models = {
  // ── Local (Ollama) ─────────────────────────────────────────────────────────
  'qwen3-1.7b':           'ollama/local/qwen3:1.7b',
  'gemma3-4b':            'ollama/local/gemma3:4b',
  'gemma4-e4b':           'ollama/local/gemma4:e4b',
  'qwen3.5-9b':           'ollama/local/huihui_ai/qwen3.5-abliterated:9b',
  'qwen3-coder-30b':      'ollama/local/qwen3-coder:30b',
  'gemma4-26b':           'ollama/local/gemma4:26b',
  'phi4-reasoning-14b':   'ollama/local/phi4-reasoning:14b',
  'magistral-24b':        'ollama/local/magistral:24b',

  // ── Cloud (paid) ───────────────────────────────────────────────────────────
  'gpt-5.3-mini':         'openai/gpt-5.3-mini',
  'gemini-2.5-flash':     'google/gemini-2.5-flash',
  'claude-haiku-4.6':     'anthropic/claude-haiku-4-6',
  'gemini-2.5-pro':       'google/gemini-2.5-pro',
  'gpt-5.5':              'openai/gpt-5.5',
  'claude-sonnet-4.6':    'anthropic/claude-sonnet-4-6',

  // ── Cloud-free (OpenRouter) ────────────────────────────────────────────────
  'nemotron-super-free':  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  'nemotron-nano-free':   'openrouter/nvidia/nemotron-3-nano-30b-a3b:free',
  'laguna-free':          'openrouter/poolside/laguna-m.1:free',
  'ring-free':            'openrouter/inclusionai/ring-2.6-1t:free',
  'minimax-free':         'openrouter/minimax/minimax-m2.5:free',
  'glm-free':             'openrouter/z-ai/glm-4.5-air:free',
  'gpt-oss-120b-free':    'openrouter/openai/gpt-oss-120b:free',
  'gpt-oss-20b-free':     'openrouter/openai/gpt-oss-20b:free',
} as const;

/** All valid model alias keys */
export type ModelKey = keyof typeof models;

/**
 * Resolve a model alias to its full Mastra model ID string.
 *
 * Example: resolveModelId('gemini-2.5-flash') → 'google/gemini-2.5-flash'
 */
export function resolveModelId(key: ModelKey): string {
  return models[key];
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: AGENT ASSIGNMENTS
//
// Which model each registered agent uses. Change the alias to swap models.
// ═════════════════════════════════════════════════════════════════════════════

export const agentModels = {
  metaAgent:            'gemini-2.5-flash'    as ModelKey,
  codingAgent:          'gemini-2.5-pro'      as ModelKey,
  codeReviewAgent:      'gemini-2.5-flash'    as ModelKey,
  salesAgent:           'gemma4-26b'          as ModelKey,
  crmAgent:             'gemma4-26b'          as ModelKey,
  analyticsAgent:       'qwen3-coder-30b'     as ModelKey,
  weatherAgent:         'gemini-2.5-pro'      as ModelKey,
  automationArchitect:  'gemini-2.5-pro'      as ModelKey,
  marketingAgent:       'gpt-5.3-mini'        as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3: WORKFLOW ASSIGNMENTS
//
// Model assignments for individual workflow steps. Replaces the old
// modelPresets + workflowModels pattern in workflow-models.ts.
// ═════════════════════════════════════════════════════════════════════════════

export const workflowAssignments = {
  coding: {
    default:            'gemini-2.5-pro'      as ModelKey,  // diagnose-and-plan
    patch:              'gpt-5.3-mini'        as ModelKey,  // execute-patch fallback
    review:             'gemini-2.5-flash'    as ModelKey,  // code review
    selfHealingPlanner: 'gpt-5.3-mini'        as ModelKey,
    selfHealingReview:  'gemini-2.5-flash'    as ModelKey,
    jsonRepair:         'gpt-5.3-mini'        as ModelKey,
  },

  marketing: {
    default:            'gpt-5.3-mini'        as ModelKey,
  },

  weeklyContent: {
    research:           'gpt-5.3-mini'        as ModelKey,
    copyPl:             'gpt-5.3-mini'        as ModelKey,
    copyRepair:         'gpt-5.3-mini'        as ModelKey,
    translateEn:        'gpt-5.3-mini'        as ModelKey,
    jsonRepair:         'gpt-5.3-mini'        as ModelKey,
  },

  producerHunt: {
    discovery:          'gpt-5.3-mini'        as ModelKey,
    enrichment:         'gpt-5.3-mini'        as ModelKey,
    emailExtraction:    'gpt-5.3-mini'        as ModelKey,
    draftEmail:         'gpt-5.3-mini'        as ModelKey,
    jsonRepair:         'gpt-5.3-mini'        as ModelKey,
    cloudFallback:      'gemini-2.5-flash'    as ModelKey,
  },
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4: WORKER PRESETS (system.run_worker tool)
//
// Maps preset names to model aliases. Used by meta-agent's run_worker tool.
// ═════════════════════════════════════════════════════════════════════════════

export const workerPresets = {
  fast:       'gemma4-e4b'          as ModelKey,
  default:    'gemma4-26b'          as ModelKey,
  reasoning:  'qwen3-coder-30b'    as ModelKey,
  powerful:   'gemma4-26b'          as ModelKey,
  cloud:      'gemini-2.5-flash'   as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5: INFRASTRUCTURE
//
// Models for internal infrastructure: observational memory compression,
// embedding, and n8n workflow generation defaults.
// ═════════════════════════════════════════════════════════════════════════════

export const infrastructure = {
  /** Model used by Observational Memory to compress conversation history */
  observationalMemory:  'gemini-2.5-flash'    as ModelKey,

  /** N8n workflow generation defaults (used by automation-architect builders) */
  n8n: {
    defaultModel:       'gemma4-26b'          as ModelKey,
    reasoningModel:     'magistral-24b'       as ModelKey,
  },
} as const;

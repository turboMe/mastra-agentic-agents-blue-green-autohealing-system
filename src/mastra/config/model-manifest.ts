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
  // ═══════════════════════════════════════════════════════════════════════════
  // LOCAL (Ollama) — darmowe, prywatne, limitowane VRAM
  // ═══════════════════════════════════════════════════════════════════════════
  'qwen3-1.7b': 'ollama/local/qwen3:1.7b',
  'gemma3-4b': 'ollama/local/gemma3:4b',
  'gemma4-e4b': 'ollama/local/gemma4:e4b',
  'qwen3.5-9b': 'ollama/local/huihui_ai/qwen3.5-abliterated:9b',
  'qwen3-coder-30b': 'ollama/local/qwen3-coder:30b',
  'gemma4-26b': 'ollama/local/gemma4:26b',
  'phi4-reasoning-14b': 'ollama/local/phi4-reasoning:14b',
  'magistral-24b': 'ollama/local/magistral:24b',

  // ═══════════════════════════════════════════════════════════════════════════
  // GOOGLE (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  // ═══════════════════════════════════════════════════════════════════════════
  'gemini-2.5-pro': 'google/gemini-2.5-pro',           // flagship, 1M ctx, reasoning + code
  'gemini-2.5-flash': 'google/gemini-2.5-flash',         // fast, 1M ctx, daily driver
  'gemini-2.0-flash': 'google/gemini-2.0-flash',         // starszy flash, tańszy
  'gemini-2.0-flash-lite': 'google/gemini-2.0-flash-lite',    // najlżejszy Google, ultra-tani

  // ═══════════════════════════════════════════════════════════════════════════
  // OPENAI (klucz: OPENAI_API_KEY)
  // ═══════════════════════════════════════════════════════════════════════════
  'gpt-5.5': 'openai/gpt-5.5',                  // flagship, najnowszy
  'gpt-5.3-mini': 'openai/gpt-5.3-mini',             // szybki, tani, dobry do JSON
  'gpt-5.1': 'openai/gpt-5.1',                  // solidny, tańszy od 5.5
  'gpt-4.1': 'openai/gpt-4.1',                  // coding-focused, 1M ctx
  'gpt-4.1-mini': 'openai/gpt-4.1-mini',             // lekki, szybki, coding
  'gpt-4.1-nano': 'openai/gpt-4.1-nano',             // ultra-tani, klasyfikacja
  'o3': 'openai/o3',                        // deep reasoning (o-series)
  'o3-mini': 'openai/o3-mini',                   // reasoning, szybszy
  'o4-mini': 'openai/o4-mini',                   // najnowszy reasoning mini

  // ═══════════════════════════════════════════════════════════════════════════
  // ANTHROPIC (klucz: ANTHROPIC_API_KEY)
  // ═══════════════════════════════════════════════════════════════════════════
  'claude-opus-4.6': 'anthropic/claude-opus-4-6',        // flagship, 1M ctx, complex reasoning
  'claude-sonnet-4.6': 'anthropic/claude-sonnet-4-6',      // daily driver, best value
  'claude-haiku-4.5': 'anthropic/claude-haiku-4-5',       // fastest, cheapest

  // ═══════════════════════════════════════════════════════════════════════════
  // OPENROUTER FREE (klucz: OPENROUTER_API_KEY) — $0 cost, rate-limited
  // ═══════════════════════════════════════════════════════════════════════════
  'nemotron-super-free': 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  'nemotron-nano-free': 'openrouter/nvidia/nemotron-3-nano-30b-a3b:free',
  'laguna-free': 'openrouter/poolside/laguna-m.1:free',
  'ring-free': 'openrouter/inclusionai/ring-2.6-1t:free',
  'minimax-free': 'openrouter/minimax/minimax-m2.5:free',
  'glm-free': 'openrouter/z-ai/glm-4.5-air:free',
  'gpt-oss-120b-free': 'openrouter/openai/gpt-oss-120b:free',
  'gpt-oss-20b-free': 'openrouter/openai/gpt-oss-20b:free',

  // ═══════════════════════════════════════════════════════════════════════════
  // EMBEDDING — modele wektorowe (nie do generacji tekstu)
  // ═══════════════════════════════════════════════════════════════════════════
  'bge-m3': 'ollama/local/bge-m3',

  // ═══════════════════════════════════════════════════════════════════════════
  // IMAGE GENERATION — modele do generowania obrazów
  // ═══════════════════════════════════════════════════════════════════════════

  // Google Imagen 4 (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  'imagen-4-fast': 'google/imagen-4-fast',             // szybki, tańszy
  'imagen-4': 'google/imagen-4',                  // standard, dobra jakość
  'imagen-4-ultra': 'google/imagen-4-ultra',            // najwyższa jakość, photorealistic

  // Google Nano Banana (natywna generacja obrazów w Gemini)
  'gemini-image-flash': 'google/gemini-3.1-flash-image-preview',  // szybki, do 4K
  'gemini-image-pro': 'google/gemini-3-pro-image-preview',      // najwyższa jakość Gemini

  // OpenAI GPT Image (klucz: OPENAI_API_KEY)
  'gpt-image-2': 'openai/gpt-image-2',              // flagship, thinking mode, text rendering
  'gpt-image-1': 'openai/gpt-image-1',              // starszy, stabilny

  // OpenRouter FLUX (klucz: OPENROUTER_API_KEY — płatne, nie free)
  'flux-2-pro': 'openrouter/black-forest-labs/flux.2-pro',  // najwyższa jakość FLUX

  // ═══════════════════════════════════════════════════════════════════════════
  // VIDEO GENERATION — modele do generowania wideo
  // ═══════════════════════════════════════════════════════════════════════════

  // Google Veo (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  'veo-3.1': 'google/veo-3.1',                   // flagship, audio+video, 4K
  'veo-3.1-lite': 'google/veo-3.1-lite',              // lżejszy, tańszy

  // ═══════════════════════════════════════════════════════════════════════════
  // TTS (Text-to-Speech) — synteza mowy
  // ═══════════════════════════════════════════════════════════════════════════

  // OpenAI TTS (klucz: OPENAI_API_KEY)
  'tts-1': 'openai/tts-1',                     // real-time, niski latency
  'tts-1-hd': 'openai/tts-1-hd',                 // wyższa jakość, wolniejszy
  'gpt-4o-mini-tts': 'openai/gpt-4o-mini-tts',          // naturalny, emocje, 11+ głosów

  // Google TTS (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  'gemini-tts-flash': 'google/gemini-3.1-flash-tts',     // 70+ języków, tagi emocji [whispers] [laughs]

  // ═══════════════════════════════════════════════════════════════════════════
  // STT (Speech-to-Text) — transkrypcja mowy
  // ═══════════════════════════════════════════════════════════════════════════

  // OpenAI STT (klucz: OPENAI_API_KEY)
  'whisper-1': 'openai/whisper-1',                 // klasyczny, batch, multilingual
  'whisper-v3-turbo': 'openai/whisper-large-v3-turbo',   // szybszy, tańszy batch
  'gpt-4o-transcribe': 'openai/gpt-4o-transcribe',        // najdokładniejszy, hałas/akcenty
  'gpt-4o-mini-transcribe': 'openai/gpt-4o-mini-transcribe',   // lżejszy, tańszy

  // Google STT (klucz: GOOGLE_GENERATIVE_AI_API_KEY)
  'chirp-3': 'google/chirp-3',                   // 100+ języków, diaryzacja, denoiser

  // ═══════════════════════════════════════════════════════════════════════════
  // REALTIME VOICE — agenci głosowi (streaming audio in/out)
  // ═══════════════════════════════════════════════════════════════════════════

  // OpenAI Realtime (klucz: OPENAI_API_KEY)
  'gpt-realtime-2': 'openai/gpt-realtime-2',           // GPT-5 reasoning, voice agent, 128K ctx
  'gpt-realtime-translate': 'openai/gpt-realtime-translate',   // live tłumaczenie 70+ → 13 języków
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
  metaAgent: 'nemotron-super-free' as ModelKey,
  codingAgent: 'gemini-2.5-pro' as ModelKey,
  codeReviewAgent: 'gemini-2.5-flash' as ModelKey,
  salesAgent: 'gemma4-26b' as ModelKey,
  crmAgent: 'gemma4-26b' as ModelKey,
  analyticsAgent: 'qwen3-coder-30b' as ModelKey,
  weatherAgent: 'gemini-2.5-flash' as ModelKey,
  automationArchitect: 'gemini-2.5-pro' as ModelKey,
  marketingAgent: 'gemini-2.5-flash' as ModelKey,
  knowledgeAgent: 'gemini-2.5-flash' as ModelKey,   // NotebookLM ops — fast function calling for 35 MCP tools
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3: WORKFLOW ASSIGNMENTS
//
// Model assignments for individual workflow steps. Replaces the old
// modelPresets + workflowModels pattern in workflow-models.ts.
// ═════════════════════════════════════════════════════════════════════════════

export const workflowAssignments = {
  coding: {
    default: 'gemini-2.5-pro' as ModelKey,  // diagnose-and-plan
    patch: 'gemini-2.5-flash' as ModelKey,  // execute-patch fallback
    review: 'gemini-2.5-flash' as ModelKey,  // code review (Haiku: tani + dobry do walidacji)
    selfHealingPlanner: 'gemini-2.5-pro' as ModelKey,
    selfHealingReview: 'gemini-2.5-flash' as ModelKey,
    jsonRepair: 'gemini-2.5-flash' as ModelKey,
  },

  marketing: {
    default: 'gemini-2.5-flash' as ModelKey,
  },

  weeklyContent: {
    research: 'gemini-2.5-flash' as ModelKey,
    copyPl: 'gemini-2.5-flash' as ModelKey,
    copyRepair: 'gemini-2.5-flash' as ModelKey,
    translateEn: 'gemini-2.5-flash' as ModelKey,
    jsonRepair: 'gemini-2.5-flash' as ModelKey,
  },

  producerHunt: {
    discovery: 'gemini-2.5-flash' as ModelKey,
    enrichment: 'gemini-2.5-flash' as ModelKey,
    emailExtraction: 'gemini-2.5-flash' as ModelKey,
    draftEmail: 'gemini-2.5-flash' as ModelKey,
    jsonRepair: 'gemini-2.5-flash' as ModelKey,
    cloudFallback: 'gemini-2.5-flash' as ModelKey,
  },
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4: WORKER PRESETS (system.run_worker tool)
//
// Maps preset names to model aliases. Used by meta-agent's run_worker tool.
// ═════════════════════════════════════════════════════════════════════════════

export const workerPresets = {
  fast: 'gemma4-e4b' as ModelKey,
  default: 'gemma4-26b' as ModelKey,
  reasoning: 'magistral-24b' as ModelKey,
  powerful: 'gemma4-26b' as ModelKey,
  cloud: 'gemini-2.5-flash' as ModelKey,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5: INFRASTRUCTURE
//
// Models for internal infrastructure: observational memory compression,
// embedding, and n8n workflow generation defaults.
// ═════════════════════════════════════════════════════════════════════════════

export const infrastructure = {
  /** Model used by Observational Memory to compress conversation history */
  observationalMemory: 'gemini-2.5-flash' as ModelKey,

  /** Embedding model defaults (used by lib/embedder.ts) */
  embedding: {
    model: 'bge-m3' as ModelKey,
  },

  /** N8n workflow generation defaults (used by automation-architect builders) */
  n8n: {
    defaultModel: 'gemini-2.5-pro' as ModelKey,
    reasoningModel: 'gemini-2.5-pro' as ModelKey,
  },
} as const;

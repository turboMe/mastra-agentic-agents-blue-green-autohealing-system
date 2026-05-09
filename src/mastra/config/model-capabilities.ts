/**
 * Model Capability Registry
 *
 * Central registry of all available LLM models (local + cloud) with their
 * capabilities, safe context limits, VRAM requirements, and concurrent slots.
 *
 * Used by the Smart Router (Etap 8) to assign subtasks to the cheapest
 * capable model, respecting GPU memory limits and parallelism constraints.
 *
 * Context limits are conservative to prevent system freezes on RTX 5060 Ti (16 GB).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex';
export type ModelTier = 'local-micro' | 'local-light' | 'local-heavy' | 'cloud-fast' | 'cloud-pro';

export interface ModelCapability {
  /** Mastra model ID, e.g. 'ollama/local/qwen3:1.7b' or 'google/gemini-2.5-pro' */
  modelId: string;
  /** Human-readable display name */
  name: string;
  /** Tier determines routing priority and cost */
  tier: ModelTier;
  /** Highest complexity this model can handle reliably */
  maxComplexity: TaskComplexity;
  /** What this model is good at */
  strengths: string[];
  /** What this model struggles with */
  weaknesses: string[];
  /** VRAM usage in MB (0 for cloud models) */
  vramMb: number;
  /** Safe context window (num_ctx) — conservative to prevent freezes */
  safeContextWindow: number;
  /** How many instances can run concurrently (GPU slot limit for local) */
  concurrentSlots: number;
  /** Relative cost per call (0 = free local, 1-10 = cloud) */
  costPerCall: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Is model currently available? (checked at startup) */
  available: boolean;
}

// ── Complexity ordering ──────────────────────────────────────────────────────

const COMPLEXITY_ORDER: Record<TaskComplexity, number> = {
  trivial: 0,
  simple: 1,
  moderate: 2,
  complex: 3,
};

export function complexityMeetsRequirement(
  modelMax: TaskComplexity,
  required: TaskComplexity,
): boolean {
  return COMPLEXITY_ORDER[modelMax] >= COMPLEXITY_ORDER[required];
}

// ── Local models (Ollama) ────────────────────────────────────────────────────

const localModels: ModelCapability[] = [
  // ── Tier: local-micro — router, JSON, classifier ──
  {
    modelId: 'ollama/local/qwen3:1.7b',
    name: 'Qwen 3 1.7B',
    tier: 'local-micro',
    maxComplexity: 'trivial',
    strengths: ['json-extraction', 'classification', 'routing', 'fast'],
    weaknesses: ['code-generation', 'multi-file', 'reasoning'],
    vramMb: 2000,
    safeContextWindow: 32768,
    concurrentSlots: 3,   // Lekki — kilka instancji jednocześnie
    costPerCall: 0,
    avgLatencyMs: 2000,
    available: true,
  },

  // ── Tier: local-light — simple edits, tool calling ──
  {
    modelId: 'ollama/local/gemma3:4b',
    name: 'Gemma 3 4B',
    tier: 'local-light',
    maxComplexity: 'simple',
    strengths: ['simple-edits', 'config-changes', 'imports', 'fast'],
    weaknesses: ['complex-code', 'architecture', 'multi-file'],
    vramMb: 4000,
    safeContextWindow: 16384,
    concurrentSlots: 2,
    costPerCall: 0,
    avgLatencyMs: 4000,
    available: true,
  },
  {
    modelId: 'ollama/local/gemma4:e4b',
    name: 'Gemma 4 E4B (MoE 26B/4B)',
    tier: 'local-light',
    maxComplexity: 'moderate',
    strengths: ['typescript', 'reasoning', 'tool-calling', 'multimodal', 'single-file-edit'],
    weaknesses: ['very-complex-refactors'],
    vramMb: 10000,
    safeContextWindow: 8192,
    concurrentSlots: 1,
    costPerCall: 0,
    avgLatencyMs: 8000,
    available: true,
  },
  {
    modelId: 'ollama/local/huihui_ai/qwen3.5-abliterated:9b',
    name: 'Qwen 3.5 9B (abliterated)',
    tier: 'local-light',
    maxComplexity: 'simple',
    strengths: ['typescript', 'edits', 'tool-calling', 'uncensored'],
    weaknesses: ['complex-reasoning', 'multi-file'],
    vramMb: 7000,
    safeContextWindow: 8192,
    concurrentSlots: 1,
    costPerCall: 0,
    avgLatencyMs: 6000,
    available: true,
  },

  // ── Tier: local-heavy — solo mode, limited context ──
  {
    modelId: 'ollama/local/qwen3-coder:30b',
    name: 'Qwen 3 Coder 30B (MoE 30B/3B)',
    tier: 'local-heavy',
    maxComplexity: 'moderate',
    strengths: ['code-generation', 'refactor', 'typescript', 'agent-coding'],
    weaknesses: ['architecture', 'very-long-context'],
    vramMb: 18000,
    safeContextWindow: 4096,    // ⚠️ Wyżej = freeze risk!
    concurrentSlots: 1,          // Solo — zajmuje cały GPU
    costPerCall: 0,
    avgLatencyMs: 15000,
    available: true,
  },
  {
    modelId: 'ollama/local/gemma4:26b',
    name: 'Gemma 4 26B (MoE 26B/4B)',
    tier: 'local-heavy',
    maxComplexity: 'moderate',
    strengths: ['reasoning', 'analysis', 'code-understanding', 'multimodal'],
    weaknesses: ['very-long-context', 'speed'],
    vramMb: 17000,
    safeContextWindow: 4096,    // ⚠️ Tight na 16GB VRAM
    concurrentSlots: 1,
    costPerCall: 0,
    avgLatencyMs: 12000,
    available: true,
  },
  {
    modelId: 'ollama/local/huihui_ai/qwen3.5-abliterated:35b',
    name: 'Qwen 3.5 35B (abliterated)',
    tier: 'local-heavy',
    maxComplexity: 'moderate',
    strengths: ['reasoning', 'uncensored', 'code-generation'],
    weaknesses: ['speed', 'vram-overflow', 'stability'],
    vramMb: 23000,
    safeContextWindow: 2048,    // ❌ Wymaga swap — ultra-conservative
    concurrentSlots: 1,
    costPerCall: 0,
    avgLatencyMs: 30000,
    available: true,
  },
];

// ── Cloud models ─────────────────────────────────────────────────────────────

const cloudModels: ModelCapability[] = [
  // ── Tier: cloud-fast — szybkie, tanie ──
  {
    modelId: 'openai/gpt-5.3-mini',
    name: 'GPT-5.3 Mini',
    tier: 'cloud-fast',
    maxComplexity: 'moderate',
    strengths: ['fast', 'typescript', 'json', 'simple-edits', 'tool-calling'],
    weaknesses: ['complex-architecture'],
    vramMb: 0,
    safeContextWindow: 128000,
    concurrentSlots: 10,
    costPerCall: 1,
    avgLatencyMs: 3000,
    available: true,
  },
  {
    modelId: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    tier: 'cloud-fast',
    maxComplexity: 'moderate',
    strengths: ['fast', 'code-review', 'analysis', 'multi-file', 'long-context'],
    weaknesses: ['very-complex-refactors'],
    vramMb: 0,
    safeContextWindow: 1000000,
    concurrentSlots: 10,
    costPerCall: 2,
    avgLatencyMs: 4000,
    available: true,
  },
  {
    modelId: 'anthropic/claude-haiku-4-6',
    name: 'Claude Haiku 4.6',
    tier: 'cloud-fast',
    maxComplexity: 'simple',
    strengths: ['fast', 'review', 'validation', 'json'],
    weaknesses: ['complex-code', 'architecture'],
    vramMb: 0,
    safeContextWindow: 200000,
    concurrentSlots: 10,
    costPerCall: 1,
    avgLatencyMs: 2000,
    available: true,
  },

  // ── Tier: cloud-pro — pełna moc ──
  {
    modelId: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['architecture', 'multi-file-refactor', 'reasoning', 'planning', 'long-context'],
    weaknesses: [],
    vramMb: 0,
    safeContextWindow: 1000000,
    concurrentSlots: 5,
    costPerCall: 8,
    avgLatencyMs: 10000,
    available: true,
  },
  {
    modelId: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['architecture', 'complex-code', 'reasoning', 'planning'],
    weaknesses: [],
    vramMb: 0,
    safeContextWindow: 200000,
    concurrentSlots: 5,
    costPerCall: 10,
    avgLatencyMs: 8000,
    available: true,
  },
  {
    modelId: 'anthropic/claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    tier: 'cloud-pro',
    maxComplexity: 'complex',
    strengths: ['code-generation', 'architecture', 'reasoning', 'safety'],
    weaknesses: [],
    vramMb: 0,
    safeContextWindow: 200000,
    concurrentSlots: 5,
    costPerCall: 8,
    avgLatencyMs: 6000,
    available: true,
  },
];

// ── Embedding models (not for routing, but documented) ───────────────────────

// ollama/local/bge-m3 — 1.2 GB, embedding only
// ollama/local/nomic-embed-text — 274 MB, embedding only

// ── Registry ─────────────────────────────────────────────────────────────────

export const modelRegistry: ModelCapability[] = [...localModels, ...cloudModels];

/**
 * Get all models that can handle a given complexity level.
 * Sorted by cost (cheapest first), then by latency.
 */
export function getCapableModels(
  requiredComplexity: TaskComplexity,
  preferLocal: boolean = true,
): ModelCapability[] {
  return modelRegistry
    .filter((m) => m.available && complexityMeetsRequirement(m.maxComplexity, requiredComplexity))
    .sort((a, b) => {
      // Local preference if requested
      if (preferLocal) {
        const aLocal = a.tier.startsWith('local') ? 0 : 1;
        const bLocal = b.tier.startsWith('local') ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
      }
      // Then by cost
      if (a.costPerCall !== b.costPerCall) return a.costPerCall - b.costPerCall;
      // Then by latency
      return a.avgLatencyMs - b.avgLatencyMs;
    });
}

/**
 * Get the cheapest model that can handle a given complexity.
 * Falls back to cloud if no local model available.
 */
export function getCheapestCapableModel(
  requiredComplexity: TaskComplexity,
): ModelCapability | undefined {
  return getCapableModels(requiredComplexity, true)[0];
}

/**
 * Total VRAM budget in MB (from GPU).
 * Override via env: MODEL_VRAM_BUDGET_MB
 */
export const VRAM_BUDGET_MB = parseInt(process.env.MODEL_VRAM_BUDGET_MB ?? '15000', 10);

/**
 * Central model routing for Mastra workflows.
 *
 * Change models here, restart Mastra, and workflows/agents that import this
 * file will pick up the new runtime model assignment.
 */

export const modelPresets = {
  // Local / private / cheapest
  localMarketing: 'openai/gpt-5.3-mini',
  localReasoning: 'ollama/local/gemma4:26b',
  localPowerful: 'ollama/local/gemma4:26b',
  //localReasoning: 'ollama/local/qwen3-coder:30b',
  //localPowerful: 'ollama/local/qwen3.5-abliterated:35b',

  // Google
  googlePro: 'google/gemini-2.5-pro',
  googleFlash: 'google/gemini-2.5-flash',

  // OpenAI
  openaiPro: 'openai/gpt-5.5',
  openaiMini: 'openai/gpt-5.3-mini',

  // Anthropic
  anthropicSonnet: 'anthropic/claude-sonnet-4-6',
  anthropicHaiku: 'anthropic/claude-haiku-4-6',
} as const;

export const workflowModels = {
  marketing: {
    // Used by the general registered marketingAgent and non-weekly-content marketing workflows.
    default: modelPresets.localMarketing,
  },

  weeklyContent: {
    // Good local/default split. To use cloud copy, change copyPl to e.g.
    // modelPresets.googlePro, modelPresets.openaiPro, or modelPresets.anthropicSonnet.
    research: modelPresets.localMarketing,
    copyPl: modelPresets.localMarketing,
    copyRepair: modelPresets.localMarketing,
    translateEn: modelPresets.localMarketing,
    jsonRepair: modelPresets.localMarketing,
  },

  producerHunt: {
    // Discovery/enrichment can stay local for cheaper exploratory work.
    // For better outreach quality, draftEmail is the first step worth moving to cloud.
    discovery: modelPresets.localMarketing,
    enrichment: modelPresets.localMarketing,
    emailExtraction: modelPresets.localMarketing,
    draftEmail: modelPresets.localMarketing,
    jsonRepair: modelPresets.localMarketing,
    cloudFallback: modelPresets.googleFlash,
  },

  coding: {
    // Master agents — static model assignment
    default: modelPresets.googlePro,       // diagnose-and-plan (needs reasoning)
    patch: modelPresets.openaiMini,        // execute-patch fallback (when no diagnosticPlan)
    review: modelPresets.googleFlash,      // code review
    selfHealingPlanner: modelPresets.openaiMini,
    selfHealingReview: modelPresets.googleFlash,
    jsonRepair: modelPresets.openaiMini,
    // Worker routing is DYNAMIC via SmartRouter (config/model-capabilities.ts).
    // Each subtask gets assigned based on complexity, VRAM budget, and cost.
    // See: services/smart-router.ts
  },
} as const;

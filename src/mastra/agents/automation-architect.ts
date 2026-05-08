import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import {
  n8nTriggerWebhookTool,
  n8nHealthTool,
  n8nListWorkflowsTool,
  n8nGetWorkflowTool,
} from '../tools/n8n/n8n-tools.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { riskScoringTool } from '../tools/architect/risk-scoring.js';
import { skillsSearchTool } from '../tools/architect/skills-search.js';
import { syncPatternsTool, matchPatternTool } from '../tools/architect/pattern-rag.js';
import { composeWorkflowTool } from '../tools/architect/composer.js';
import { deployAutomationTool } from '../tools/architect/deploy.js';
import { activateAutomationTool } from '../tools/architect/activate.js';
import { runtimeCheckTool } from '../tools/architect/runtime-check.js';
import { resolveCredentialsTool } from '../tools/architect/credentials/credential-tools.js';
import { validateWorkflowTool } from '../tools/architect/validation/validation-tool.js';
import { testWorkflowTool } from '../tools/architect/testing/test-workflow.js';
import { repairWorkflowTool } from '../tools/architect/testing/repair-workflow.js';
import { loadPrompt } from '../lib/prompt-loader.js';

export const automationArchitect = new Agent({
  id: 'automation-architect',
  name: 'Automation Architect',
  instructions: await loadPrompt('automation/base'),
  // gemini-2.5-pro: best reasoning for n8n JSON synthesis. Flash sometimes
  // emits Python-style booleans (`True`/`False`) and bails to empty text on
  // tool errors, so it's a poor fallback for this agent.
  // maxRetries handles the occasional AGENT_STREAM_ERROR (finishReason="error"
  // with no payload) that Gemini Pro produces in long tool-call chains.
  model: 'google/gemini-2.5-pro',
  maxRetries: 3,
  memory: new Memory({
    options: {
      lastMessages: 20,
    },
  }),
  tools: {
    // n8n management
    n8nHealthTool,
    n8nListWorkflowsTool,
    n8nGetWorkflowTool,
    n8nTriggerWebhookTool,
    // Risk & knowledge
    riskScoringTool,
    skillsSearchTool,
    // Pattern RAG & composer
    syncPatternsTool,
    matchPatternTool,
    composeWorkflowTool,
    // Runtime validation
    runtimeCheckTool,
    resolveCredentialsTool,
    validateWorkflowTool,
    // Deploy with guardrails
    deployAutomationTool,
    activateAutomationTool,
    // Test & repair loop
    testWorkflowTool,
    repairWorkflowTool,
    // Human approval gate
    requestApprovalTool,
  },
});

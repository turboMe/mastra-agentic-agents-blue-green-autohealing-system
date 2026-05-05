import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import {
  n8nTriggerWebhookTool,
  n8nHealthTool,
  n8nListWorkflowsTool,
  n8nGetWorkflowTool,
  n8nUpdateWorkflowTool,
  n8nActivateWorkflowTool,
  n8nDeactivateWorkflowTool,
} from '../tools/n8n/n8n-tools.js';
import { requestApprovalTool } from '../tools/system/request-approval.js';
import { riskScoringTool } from '../tools/architect/risk-scoring.js';
import { skillsSearchTool } from '../tools/architect/skills-search.js';
import { syncPatternsTool, matchPatternTool } from '../tools/architect/pattern-rag.js';
import { composeWorkflowTool } from '../tools/architect/composer.js';
import { deployAutomationTool } from '../tools/architect/deploy.js';
import { loadPrompt } from '../lib/prompt-loader.js';

export const automationArchitect = new Agent({
  id: 'automation-architect',
  name: 'Automation Architect',
  instructions: await loadPrompt('automation/base'),
  model: 'google/gemini-2.5-pro',
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
    n8nUpdateWorkflowTool,
    n8nActivateWorkflowTool,
    n8nDeactivateWorkflowTool,
    n8nTriggerWebhookTool,
    // Risk & knowledge
    riskScoringTool,
    skillsSearchTool,
    // Pattern RAG & composer
    syncPatternsTool,
    matchPatternTool,
    composeWorkflowTool,
    // Deploy with guardrails
    deployAutomationTool,
    // Human approval gate
    requestApprovalTool,
  },
});

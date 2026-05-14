import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { validateWorkflow } from './workflow-validator.js';
import { withToolEnvelope } from '../../../services/harness-tool-envelope.js';
import { compactAutomationResultForModel } from '../../../services/automation-output-compaction.js';

export const validateWorkflowTool = createTool({
  id: 'architect_validate_workflow',
  description: 'Wykonuje twarda walidacje struktury i bezpieczenstwa workflow n8n.',
  inputSchema: z.object({
    workflow: z.any().describe('Workflow JSON do walidacji'),
    profile: z.enum(['draft', 'strict', 'activation']).default('strict'),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    profile: z.string(),
    errors: z.array(z.any()),
    warnings: z.array(z.any()),
    securityIssues: z.array(z.any()),
    missingCredentials: z.array(z.any()),
    missingConfig: z.array(z.any()),
    nodeCount: z.number(),
    connectionCount: z.number(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    outputCompaction: z.any().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'architect_validate_workflow',
    category: 'other',
    risk: 'low',
    defaultAgentId: 'automationArchitect',
    redactInputFields: ['workflow'],
    policy: (input: any) => ({
      agentId: 'automationArchitect',
      action: 'compose_automation' as const,
      riskHint: 'low' as const,
    }),
    execute: async (context: any) => {
    return validateWorkflow(context.workflow, context.profile);
    },
    modelOutput: (output, _input, metadata) => compactAutomationResultForModel(output, metadata),
  }),
});

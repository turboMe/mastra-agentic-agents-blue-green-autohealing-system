import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { validateWorkflow } from './workflow-validator.js';

export const validateWorkflowTool = createTool({
  id: 'architect.validate_workflow',
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
  }),
  execute: async (context) => {
    return validateWorkflow(context.workflow, context.profile);
  },
});

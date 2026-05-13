import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { executeAutomationGoldenPath } from '../../services/automation-golden-path.js';

export const executeAutomationRequestTool = createTool({
  id: 'architect_execute_automation_request',
  description:
    'Jedna deterministyczna bramka Golden Path: pattern/file/json -> validate -> risk -> deploy inactive -> mock test -> repair loop -> optional activate.',
  inputSchema: z.object({
    mode: z.enum(['pattern', 'workflow_file', 'workflow_json']),
    request: z.string().optional().describe('Original user request or concise task brief.'),
    patternId: z.string().optional().describe('Pattern id for mode=pattern.'),
    spec: z.any().optional().describe('AutomationSpec for mode=pattern.'),
    workflow: z.any().optional().describe('Workflow JSON object for mode=workflow_json.'),
    workflowFilePath: z.string().optional().describe('Workflow JSON file path for mode=workflow_file.'),
    workflowName: z.string().optional(),
    workflowId: z.string().optional().describe('Existing n8n workflow id for update.'),
    automationId: z.string().optional(),
    approvalToken: z.string().optional(),
    activate: z.boolean().optional().default(false),
    allowDraftWithMissingCredentials: z.boolean().optional().default(true),
    requiresPublicWebhook: z.boolean().optional().default(false),
  }),
  outputSchema: z.any(),
  execute: async (context) => {
    return executeAutomationGoldenPath(context as any);
  },
});

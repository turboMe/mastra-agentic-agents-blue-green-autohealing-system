import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

import {
  executeAutomationGoldenPath,
  type AutomationGoldenPathInput,
} from '../../services/automation-golden-path.js';
import { startAutomationJob } from '../../services/automation-job-manager.js';
import { withToolEnvelope, type ToolEnvelopeMetadata } from '../../services/harness-tool-envelope.js';

const goldenPathInputSchema = z.object({
  mode: z.enum(['pattern', 'workflow_file', 'workflow_json']),
  request: z.string().optional(),
  patternId: z.string().optional(),
  spec: z.any().optional(),
  workflow: z.any().optional(),
  workflowFilePath: z.string().optional(),
  workflowName: z.string().optional(),
  workflowId: z.string().optional(),
  automationId: z.string().optional(),
  approvalToken: z.string().optional(),
  activate: z.boolean().optional().default(false),
  allowDraftWithMissingCredentials: z.boolean().optional().default(true),
  requiresPublicWebhook: z.boolean().optional().default(false),
});

const startAutomationRequestInputSchema = goldenPathInputSchema.extend({
  executionMode: z.enum(['job', 'sync']).optional().default('job'),
  callerAgentId: z.enum(['meta-agent', 'automationArchitect']).optional().default('meta-agent'),
  callerThreadId: z.string().optional(),
  originAgentId: z.string().optional(),
  originThreadId: z.string().optional(),
  returnToAgentId: z.enum(['meta-agent', 'automationArchitect']).optional(),
  returnToThreadId: z.string().optional(),
  wake: z.boolean().optional().default(true),
});

type StartAutomationRequestInput = z.infer<typeof startAutomationRequestInputSchema>;
const LARGE_WORKFLOW_JSON_BYTES = 20 * 1024;
const WORKFLOW_FILE_ROOT = '/tmp/mastra-automation-workflows';

export async function startAutomationRequest(
  context: StartAutomationRequestInput,
  metadata: (ToolEnvelopeMetadata & { agentId?: string; runId?: string; toolId?: string }) = {},
) {
  const input = await toGoldenPathInput(context);
  const callerAgentId = context.callerAgentId ?? (metadata.agentId as 'meta-agent' | 'automationArchitect' | undefined) ?? 'meta-agent';
  const callerThreadId = context.callerThreadId ?? metadata.threadId;
  const returnToAgentId = context.returnToAgentId ?? callerAgentId;
  const returnToThreadId = context.returnToThreadId ?? callerThreadId ?? metadata.threadId;

  if ((context.executionMode ?? 'job') === 'sync') {
    const result = await executeAutomationGoldenPath(input);
    return {
      success: result.success,
      executionMode: 'sync' as const,
      status: result.status,
      automationId: result.automationId,
      workflowId: result.workflowId,
      workflowName: result.workflowName,
      result,
      message: result.message,
    };
  }

  const record = await startAutomationJob({
    input,
    targetAgentId: 'automationArchitect',
    callerAgentId,
    callerThreadId,
    originAgentId: context.originAgentId ?? callerAgentId,
    originThreadId: context.originThreadId ?? callerThreadId,
    returnToAgentId,
    returnToThreadId,
    wake: context.wake ?? true,
    runId: metadata.runId,
    turnId: metadata.turnId,
  });

  return {
    success: true,
    executionMode: 'job' as const,
    jobId: record.jobId,
    automationId: record.automationId,
    status: record.status,
    targetAgentId: record.targetAgentId,
    returnToAgentId: record.returnToAgentId,
    returnToThreadId: record.returnToThreadId,
    message: `Structured automation Golden Path job started: ${record.jobId}`,
  };
}

export const startAutomationRequestTool = createTool({
  id: 'system_start_automation_request',
  description:
    'Structural bridge from meta-agent to Automation Golden Path. Use when you already have pattern/file/workflow JSON input; do not pass large workflow JSON as a text delegation prompt.',
  inputSchema: startAutomationRequestInputSchema,
  outputSchema: z.any(),
  execute: withToolEnvelope({
    toolId: 'system_start_automation_request',
    category: 'network',
    risk: 'high',
    defaultAgentId: 'meta-agent',
    redactInputFields: ['workflow', 'spec', 'approvalToken'],
    policy: (input: any, metadata) => ({
      agentId: metadata.agentId ?? input.callerAgentId ?? 'meta-agent',
      action: 'deploy_automation' as const,
      target: input.workflowId ?? input.workflowName ?? input.patternId ?? input.automationId ?? 'automation_request',
      riskHint: 'high' as const,
    }),
    execute: async (context: any, metadata) => startAutomationRequest(context, metadata),
  }),
});

async function toGoldenPathInput(context: StartAutomationRequestInput): Promise<AutomationGoldenPathInput> {
  const input: AutomationGoldenPathInput = {
    mode: context.mode,
    request: context.request,
    patternId: context.patternId,
    spec: context.spec,
    workflow: context.workflow,
    workflowFilePath: context.workflowFilePath,
    workflowName: context.workflowName,
    workflowId: context.workflowId,
    automationId: context.automationId,
    approvalToken: context.approvalToken,
    activate: context.activate,
    allowDraftWithMissingCredentials: context.allowDraftWithMissingCredentials,
    requiresPublicWebhook: context.requiresPublicWebhook,
  };

  if (input.mode === 'workflow_json' && input.workflow && typeof input.workflow === 'object') {
    const json = JSON.stringify(input.workflow, null, 2);
    if (Buffer.byteLength(json, 'utf8') > LARGE_WORKFLOW_JSON_BYTES) {
      await mkdir(WORKFLOW_FILE_ROOT, { recursive: true });
      const workflowName = input.workflowName ?? readableWorkflowName(input.workflow);
      const filePath = join(WORKFLOW_FILE_ROOT, `${safeFileStem(workflowName ?? input.automationId ?? 'workflow')}-${randomUUID()}.json`);
      await writeFile(filePath, json, 'utf8');
      return {
        ...input,
        mode: 'workflow_file',
        workflow: undefined,
        workflowFilePath: filePath,
        workflowName,
      };
    }
  }

  return input;
}

function readableWorkflowName(workflow: unknown): string | undefined {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return undefined;
  const name = (workflow as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function safeFileStem(value: string): string {
  const stem = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return stem.slice(0, 80) || 'workflow';
}

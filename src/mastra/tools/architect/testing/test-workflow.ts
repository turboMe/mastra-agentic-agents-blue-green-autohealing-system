import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { N8nService } from '../../n8n/client.js';
import { getDb } from '../../../lib/mongo.js';
import { validateWorkflow } from '../validation/workflow-validator.js';
import { generateMockPayload } from './mock-data.js';
import { analyzeExecution } from './execution-analyzer.js';
import type { TestFinding, TestStatus } from './test-types.js';

export const testWorkflowTool = createTool({
  id: 'architect.test_workflow',
  description:
    'Testuje workflow Mastry. Tryby: mock (validation + test plan, bez wykonania), manual (instrukcje dla uzytkownika), real_credentials (rzeczywiste wykonanie i analiza execution). Wymaga ze workflow jest mastra-managed.',
  inputSchema: z.object({
    automationId: z.string().describe('ID automatyzacji z deploy_automation'),
    workflowId: z.string().describe('ID workflow w n8n'),
    mode: z.enum(['mock', 'manual', 'real_credentials']).describe('Tryb testu'),
    payload: z.any().optional().describe('Opcjonalny custom payload (nadpisuje mock)'),
    approvalToken: z.string().optional().describe('Wymagany dla real_credentials gdy risk >= medium'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.enum(['passed', 'failed', 'manual_required', 'blocked']),
    mode: z.string(),
    automationId: z.string(),
    workflowId: z.string(),
    executionId: z.string().optional(),
    findings: z.array(
      z.object({
        severity: z.enum(['error', 'warning', 'info']),
        nodeName: z.string().optional(),
        message: z.string(),
        suggestedFix: z.string().optional(),
      }),
    ),
    testPlan: z.array(z.string()).optional(),
    message: z.string(),
  }),
  execute: async (context) => {
    const { automationId, workflowId, mode } = context;
    const db = await getDb();

    // 1. Ownership check — only test mastra-managed workflows
    const automation = await db.collection('automation_requests').findOne({ automationId });
    if (!automation) {
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [{ severity: 'error' as const, message: `automationId=${automationId} not found in registry.` }],
        message: 'Test blocked: automation not registered.',
      };
    }
    if (automation.managedBy !== 'mastra') {
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [
          {
            severity: 'error' as const,
            message: `Automation managedBy=${automation.managedBy}, not mastra. Test refused.`,
          },
        ],
        message: 'Test blocked: workflow not managed by Mastra.',
      };
    }
    if (automation.n8nWorkflowId !== workflowId) {
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [
          {
            severity: 'error' as const,
            message: `workflowId mismatch: automation expects ${automation.n8nWorkflowId}, received ${workflowId}.`,
          },
        ],
        message: 'Test blocked: workflowId mismatch.',
      };
    }

    // 2. Fetch the live workflow
    const n8n = new N8nService();
    let workflow: any;
    try {
      workflow = await n8n.getWorkflow(workflowId);
    } catch (error) {
      return {
        success: false,
        status: 'failed' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [{ severity: 'error' as const, message: `Could not read workflow from n8n: ${(error as Error).message}` }],
        message: 'Test failed: workflow unreachable.',
      };
    }

    // 3. Always run strict validation — mock mode stops here.
    const validation = validateWorkflow(workflow, 'strict');
    const findings: TestFinding[] = [];
    for (const e of validation.errors) findings.push({ severity: 'error', nodeName: e.nodeName, message: e.message });
    for (const w of validation.warnings) findings.push({ severity: 'warning', nodeName: w.nodeName, message: w.message });
    for (const s of validation.securityIssues) findings.push({ severity: 'error', nodeName: s.nodeName, message: `[security] ${s.message}` });
    for (const c of validation.missingCredentials) findings.push({ severity: 'error', message: `Missing credential: ${c.service} — ${c.setupHint}` });
    for (const c of validation.missingConfig) findings.push({ severity: 'error', message: `Missing config: ${c.key} — ${c.description}` });

    if (mode === 'mock') {
      const mock = generateMockPayload(workflow);
      const status: TestStatus = validation.valid ? 'passed' : 'failed';
      await persistTestEvent(automationId, mode, status, findings);
      return {
        success: validation.valid,
        status,
        mode,
        automationId,
        workflowId,
        findings,
        testPlan: [`Trigger detected: ${mock.triggerType}`, ...mock.instructions],
        message: validation.valid
          ? 'Mock test passed: validation OK, test plan generated.'
          : 'Mock test failed: workflow ma bledy walidacji. Uzyj architect.repair_workflow.',
      };
    }

    if (mode === 'manual') {
      const mock = generateMockPayload(workflow);
      await persistTestEvent(automationId, mode, 'manual_required', findings);
      return {
        success: true,
        status: 'manual_required' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings,
        testPlan: [
          `1. Otworz workflow w n8n: ${n8n.getEditorUrl()}/workflow/${workflowId}`,
          `2. Trigger: ${mock.triggerType}`,
          ...mock.instructions.map((s, i) => `${i + 3}. ${s}`),
          `Po teste uruchom architect.test_workflow w trybie real_credentials zeby zanalizowac execution.`,
        ],
        message: 'Manual test plan ready — wykonaj kroki w n8n UI.',
      };
    }

    // mode === 'real_credentials'
    if (!validation.valid) {
      await persistTestEvent(automationId, mode, 'blocked', findings);
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings,
        message: 'Real test blocked: validation failed. Uzyj architect.repair_workflow lub fix specu.',
      };
    }

    // Risk-based approval gate for real execution
    const riskScore = automation.riskScore ?? 0;
    if (riskScore >= 20 && !context.approvalToken) {
      await persistTestEvent(automationId, mode, 'blocked', findings);
      return {
        success: false,
        status: 'blocked' as TestStatus,
        mode,
        automationId,
        workflowId,
        findings: [
          ...findings,
          { severity: 'error' as const, message: `Real test wymaga approvalToken (risk=${riskScore}).` },
        ],
        message: `Real test blocked: workflow risk=${riskScore} requires approval.`,
      };
    }
    if (context.approvalToken) {
      const approval = await db.collection('approvals').findOne({ id: context.approvalToken });
      if (!approval || approval.status !== 'approved') {
        return {
          success: false,
          status: 'blocked' as TestStatus,
          mode,
          automationId,
          workflowId,
          findings,
          message: `Invalid or unapproved approvalToken: ${context.approvalToken}`,
        };
      }
    }

    // Try executeWorkflow REST endpoint (community-edition support varies).
    let execution: any;
    let executionId: string | undefined;
    try {
      const mock = generateMockPayload(workflow);
      const inputData = context.payload ?? mock.payload;
      execution = await n8n.executeWorkflow(workflowId, inputData);
      executionId = execution?.id ?? execution?.executionId;
    } catch (error) {
      const msg = (error as Error).message;
      // Common: "404 not found" on community edition where /run is gated.
      // Fall back to fetching latest execution which may have been triggered manually.
      const recent = await n8n.getExecutions({ workflowId, limit: 1 }).catch(() => []);
      if (recent.length > 0) {
        execution = await n8n.getExecution(recent[0].id).catch(() => null);
        executionId = recent[0].id;
      } else {
        await persistTestEvent(automationId, mode, 'failed', findings);
        return {
          success: false,
          status: 'failed' as TestStatus,
          mode,
          automationId,
          workflowId,
          findings: [
            ...findings,
            {
              severity: 'error' as const,
              message: `Could not execute or fetch any execution: ${msg}`,
              suggestedFix: 'n8n Community moze nie obslugiwac /run — uruchom manualnie i ponow test.',
            },
          ],
          message: 'Real test failed: no execution data.',
        };
      }
    }

    const analysis = analyzeExecution(execution);
    const allFindings = [...findings, ...analysis.findings];
    const status: TestStatus = analysis.ok && validation.valid ? 'passed' : 'failed';
    await persistTestEvent(automationId, mode, status, allFindings, executionId);

    return {
      success: analysis.ok,
      status,
      mode,
      automationId,
      workflowId,
      executionId,
      findings: allFindings,
      message: analysis.ok
        ? `Real test passed (executionId=${executionId ?? 'n/a'}).`
        : 'Real test failed — sprawdz findings i uzyj architect.repair_workflow.',
    };
  },
});

async function persistTestEvent(
  automationId: string,
  mode: string,
  status: string,
  findings: TestFinding[],
  executionId?: string,
) {
  try {
    const db = await getDb();
    await db.collection('automation_events').insertOne({
      automationId,
      type: 'test_run',
      data: { mode, status, executionId, findings },
      createdAt: new Date(),
    });
    await db
      .collection('automation_requests')
      .updateOne(
        { automationId },
        { $set: { lastTest: { mode, status, executionId, findings, at: new Date() }, updatedAt: new Date() } },
      );
  } catch {
    // never block test on audit failure
  }
}

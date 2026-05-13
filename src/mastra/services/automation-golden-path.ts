import { readFile } from 'fs/promises';
import { isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';

import { getRuntimeTopology } from '../config/runtime-topology.js';
import { getDb } from '../lib/mongo.js';
import { N8nService } from '../tools/n8n/client.js';
import { getPatternById } from '../tools/architect/pattern-catalog.js';
import type { AutomationSpec } from '../tools/architect/types.js';
import {
  normalizeConnectionKeys,
  validateWorkflow,
} from '../tools/architect/validation/workflow-validator.js';
import type { ValidationFinding, ValidationResult } from '../tools/architect/validation/validation-types.js';
import { analyzeWorkflow } from '../tools/architect/risk-scoring.js';
import { getCredentialFromRegistry } from '../tools/architect/credentials/credential-registry.js';
import { generateMockPayload } from '../tools/architect/testing/mock-data.js';
import { applyRepairs } from '../tools/architect/testing/repair-workflow.js';
import type { TestFinding } from '../tools/architect/testing/test-types.js';

export type AutomationGoldenPathMode = 'pattern' | 'workflow_file' | 'workflow_json';

export type AutomationGoldenPathStatus =
  | 'blocked'
  | 'draft_created'
  | 'tested'
  | 'active'
  | 'manual_review_required';

export type AutomationGoldenPathStepStatus = 'success' | 'warning' | 'blocked' | 'failed' | 'skipped';

export type AutomationGoldenPathStep = {
  name: string;
  status: AutomationGoldenPathStepStatus;
  message: string;
  data?: Record<string, unknown>;
};

export type AutomationGoldenPathInput = {
  mode: AutomationGoldenPathMode;
  request?: string;
  patternId?: string;
  spec?: AutomationSpec;
  workflow?: unknown;
  workflowFilePath?: string;
  workflowName?: string;
  workflowId?: string;
  automationId?: string;
  approvalToken?: string;
  activate?: boolean;
  allowDraftWithMissingCredentials?: boolean;
  requiresPublicWebhook?: boolean;
};

export type AutomationGoldenPathResult = {
  success: boolean;
  status: AutomationGoldenPathStatus;
  automationId: string;
  workflowId?: string;
  workflowName?: string;
  operation?: 'create' | 'update';
  message: string;
  steps: AutomationGoldenPathStep[];
  validation?: ValidationResult;
  risk?: ReturnType<typeof analyzeWorkflow> & { verdict: 'approve' | 'review' | 'block' };
  lastTest?: {
    mode: 'mock';
    status: 'passed' | 'failed';
    findings: TestFinding[];
    testPlan: string[];
  };
  missingConfig?: unknown[];
  missingCredentials?: unknown[];
  repairAttempts: number;
  error?: string;
};

type RuntimeRequirements = {
  requiresPublicWebhook: boolean;
  requiresMastraApi: boolean;
  requiresOllama: boolean;
  requiresMongo: boolean;
  requiresTelegram: boolean;
};

const SAFE_FILE_ROOTS = [
  process.env.ARCHITECT_WORKFLOW_ROOT ?? '/projekty/Jarvis-Projects/n8n_workflows',
  process.cwd(),
];

export async function executeAutomationGoldenPath(
  input: AutomationGoldenPathInput,
): Promise<AutomationGoldenPathResult> {
  const automationId = input.automationId || randomUUID();
  const steps: AutomationGoldenPathStep[] = [];
  let workflowId = input.workflowId;
  let workflowName: string | undefined;
  let deployedWorkflow: any;
  let operation: 'create' | 'update' | undefined;
  let repairAttempts = 0;

  const pushStep = (
    name: string,
    status: AutomationGoldenPathStepStatus,
    message: string,
    data?: Record<string, unknown>,
  ) => {
    steps.push({ name, status, message, data });
  };

  try {
    const workflow = await resolveWorkflowInput(input);
    workflowName = input.workflowName || workflow.name;
    pushStep('resolve_workflow', 'success', `Workflow resolved: ${workflowName ?? '(unnamed)'}`);

    const runtime = await checkRuntime(inferRuntimeRequirements(workflow, input));
    pushStep('runtime_check', runtime.ok ? 'success' : 'blocked', runtime.message, { checks: runtime.checks });
    if (!runtime.ok) {
      return buildResult({
        success: false,
        status: 'blocked',
        automationId,
        workflowId,
        workflowName,
        message: runtime.message,
        steps,
        repairAttempts,
        missingConfig: runtime.missingConfig,
      });
    }

    const normalizationWarnings = normalizeWorkflowForDeploy(workflow);
    if (normalizationWarnings.length > 0) {
      pushStep('normalize_workflow', 'warning', 'Workflow normalized before validation.', {
        warnings: normalizationWarnings,
      });
    } else {
      pushStep('normalize_workflow', 'success', 'Workflow normalization complete.');
    }

    const draftValidation = validateWorkflow(workflow, 'draft');
    if (normalizationWarnings.length > 0) {
      draftValidation.warnings = [
        ...draftValidation.warnings,
        ...normalizationWarnings.map((message) => ({ message, severity: 'warning' as const })),
      ];
    }
    const hasRequiredMissingCredentials = draftValidation.missingCredentials.some((credential) => credential.required);
    const blocksDeploy =
      draftValidation.errors.length > 0 ||
      draftValidation.securityIssues.length > 0 ||
      (input.allowDraftWithMissingCredentials === false && hasRequiredMissingCredentials);

    pushStep('validate_draft', blocksDeploy ? 'blocked' : 'success',
      blocksDeploy ? 'Draft validation blocked deploy.' : 'Draft validation passed.', {
        errors: draftValidation.errors.length,
        securityIssues: draftValidation.securityIssues.length,
        missingCredentials: draftValidation.missingCredentials.length,
        missingConfig: draftValidation.missingConfig.length,
      });

    if (blocksDeploy) {
      return buildResult({
        success: false,
        status: 'blocked',
        automationId,
        workflowId,
        workflowName,
        message: 'Workflow validation blocked deploy.',
        steps,
        validation: draftValidation,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      });
    }

    const risk = withVerdict(analyzeWorkflow(workflow));
    pushStep('risk_score', risk.verdict === 'block' ? 'blocked' : risk.verdict === 'review' ? 'warning' : 'success',
      `Risk score=${risk.score}, verdict=${risk.verdict}.`, { findings: risk.findings });

    if (risk.verdict === 'block') {
      return buildResult({
        success: false,
        status: 'blocked',
        automationId,
        workflowId,
        workflowName,
        message: `Deploy blocked by risk score ${risk.score}.`,
        steps,
        validation: draftValidation,
        risk,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      });
    }

    if (risk.verdict === 'review' && !input.approvalToken) {
      return buildResult({
        success: false,
        status: 'blocked',
        automationId,
        workflowId,
        workflowName,
        message: `Deploy requires approvalToken (risk score=${risk.score}).`,
        steps,
        validation: draftValidation,
        risk,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      });
    }

    const deployed = await deployWorkflow({
      automationId,
      workflow,
      workflowId,
      approvalToken: input.approvalToken,
      validation: draftValidation,
      risk,
    });
    workflowId = deployed.workflowId;
    workflowName = deployed.workflowName;
    deployedWorkflow = deployed.workflow;
    operation = deployed.operation;
    pushStep('deploy_inactive', 'success', deployed.message, { workflowId, operation: deployed.operation });

    await syncAutomationStatus({ automationId, workflowId });

    let test = await runMockTest(automationId, workflowId, deployedWorkflow);
    pushStep(
      'mock_test',
      test.status === 'passed' ? 'success' : 'failed',
      test.status === 'passed' ? 'Mock test passed.' : 'Mock test failed.',
      { findings: test.findings },
    );

    while (test.status !== 'passed' && repairAttempts < 3) {
      repairAttempts += 1;
      const repair = await repairAndRedeploy({
        automationId,
        workflowId,
        workflow: deployedWorkflow,
        findings: test.findings,
        attempt: repairAttempts,
        approvalToken: input.approvalToken,
      });

      pushStep(
        'repair_workflow',
        repair.success ? 'success' : repair.changed ? 'warning' : 'failed',
        repair.message,
        { attempt: repairAttempts, changes: repair.changes },
      );

      if (!repair.changed || !repair.workflow) {
        break;
      }

      deployedWorkflow = repair.workflow;
      test = await runMockTest(automationId, workflowId, deployedWorkflow);
      pushStep(
        'mock_test_retry',
        test.status === 'passed' ? 'success' : 'failed',
        test.status === 'passed' ? 'Mock test passed after repair.' : 'Mock test still failed after repair.',
        { attempt: repairAttempts, findings: test.findings },
      );
    }

    if (test.status !== 'passed') {
      await markAutomationStatus(automationId, 'manual_review_required', workflowId);
      return buildResult({
        success: false,
        status: 'manual_review_required',
        automationId,
        workflowId,
        workflowName,
        operation,
        message: 'Workflow deployed but mock test did not pass after repair attempts.',
        steps,
        validation: draftValidation,
        risk,
        lastTest: test,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      });
    }

    if (input.activate) {
      const activation = await activateIfAllowed({
        automationId,
        workflowId,
        approvalToken: input.approvalToken,
      });
      pushStep('activate', activation.success ? 'success' : 'blocked', activation.message, activation.data);
      await syncAutomationStatus({ automationId, workflowId });

      return buildResult({
        success: activation.success,
        status: activation.success ? 'active' : 'tested',
        automationId,
        workflowId,
        workflowName,
        operation,
        message: activation.success
          ? 'Workflow deployed, tested, and activated.'
          : 'Workflow deployed and tested, but activation was blocked.',
        steps,
        validation: draftValidation,
        risk,
        lastTest: test,
        repairAttempts,
        missingConfig: draftValidation.missingConfig,
        missingCredentials: draftValidation.missingCredentials,
      });
    }

    await markAutomationStatus(automationId, 'tested', workflowId);
    await syncAutomationStatus({ automationId, workflowId });

    return buildResult({
      success: true,
      status: 'tested',
      automationId,
      workflowId,
      workflowName,
      operation,
      message: 'Workflow deployed as inactive draft and passed mock test.',
      steps,
      validation: draftValidation,
      risk,
      lastTest: test,
      repairAttempts,
      missingConfig: draftValidation.missingConfig,
      missingCredentials: draftValidation.missingCredentials,
    });
  } catch (error) {
    pushStep('golden_path_failed', 'failed', (error as Error).message);
    return buildResult({
      success: false,
      status: 'blocked',
      automationId,
      workflowId,
      workflowName,
      message: 'Automation Golden Path failed before completion.',
      steps,
      repairAttempts,
      error: (error as Error).message,
    });
  }
}

export async function syncAutomationStatus(input: {
  automationId?: string;
  workflowId?: string;
}): Promise<{ synced: boolean; status?: AutomationGoldenPathStatus; n8nActive?: boolean; message: string }> {
  const db = await getDb();
  const query = input.automationId
    ? { automationId: input.automationId }
    : input.workflowId
      ? { n8nWorkflowId: input.workflowId }
      : null;

  if (!query) return { synced: false, message: 'automationId or workflowId is required.' };

  const existing = await db.collection('automation_requests').findOne(query);
  if (!existing?.n8nWorkflowId && !input.workflowId) {
    return { synced: false, message: 'Automation has no n8n workflow id.' };
  }

  const workflowId = input.workflowId || existing.n8nWorkflowId;
  const n8n = new N8nService();
  const workflow = await n8n.getWorkflow(workflowId);
  const n8nActive = workflow.active === true;
  const lastTestPassed = existing?.lastTest?.status === 'passed';
  const currentStatus = existing?.status as AutomationGoldenPathStatus | undefined;
  const status: AutomationGoldenPathStatus = n8nActive
    ? 'active'
    : currentStatus === 'manual_review_required'
      ? 'manual_review_required'
      : lastTestPassed || currentStatus === 'tested'
        ? 'tested'
        : 'draft_created';

  await db.collection('automation_requests').updateOne(
    { n8nWorkflowId: workflowId },
    {
      $set: {
        status,
        n8nActive,
        lastN8nSyncAt: new Date(),
        lastKnownWorkflow: workflow,
        updatedAt: new Date(),
        ...(n8nActive && currentStatus !== 'active' ? { activationDetectedAt: new Date() } : {}),
      },
    },
    { upsert: false },
  );

  return { synced: true, status, n8nActive, message: `Synced workflow ${workflowId}: status=${status}.` };
}

async function resolveWorkflowInput(input: AutomationGoldenPathInput): Promise<any> {
  if (input.mode === 'pattern') {
    if (!input.patternId) throw new Error('patternId is required for mode=pattern.');
    if (!input.spec) throw new Error('spec is required for mode=pattern.');
    const pattern = getPatternById(input.patternId);
    if (!pattern) throw new Error(`Pattern not found: ${input.patternId}.`);
    if (pattern.executable === false) {
      throw new Error(`Pattern ${input.patternId} is abstract and cannot be deployed.`);
    }
    const built = pattern.build(input.spec);
    return {
      name: input.workflowName ?? input.spec.name,
      nodes: built?.nodes ?? [],
      connections: built?.connections ?? {},
      settings: built?.settings ?? { executionOrder: 'v1' },
      active: false,
    };
  }

  if (input.mode === 'workflow_file') {
    if (!input.workflowFilePath) throw new Error('workflowFilePath is required for mode=workflow_file.');
    const filePath = resolveWorkflowFilePath(input.workflowFilePath);
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  if (!input.workflow || typeof input.workflow !== 'object' || Array.isArray(input.workflow)) {
    throw new Error('workflow object is required for mode=workflow_json.');
  }

  return JSON.parse(JSON.stringify(input.workflow));
}

function resolveWorkflowFilePath(filePath: string): string {
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(process.cwd(), filePath);
  const allowed = SAFE_FILE_ROOTS.some((root) => {
    const rel = relative(resolve(root), resolved);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });

  if (!allowed) {
    throw new Error(`Workflow file path is outside allowed roots: ${SAFE_FILE_ROOTS.join(', ')}`);
  }

  return resolved;
}

function normalizeWorkflowForDeploy(workflow: any): string[] {
  const warnings: string[] = [];
  warnings.push(...normalizeConnectionKeys(workflow));

  if (!workflow.settings || typeof workflow.settings !== 'object') {
    workflow.settings = { executionOrder: 'v1' };
    warnings.push('Added settings.executionOrder=v1.');
  } else if (workflow.settings.executionOrder !== 'v1') {
    workflow.settings.executionOrder = 'v1';
    warnings.push('Forced settings.executionOrder=v1.');
  }

  if (workflow.active !== false) {
    workflow.active = false;
    warnings.push('Forced active=false.');
  }

  const nodes: any[] = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  for (const node of nodes) {
    const credentialType = credentialTypeForNode(node.type);
    if (!credentialType) continue;

    const registry = getCredentialFromRegistry(credentialType.service);
    if (!registry) continue;

    const current = node.credentials?.[credentialType.n8nCredentialType];
    if (!node.credentials) node.credentials = {};

    if (!current || typeof current === 'string') {
      node.credentials[credentialType.n8nCredentialType] = { id: registry.id, name: registry.name };
      warnings.push(`Credential normalized for ${node.name || node.type}: ${credentialType.n8nCredentialType}.`);
    }
  }

  return warnings;
}

function credentialTypeForNode(nodeType: string | undefined): { service: string; n8nCredentialType: string } | null {
  switch (nodeType) {
    case 'n8n-nodes-base.telegram':
    case 'n8n-nodes-base.telegramTrigger':
      return { service: 'telegram', n8nCredentialType: 'telegramApi' };
    case 'n8n-nodes-base.mongoDb':
      return { service: 'mongo', n8nCredentialType: 'mongoDb' };
    case 'n8n-nodes-base.gmail':
    case 'n8n-nodes-base.gmailTrigger':
      return { service: 'gmail', n8nCredentialType: 'googleGmailOAuth2Api' };
    default:
      return null;
  }
}

function inferRuntimeRequirements(workflow: any, input: AutomationGoldenPathInput): RuntimeRequirements {
  const nodes: any[] = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const serialized = JSON.stringify(workflow ?? {}).toLowerCase();
  return {
    requiresPublicWebhook:
      input.requiresPublicWebhook === true ||
      (input.activate === true && nodes.some((node) => node.type === 'n8n-nodes-base.webhook')),
    requiresMastraApi: serialized.includes('localhost:4111') || serialized.includes('mastra'),
    requiresOllama: serialized.includes('ollama') || serialized.includes('11434'),
    requiresMongo: nodes.some((node) => node.type === 'n8n-nodes-base.mongoDb') || serialized.includes('mongodb'),
    requiresTelegram: nodes.some((node) => String(node.type ?? '').includes('telegram')),
  };
}

async function checkRuntime(requirements: RuntimeRequirements): Promise<{
  ok: boolean;
  message: string;
  checks: Array<{ key: string; ok: boolean; message: string }>;
  missingConfig: Array<{ key: string; required: boolean; description: string }>;
}> {
  const topology = getRuntimeTopology();
  const checks: Array<{ key: string; ok: boolean; message: string }> = [];
  const missingConfig: Array<{ key: string; required: boolean; description: string }> = [];
  let ok = true;

  const n8n = new N8nService();
  const n8nOk = await n8n.getHealth();
  checks.push({ key: 'n8n', ok: n8nOk, message: n8nOk ? 'n8n reachable.' : 'n8n is not reachable.' });
  if (!n8nOk) ok = false;

  if (!process.env.N8N_API_KEY) {
    missingConfig.push({ key: 'N8N_API_KEY', required: true, description: 'Required for n8n API calls.' });
    ok = false;
  }

  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    checks.push({ key: 'mongo', ok: true, message: 'MongoDB reachable.' });
  } catch {
    checks.push({ key: 'mongo', ok: false, message: 'MongoDB is not reachable.' });
    ok = false;
  }

  if (requirements.requiresPublicWebhook) {
    const publicUrl = topology.n8nPublicWebhookBaseUrl;
    const publicOk = Boolean(publicUrl && !publicUrl.includes('localhost') && !publicUrl.includes('127.0.0.1'));
    checks.push({
      key: 'public_webhook',
      ok: publicOk,
      message: publicOk ? 'Public webhook base URL configured.' : 'Public webhook URL missing or local.',
    });
    if (!publicOk) {
      ok = false;
      missingConfig.push({
        key: 'N8N_PUBLIC_WEBHOOK_BASE_URL',
        required: true,
        description: 'Required before activating public webhooks.',
      });
    }
  }

  if (requirements.requiresOllama) {
    const ollamaOk = await fetch(`${topology.ollamaBaseUrlForN8n}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    }).then((res) => res.ok).catch(() => false);
    checks.push({ key: 'ollama', ok: ollamaOk, message: ollamaOk ? 'Ollama reachable.' : 'Ollama is not reachable.' });
    if (!ollamaOk) ok = false;
  }

  if (requirements.requiresMastraApi) {
    const mastraOk = await fetch(`${topology.mastraApiUrlForN8n.replace(/\/$/, '')}/api`, {
      signal: AbortSignal.timeout(3000),
    }).then((res) => res.status < 500).catch(() => false);
    checks.push({
      key: 'mastra_api',
      ok: mastraOk,
      message: mastraOk ? 'Mastra API reachable.' : 'Mastra API is not reachable.',
    });
    if (!mastraOk) ok = false;
  }

  if (requirements.requiresTelegram && !process.env.N8N_TELEGRAM_CHAT_ID && !process.env.TELEGRAM_CHAT_ID) {
    missingConfig.push({
      key: 'N8N_TELEGRAM_CHAT_ID',
      required: true,
      description: 'Required for Telegram send nodes.',
    });
    ok = false;
  }

  return {
    ok,
    checks,
    missingConfig,
    message: ok ? 'Runtime checks passed.' : 'Runtime checks blocked automation deployment.',
  };
}

function withVerdict(result: ReturnType<typeof analyzeWorkflow>): ReturnType<typeof analyzeWorkflow> & {
  verdict: 'approve' | 'review' | 'block';
} {
  return {
    ...result,
    verdict: result.score >= 80 ? 'block' : result.score >= 20 ? 'review' : 'approve',
  };
}

async function deployWorkflow(input: {
  automationId: string;
  workflow: any;
  workflowId?: string;
  approvalToken?: string;
  validation: ValidationResult;
  risk: ReturnType<typeof analyzeWorkflow> & { verdict: 'approve' | 'review' | 'block' };
}): Promise<{
  workflowId: string;
  workflowName: string;
  operation: 'create' | 'update';
  workflow: any;
  message: string;
}> {
  const db = await getDb();
  const n8n = new N8nService();
  let workflowId = input.workflowId;
  let operation: 'create' | 'update' = workflowId ? 'update' : 'create';

  if (!workflowId) {
    const expectedName = ensureMastraName(input.workflow.name);
    const existing = await n8n.listWorkflows();
    const match = existing.find((workflow) => workflow.name === expectedName || workflow.name === input.workflow.name);
    if (match) {
      const owner = await db.collection('automation_requests').findOne({ n8nWorkflowId: match.id });
      if (!owner || owner.managedBy !== 'mastra') {
        throw new Error(`Workflow name already exists but is not Mastra-managed: ${match.name} (${match.id}).`);
      }
      workflowId = match.id;
      operation = 'update';
    }
  }

  if (workflowId) {
    const existingOwner = await db.collection('automation_requests').findOne({ n8nWorkflowId: workflowId });
    if (existingOwner && existingOwner.managedBy !== 'mastra') {
      throw new Error(`Workflow ${workflowId} is not managed by Mastra.`);
    }
  }

  if (input.risk.verdict === 'review' && input.approvalToken) {
    const approval = await db.collection('approvals').findOne({ id: input.approvalToken });
    if (!approval || approval.status !== 'approved') {
      throw new Error(`Invalid or unapproved approvalToken: ${input.approvalToken}`);
    }
  }

  const payload = {
    ...input.workflow,
    name: ensureMastraName(input.workflow.name),
    active: false,
    settings: input.workflow.settings || { executionOrder: 'v1' },
  };

  let saved: any;
  if (workflowId) {
    saved = await n8n.updateWorkflow(workflowId, payload);
  } else {
    saved = await n8n.createWorkflow(payload);
    workflowId = saved.id;
  }

  if (!workflowId) throw new Error('n8n did not return a workflow id.');

  await db.collection('automation_requests').updateOne(
    { automationId: input.automationId },
    {
      $set: {
        automationId: input.automationId,
        n8nWorkflowId: workflowId,
        name: payload.name,
        status: 'draft_created',
        riskScore: input.risk.score,
        riskVerdict: input.risk.verdict,
        validation: input.validation,
        managedBy: 'mastra',
        lastSnapshot: payload,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  await db.collection('automation_workflow_snapshots').insertOne({
    automationId: input.automationId,
    n8nWorkflowId: workflowId,
    version: new Date().toISOString(),
    workflow: payload,
    createdAt: new Date(),
  }).catch(() => undefined);

  const workflow = await n8n.getWorkflow(workflowId);
  return {
    workflowId,
    workflowName: payload.name,
    operation,
    workflow,
    message: `Workflow ${operation === 'create' ? 'created' : 'updated'} as inactive draft (${workflowId}).`,
  };
}

async function runMockTest(
  automationId: string,
  workflowId: string,
  workflow: any,
): Promise<AutomationGoldenPathResult['lastTest']> {
  const validation = validateWorkflow(workflow, 'strict');
  const findings = validationToFindings(validation);
  const mock = generateMockPayload(workflow);
  const status = validation.valid ? 'passed' : 'failed';
  const db = await getDb();

  await db.collection('automation_events').insertOne({
    automationId,
    type: 'test_run',
    data: { mode: 'mock', status, findings },
    createdAt: new Date(),
  });
  await db.collection('automation_requests').updateOne(
    { automationId },
    {
      $set: {
        lastTest: { mode: 'mock', status, findings, workflowId, at: new Date() },
        updatedAt: new Date(),
      },
    },
  );

  return {
    mode: 'mock',
    status,
    findings,
    testPlan: [`Trigger detected: ${mock.triggerType}`, ...mock.instructions],
  };
}

function validationToFindings(validation: ValidationResult): TestFinding[] {
  const out: TestFinding[] = [];
  const add = (severity: 'error' | 'warning' | 'info', item: ValidationFinding, prefix = '') => {
    out.push({
      severity,
      nodeName: item.nodeName,
      message: `${prefix}${item.message}`,
    });
  };
  validation.errors.forEach((item) => add('error', item));
  validation.securityIssues.forEach((item) => add('error', item, '[security] '));
  validation.warnings.forEach((item) => add('warning', item));
  validation.missingCredentials.forEach((item) => {
    out.push({ severity: 'error', message: `Missing credential: ${item.service}`, suggestedFix: item.setupHint });
  });
  validation.missingConfig.forEach((item) => {
    out.push({ severity: 'error', message: `Missing config: ${item.key}`, suggestedFix: item.description });
  });
  return out;
}

async function repairAndRedeploy(input: {
  automationId: string;
  workflowId: string;
  workflow: any;
  findings: TestFinding[];
  attempt: number;
  approvalToken?: string;
}): Promise<{ success: boolean; changed: boolean; changes: unknown[]; workflow?: any; message: string }> {
  const db = await getDb();
  const repaired = applyRepairs(input.workflow, input.findings);

  await db.collection('automation_events').insertOne({
    automationId: input.automationId,
    type: 'repair_attempt',
    data: { attempt: input.attempt, changes: repaired.changes },
    createdAt: new Date(),
  });

  if (!repaired.patchedWorkflow || repaired.changes.length === 0) {
    return {
      success: false,
      changed: false,
      changes: [],
      message: 'No deterministic repair was possible.',
    };
  }

  normalizeWorkflowForDeploy(repaired.patchedWorkflow);
  const validation = validateWorkflow(repaired.patchedWorkflow, 'draft');
  if (validation.errors.length > 0 || validation.securityIssues.length > 0) {
    return {
      success: false,
      changed: true,
      changes: repaired.changes,
      workflow: repaired.patchedWorkflow,
      message: 'Repair produced workflow that still fails draft validation.',
    };
  }

  const risk = withVerdict(analyzeWorkflow(repaired.patchedWorkflow));
  if (risk.verdict === 'block' || (risk.verdict === 'review' && !input.approvalToken)) {
    return {
      success: false,
      changed: true,
      changes: repaired.changes,
      workflow: repaired.patchedWorkflow,
      message: `Repair blocked by risk verdict=${risk.verdict}.`,
    };
  }

  const deployed = await deployWorkflow({
    automationId: input.automationId,
    workflowId: input.workflowId,
    workflow: repaired.patchedWorkflow,
    approvalToken: input.approvalToken,
    validation,
    risk,
  });

  return {
    success: true,
    changed: true,
    changes: repaired.changes,
    workflow: deployed.workflow,
    message: `Repair attempt ${input.attempt} deployed.`,
  };
}

async function activateIfAllowed(input: {
  automationId: string;
  workflowId: string;
  approvalToken?: string;
}): Promise<{ success: boolean; message: string; data?: Record<string, unknown> }> {
  const db = await getDb();
  const automation = await db.collection('automation_requests').findOne({ automationId: input.automationId });
  if (!automation || automation.managedBy !== 'mastra') {
    return { success: false, message: 'Activation blocked: automation is not Mastra-managed.' };
  }

  const n8n = new N8nService();
  const workflow = await n8n.getWorkflow(input.workflowId);
  const validation = validateWorkflow(workflow, 'activation');
  const risk = withVerdict(analyzeWorkflow(workflow));
  const reasons = activationReasons(workflow, risk.score);

  if (!validation.valid || validation.securityIssues.length > 0) {
    return {
      success: false,
      message: 'Activation blocked: validation failed.',
      data: { validation },
    };
  }

  if (risk.verdict === 'block') {
    return {
      success: false,
      message: `Activation blocked: risk score=${risk.score}.`,
      data: { risk },
    };
  }

  if ((risk.verdict === 'review' || reasons.length > 0) && !input.approvalToken) {
    return {
      success: false,
      message: `Activation requires approval: ${reasons.join('; ') || `risk score ${risk.score}`}`,
      data: { risk, reasons },
    };
  }

  if (input.approvalToken) {
    const approval = await db.collection('approvals').findOne({ id: input.approvalToken });
    if (!approval || approval.status !== 'approved') {
      return { success: false, message: `Invalid or unapproved approvalToken: ${input.approvalToken}` };
    }
  }

  await n8n.activateWorkflow(input.workflowId);
  await db.collection('automation_requests').updateOne(
    { automationId: input.automationId },
    {
      $set: {
        status: 'active',
        activatedAt: new Date(),
        updatedAt: new Date(),
        activationRisk: risk,
        activationValidation: validation,
      },
    },
  );

  return { success: true, message: `Workflow activated (${input.workflowId}).`, data: { risk } };
}

function activationReasons(workflow: any, score: number): string[] {
  const reasons: string[] = [];
  const nodes: any[] = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  if (score >= 20) reasons.push(`risk score ${score} requires review`);

  for (const node of nodes) {
    const type = String(node.type || '');
    const params = node.parameters || {};
    if (['n8n-nodes-base.emailSend', 'n8n-nodes-base.gmail', 'n8n-nodes-base.slack', 'n8n-nodes-base.mongoDb'].includes(type)) {
      reasons.push(`node ${node.name || type} can write/send external data`);
    }
    if (type === 'n8n-nodes-base.httpRequest') {
      const method = String(params.method || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        reasons.push(`HTTP node ${node.name || type} uses method ${method}`);
      }
    }
    if (type === 'n8n-nodes-base.webhook' && (params.authentication || 'none') === 'none') {
      reasons.push(`webhook ${node.name || type} has no authentication`);
    }
  }

  return [...new Set(reasons)];
}

async function markAutomationStatus(
  automationId: string,
  status: AutomationGoldenPathStatus,
  workflowId?: string,
): Promise<void> {
  const db = await getDb();
  await db.collection('automation_requests').updateOne(
    { automationId },
    {
      $set: {
        status,
        ...(workflowId ? { n8nWorkflowId: workflowId } : {}),
        updatedAt: new Date(),
      },
    },
  );
}

function ensureMastraName(name: string): string {
  return name?.startsWith('Mastra - ') ? name : `Mastra - ${name || 'Untitled Automation'}`;
}

function buildResult(input: Omit<AutomationGoldenPathResult, 'operation'> & {
  operation?: 'create' | 'update';
}): AutomationGoldenPathResult {
  return {
    success: input.success,
    status: input.status,
    automationId: input.automationId,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    operation: input.operation,
    message: input.message,
    steps: input.steps,
    validation: input.validation,
    risk: input.risk,
    lastTest: input.lastTest,
    missingConfig: input.missingConfig,
    missingCredentials: input.missingCredentials,
    repairAttempts: input.repairAttempts,
    error: input.error,
  };
}

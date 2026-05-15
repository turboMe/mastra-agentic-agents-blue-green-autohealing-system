#!/usr/bin/env tsx
import 'dotenv/config';
import { randomUUID } from 'crypto';

import { executeAutomationGoldenPath } from '../services/automation-golden-path.js';
import { N8nService } from '../tools/n8n/client.js';
import { getDb } from '../lib/mongo.js';
import { normalizeConnectionKeys, validateWorkflow } from '../tools/architect/validation/workflow-validator.js';
import { applyRepairs } from '../tools/architect/testing/repair-workflow.js';
import { analyzeWorkflow } from '../tools/architect/risk-scoring.js';

const unsafeWorkflow = {
  name: 'Unsafe Function Workflow',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'manual',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'unsafe',
      name: 'Unsafe Function',
      type: 'n8n-nodes-base.function',
      typeVersion: 1,
      position: [220, 0],
      parameters: {
        functionCode: "return [{ json: { out: $helpers.executeCommandSync('cat /etc/passwd').toString() } }];",
      },
    },
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Unsafe Function', type: 'main', index: 0 }]],
    },
  },
};

async function main() {
  const connectionNormalization = checkConnectionIdNormalization();
  const graphValidation = checkGraphValidation();
  const connectionRepair = checkConnectionRepair();
  const unsupportedVars = checkUnsupportedVarsHandling();
  const malformedParameters = checkMalformedParameters();
  const triggerConsistency = checkTriggerConsistency();
  const activationTriggerValidation = checkActivationTriggerValidation();

  const unsafeResult = await executeAutomationGoldenPath({
    mode: 'workflow_json',
    workflow: unsafeWorkflow,
    automationId: `check-unsafe-${Date.now()}`,
  });

  const securityCount = unsafeResult.validation?.securityIssues.length ?? 0;
  if (unsafeResult.status !== 'blocked' || securityCount === 0) {
    console.error(JSON.stringify(unsafeResult, null, 2));
    throw new Error('Unsafe workflow was not blocked by Golden Path validation.');
  }

  const automationId = `check-safe-${Date.now()}`;
  const safeWorkflow = {
    name: `Golden Path Check ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
  };
  const safeResult = await executeAutomationGoldenPath({
    mode: 'workflow_json',
    automationId,
    workflow: safeWorkflow,
  });

  try {
    if (!safeResult.success || safeResult.status !== 'tested' || !safeResult.workflowId) {
      console.error(JSON.stringify(safeResult, null, 2));
      throw new Error('Safe workflow did not complete deploy + mock test.');
    }

    const deployedWorkflow = await new N8nService().getWorkflow(safeResult.workflowId);
    if (deployedWorkflow.active) {
      console.error(JSON.stringify({ workflowId: safeResult.workflowId, active: deployedWorkflow.active }, null, 2));
      throw new Error('Safe workflow was not left inactive after deploy + mock test.');
    }

    const ownerReuseResult = await executeAutomationGoldenPath({
      mode: 'workflow_json',
      workflowId: safeResult.workflowId,
      workflow: safeWorkflow,
    });
    if (!ownerReuseResult.success || ownerReuseResult.automationId !== automationId) {
      console.error(JSON.stringify({ safeResult, ownerReuseResult }, null, 2));
      throw new Error('Golden Path update did not reuse existing workflow ownership.');
    }
    const duplicateOwners = await (await getDb()).collection('automation_requests').countDocuments({
      n8nWorkflowId: safeResult.workflowId,
    });
    if (duplicateOwners !== 1) {
      console.error(JSON.stringify({ safeResult, ownerReuseResult, duplicateOwners }, null, 2));
      throw new Error('Golden Path update created duplicate automation ownership records.');
    }
  } finally {
    await cleanup(automationId, safeResult.workflowId);
  }

  console.log('automation-golden-path check passed');
  console.log(`connectionIdNormalization=${connectionNormalization}`);
  console.log(`graphValidation=${graphValidation}`);
  console.log(`connectionRepair=${connectionRepair}`);
  console.log(`unsupportedVars=${unsupportedVars}`);
  console.log(`malformedParameters=${malformedParameters}`);
  console.log(`triggerConsistency=${triggerConsistency}`);
  console.log(`activationTriggerValidation=${activationTriggerValidation}`);
  console.log('inactiveAfterDeploy=passed');
  console.log('ownerReuse=passed');
  console.log(`unsafeStatus=${unsafeResult.status}, securityIssues=${securityCount}`);
  console.log(`safeStatus=${safeResult.status}, workflowId=${safeResult.workflowId}`);
  process.exit(0);
}

function checkConnectionIdNormalization(): string {
  const workflow: any = {
    name: `Connection ID Normalization ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual_trigger_01',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'noop_01',
        name: 'No Operation',
        type: 'n8n-nodes-base.noOp',
        typeVersion: 1,
        position: [220, 0],
        parameters: {},
      },
    ],
    connections: {
      manual_trigger_01: {
        main: [[{ node: 'noop_01', type: 'main', index: 0 }]],
      },
    },
  };

  const warnings = normalizeConnectionKeys(workflow);
  const validation = validateWorkflow(workflow, 'strict');

  if (!validation.valid) {
    console.error(JSON.stringify({ warnings, validation, workflow }, null, 2));
    throw new Error('Connection id normalization did not produce a valid workflow.');
  }
  if (!workflow.connections['Manual Trigger'] || workflow.connections.manual_trigger_01) {
    console.error(JSON.stringify({ warnings, workflow }, null, 2));
    throw new Error('Connection source id was not normalized to node name.');
  }
  const target = workflow.connections['Manual Trigger'].main?.[0]?.[0]?.node;
  if (target !== 'No Operation') {
    console.error(JSON.stringify({ warnings, workflow }, null, 2));
    throw new Error('Connection target id was not normalized to node name.');
  }
  if (warnings.length < 2) {
    console.error(JSON.stringify({ warnings, workflow }, null, 2));
    throw new Error('Connection normalization did not report source and target warnings.');
  }

  return 'passed';
}

function checkGraphValidation(): string {
  const disconnectedWorkflow: any = {
    name: `Disconnected Graph ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'transform_a',
        name: 'Transform A',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {},
      },
      {
        id: 'transform_b',
        name: 'Transform B',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [440, 0],
        parameters: {},
      },
      {
        id: 'respond',
        name: 'Respond',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [660, 0],
        parameters: {},
      },
    ],
    connections: {},
  };

  const disconnectedDraft = validateWorkflow(disconnectedWorkflow, 'draft');
  const disconnectedStrict = validateWorkflow(disconnectedWorkflow, 'strict');
  if (disconnectedDraft.valid || disconnectedStrict.valid || disconnectedStrict.orphanNodeCount !== 3) {
    console.error(JSON.stringify({ disconnectedDraft, disconnectedStrict }, null, 2));
    throw new Error('Disconnected executable graph was not blocked by validation.');
  }

  const linearWorkflow: any = {
    ...disconnectedWorkflow,
    name: `Linear Graph ${randomUUID().slice(0, 8)}`,
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Transform A', type: 'main', index: 0 }]],
      },
      'Transform A': {
        main: [[{ node: 'Transform B', type: 'main', index: 0 }]],
      },
      'Transform B': {
        main: [[{ node: 'Respond', type: 'main', index: 0 }]],
      },
    },
  };

  const linearStrict = validateWorkflow(linearWorkflow, 'strict');
  if (!linearStrict.valid || linearStrict.orphanNodeCount !== 0 || linearStrict.reachableNodeCount !== 4) {
    console.error(JSON.stringify({ linearStrict }, null, 2));
    throw new Error('Linear trigger-to-executable graph did not pass validation.');
  }

  return 'passed';
}

function checkConnectionRepair(): string {
  const repairableWorkflow: any = {
    name: `Connection Repair ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual_trigger_01',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'transform_payload_01',
        name: 'Transform Payload',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {},
      },
    ],
    connections: {
      manual_trigger_01: {
        main: [[{ node: 'transform_payload_01', type: 'main', index: 0 }]],
      },
    },
  };

  const beforeRepairValidation = validateWorkflow(repairableWorkflow, 'strict');
  const repair = applyRepairs(
    repairableWorkflow,
    beforeRepairValidation.errors.map((error) => ({
      severity: 'error',
      nodeName: error.nodeName,
      message: error.message,
    })),
  );
  const repairedValidation = validateWorkflow(repair.patchedWorkflow, 'strict');
  if (!repair.success || !repairedValidation.valid || !repair.changes.some((change) => change.reason.includes('connection_id_to_name_repair'))) {
    console.error(JSON.stringify({ repair, repairedValidation }, null, 2));
    throw new Error('Connection id/name repair did not produce a valid workflow.');
  }

  const manualWorkflow: any = {
    ...repairableWorkflow,
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Missing Target', type: 'main', index: 0 }]],
      },
    },
  };
  const manualValidation = validateWorkflow(manualWorkflow, 'strict');
  const manualRepair = applyRepairs(
    manualWorkflow,
    manualValidation.errors.map((error) => ({ severity: 'error', nodeName: error.nodeName, message: error.message })),
  );
  if (manualRepair.stopReason !== 'manual_connection_mapping_required' || manualRepair.remainingIssues.length === 0) {
    console.error(JSON.stringify({ manualValidation, manualRepair }, null, 2));
    throw new Error('Unknown connection target did not produce manual_connection_mapping_required.');
  }

  return 'passed';
}

function checkUnsupportedVarsHandling(): string {
  const workflow: any = {
    name: `Unsupported Vars ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'set_value',
        name: 'Set Value',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {
          assignments: {
            assignments: [
              {
                id: 'base-url',
                name: 'baseUrl',
                value: '={{ $vars.MASTRA_API_URL }}',
                type: 'string',
              },
            ],
          },
        },
      },
    ],
    connections: {
      'Manual Trigger': {
        main: [[{ node: 'Set Value', type: 'main', index: 0 }]],
      },
    },
  };

  const validation = validateWorkflow(workflow, 'strict');
  const repair = applyRepairs(
    workflow,
    validation.errors.map((error) => ({ severity: 'error', nodeName: error.nodeName, message: error.message })),
  );
  if (validation.valid || repair.stopReason !== 'unsupported_n8n_vars' || !repair.remainingIssues.some((issue) => issue.message.includes('unsupported_n8n_vars'))) {
    console.error(JSON.stringify({ validation, repair }, null, 2));
    throw new Error('$vars.* did not produce unsupported_n8n_vars.');
  }

  return 'passed';
}

function checkMalformedParameters(): string {
  const workflow: any = {
    name: `Malformed Parameters ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
      },
    ],
    connections: {},
  };

  const validation = validateWorkflow(workflow, 'draft');
  if (validation.valid || !validation.errors.some((error) => error.message.includes('"parameters" as an object'))) {
    console.error(JSON.stringify({ validation }, null, 2));
    throw new Error('Malformed node parameters were not blocked before deploy.');
  }

  return 'passed';
}

function checkTriggerConsistency(): string {
  const workflow: any = {
    name: `RSS Trigger Risk ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'rss-trigger',
        name: 'RSS Trigger',
        type: 'n8n-nodes-base.rssFeedReadTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
  };

  const validation = validateWorkflow(workflow, 'strict');
  const risk = analyzeWorkflow(workflow);
  if (!validation.valid || risk.findings.some((finding) => finding.code === 'NO_TRIGGER')) {
    console.error(JSON.stringify({ validation, risk }, null, 2));
    throw new Error('Trigger detection is inconsistent for rssFeedReadTrigger.');
  }

  return 'passed';
}

function checkActivationTriggerValidation(): string {
  const manualWorkflow: any = {
    name: `Manual Activation ${randomUUID().slice(0, 8)}`,
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
  };
  const scheduleWorkflow: any = {
    ...manualWorkflow,
    name: `Scheduled Activation ${randomUUID().slice(0, 8)}`,
    nodes: [
      {
        ...manualWorkflow.nodes[0],
        id: 'schedule',
        name: 'Schedule Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
      },
    ],
  };

  const manualValidation = validateWorkflow(manualWorkflow, 'activation');
  const scheduleValidation = validateWorkflow(scheduleWorkflow, 'activation');
  if (
    manualValidation.valid ||
    !manualValidation.errors.some((error) => error.message.includes('non-manual trigger')) ||
    !scheduleValidation.valid
  ) {
    console.error(JSON.stringify({ manualValidation, scheduleValidation }, null, 2));
    throw new Error('Activation validation did not distinguish manual-only workflows.');
  }

  return 'passed';
}

async function cleanup(automationId: string, workflowId?: string) {
  if (workflowId) {
    const n8n = new N8nService();
    await n8n.deleteWorkflow(workflowId).catch(() => undefined);
  }

  const db = await getDb();
  await db.collection('automation_requests').deleteMany({
    $or: [
      { automationId },
      ...(workflowId ? [{ n8nWorkflowId: workflowId }] : []),
    ],
  }).catch(() => undefined);
  await db.collection('automation_events').deleteMany({ automationId }).catch(() => undefined);
  await db.collection('automation_workflow_snapshots').deleteMany({
    $or: [
      { automationId },
      ...(workflowId ? [{ n8nWorkflowId: workflowId }] : []),
    ],
  }).catch(() => undefined);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});

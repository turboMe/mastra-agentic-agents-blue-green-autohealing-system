#!/usr/bin/env tsx
import 'dotenv/config';
import { randomUUID } from 'crypto';

import { executeAutomationGoldenPath } from '../services/automation-golden-path.js';
import { N8nService } from '../tools/n8n/client.js';
import { getDb } from '../lib/mongo.js';
import { normalizeConnectionKeys, validateWorkflow } from '../tools/architect/validation/workflow-validator.js';
import { applyRepairs } from '../tools/architect/testing/repair-workflow.js';

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
  const safeResult = await executeAutomationGoldenPath({
    mode: 'workflow_json',
    automationId,
    workflow: {
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
    },
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
  } finally {
    await cleanup(automationId, safeResult.workflowId);
  }

  console.log('automation-golden-path check passed');
  console.log(`connectionIdNormalization=${connectionNormalization}`);
  console.log(`graphValidation=${graphValidation}`);
  console.log(`connectionRepair=${connectionRepair}`);
  console.log(`unsupportedVars=${unsupportedVars}`);
  console.log('inactiveAfterDeploy=passed');
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

async function cleanup(automationId: string, workflowId?: string) {
  if (workflowId) {
    const n8n = new N8nService();
    await n8n.deleteWorkflow(workflowId).catch(() => undefined);
  }

  const db = await getDb();
  await db.collection('automation_requests').deleteOne({ automationId }).catch(() => undefined);
  await db.collection('automation_events').deleteMany({ automationId }).catch(() => undefined);
  await db.collection('automation_workflow_snapshots').deleteMany({ automationId }).catch(() => undefined);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});

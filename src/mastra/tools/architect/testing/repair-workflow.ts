import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../../lib/mongo.js';
import { validateWorkflow } from '../validation/workflow-validator.js';
import { getCredentialFromRegistry } from '../credentials/credential-registry.js';
import { getRuntimeTopology } from '../../../config/runtime-topology.js';
import type { RepairChange, RepairResult, TestFinding } from './test-types.js';

const MAX_ATTEMPTS = 3;

export const repairWorkflowTool = createTool({
  id: 'architect_repair_workflow',
  description:
    'Probuje minimalnie zaadaptowac workflow do bledow z validate_workflow / test_workflow. Maksymalnie 3 proby per automationId. Nie generuje workflow od zera — tylko patche.',
  inputSchema: z.object({
    automationId: z.string(),
    workflow: z.any().describe('Aktualny workflow JSON do naprawy'),
    findings: z
      .array(
        z.object({
          severity: z.enum(['error', 'warning', 'info']),
          nodeName: z.string().optional(),
          message: z.string(),
          suggestedFix: z.string().optional(),
        }),
      )
      .optional()
      .describe('Findings z validate_workflow lub test_workflow'),
    attempt: z.number().int().min(1).max(MAX_ATTEMPTS).describe('Numer proby (1-3)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    automationId: z.string(),
    attempt: z.number(),
    patchedWorkflow: z.any().optional(),
    changes: z.array(
      z.object({
        nodeName: z.string().optional(),
        field: z.string(),
        reason: z.string(),
      }),
    ),
    remainingIssues: z.array(
      z.object({
        severity: z.enum(['error', 'warning', 'info']),
        nodeName: z.string().optional(),
        message: z.string(),
        suggestedFix: z.string().optional(),
      }),
    ),
    stopReason: z.string().optional(),
    message: z.string(),
  }),
  execute: async (context) => {
    const { automationId, attempt } = context;
    const db = await getDb();

    // Server-side guard: count past repair_attempt events.
    const pastAttempts = await db
      .collection('automation_events')
      .countDocuments({ automationId, type: 'repair_attempt' });
    if (pastAttempts >= MAX_ATTEMPTS) {
      return {
        success: false,
        automationId,
        attempt,
        changes: [],
        remainingIssues: [],
        stopReason: 'max_attempts_reached',
        message: `Max ${MAX_ATTEMPTS} repair attempts reached for ${automationId}. Wymaga manualnej interwencji.`,
      };
    }

    const result = applyRepairs(context.workflow, context.findings ?? []);

    // Re-validate after patching to compute remaining issues.
    const postValidation = validateWorkflow(result.patchedWorkflow ?? context.workflow, 'strict');
    const remaining: TestFinding[] = [
      ...postValidation.errors.map((e) => ({ severity: 'error' as const, nodeName: e.nodeName, message: e.message })),
      ...postValidation.securityIssues.map((s) => ({ severity: 'error' as const, nodeName: s.nodeName, message: s.message })),
      ...postValidation.missingCredentials.map((c) => ({
        severity: 'error' as const,
        message: `Missing credential: ${c.service}`,
        suggestedFix: c.setupHint,
      })),
      ...postValidation.missingConfig.map((c) => ({
        severity: 'error' as const,
        message: `Missing config: ${c.key}`,
        suggestedFix: c.description,
      })),
    ];

    await db.collection('automation_events').insertOne({
      automationId,
      type: 'repair_attempt',
      data: { attempt, changes: result.changes, remainingCount: remaining.length },
      createdAt: new Date(),
    });

    const success = result.changes.length > 0 && remaining.length === 0;

    return {
      success,
      automationId,
      attempt,
      patchedWorkflow: result.patchedWorkflow,
      changes: result.changes,
      remainingIssues: remaining,
      stopReason: result.changes.length === 0 ? 'no_changes_possible' : undefined,
      message: success
        ? `Workflow naprawiony (proba ${attempt}/${MAX_ATTEMPTS}). Uzyj deploy_automation zeby zapisac patch.`
        : result.changes.length === 0
          ? 'Brak zmian mozliwych do automatycznego zastosowania. Wymaga zmiany specu lub manualnej interwencji.'
          : `Workflow czesciowo naprawiony (zmiany: ${result.changes.length}), ale pozostaly bledy. Sprobuj ponownie lub wymaga manualnej interwencji.`,
    };
  },
});

export function applyRepairs(
  workflow: any,
  findings: { severity: string; nodeName?: string; message: string; suggestedFix?: string }[],
): RepairResult {
  const changes: RepairChange[] = [];

  if (!workflow || typeof workflow !== 'object') {
    return { success: false, changes, remainingIssues: [], stopReason: 'invalid_workflow_input' };
  }

  const patched = JSON.parse(JSON.stringify(workflow));
  const nodes: any[] = Array.isArray(patched.nodes) ? patched.nodes : [];
  const topology = getRuntimeTopology();
  const mastraBase = topology.mastraApiUrlForN8n.replace(/\/$/, '');

  // 1. Always force inactive
  if (patched.active !== false) {
    patched.active = false;
    changes.push({ field: 'active', reason: 'Forced active=false (drafts must not auto-activate).' });
  }

  // 2. Always ensure settings.executionOrder
  if (!patched.settings || typeof patched.settings !== 'object') {
    patched.settings = { executionOrder: 'v1' };
    changes.push({ field: 'settings', reason: 'Added missing settings.executionOrder=v1.' });
  } else if (patched.settings.executionOrder !== 'v1') {
    patched.settings.executionOrder = 'v1';
    changes.push({ field: 'settings.executionOrder', reason: 'Forced settings.executionOrder=v1.' });
  }

  // 3. Per-node patches
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const params = node.parameters ?? {};

    // 3a. Telegram credential injection
    if (
      (node.type === 'n8n-nodes-base.telegram' || node.type === 'n8n-nodes-base.telegramTrigger') &&
      !node.credentials?.telegramApi
    ) {
      const cred = getCredentialFromRegistry('telegram');
      if (cred) {
        node.credentials = { ...(node.credentials ?? {}), telegramApi: { id: cred.id, name: cred.name } };
        changes.push({
          nodeName: node.name,
          field: 'credentials.telegramApi',
          reason: `Wpiety credential z registry (id=${cred.id}).`,
        });
      }
    }

    // 3b. Telegram empty chatId
    if (node.type === 'n8n-nodes-base.telegram' && (!params.chatId || params.chatId === '')) {
      const chatId = process.env.N8N_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        node.parameters = { ...params, chatId };
        changes.push({ nodeName: node.name, field: 'parameters.chatId', reason: 'Wypelniony z N8N_TELEGRAM_CHAT_ID.' });
      }
    }

    // 3c. Mongo credential injection
    if (node.type === 'n8n-nodes-base.mongoDb' && !node.credentials?.mongoDb) {
      const cred = getCredentialFromRegistry('mongo');
      if (cred) {
        node.credentials = { ...(node.credentials ?? {}), mongoDb: { id: cred.id, name: cred.name } };
        changes.push({
          nodeName: node.name,
          field: 'credentials.mongoDb',
          reason: `Wpiety credential z registry (id=${cred.id}).`,
        });
      }
    }

    // 3d. Gmail credential injection
    if (
      (node.type === 'n8n-nodes-base.gmail' || node.type === 'n8n-nodes-base.gmailTrigger') &&
      !node.credentials?.googleGmailOAuth2Api &&
      !node.credentials?.gmailOAuth2
    ) {
      const cred = getCredentialFromRegistry('gmail');
      if (cred) {
        node.credentials = { ...(node.credentials ?? {}), [cred.n8nCredentialType]: { id: cred.id, name: cred.name } };
        changes.push({
          nodeName: node.name,
          field: `credentials.${cred.n8nCredentialType}`,
          reason: `Wpiety credential z registry (id=${cred.id}).`,
        });
      }
    }

    // 3e. Replace localhost:3000 (legacy) with mastra API base
    const replaced = replaceInDeep(node.parameters, 'http://localhost:3000', mastraBase);
    if (replaced.changed) {
      node.parameters = replaced.value;
      changes.push({
        nodeName: node.name,
        field: 'parameters.*',
        reason: `Zamieniono legacy http://localhost:3000 na ${mastraBase}.`,
      });
    }

    // 3f. Replace af-mongodb in local-host-network mode
    if (topology.mode === 'local-host-network') {
      const mongoFix = replaceInDeep(node.parameters, 'af-mongodb', topology.mongoHostForN8n.split(':')[0]);
      if (mongoFix.changed) {
        node.parameters = mongoFix.value;
        changes.push({
          nodeName: node.name,
          field: 'parameters.*',
          reason: `Zamieniono af-mongodb na ${topology.mongoHostForN8n.split(':')[0]} (local-host-network).`,
        });
      }
    }

    // 3g. Strip $vars.* (not supported in community)
    const varsFix = stripVars(node.parameters);
    if (varsFix.changed) {
      node.parameters = varsFix.value;
      changes.push({
        nodeName: node.name,
        field: 'parameters.*',
        reason: `Usunieto wystapienia $vars.* (nieobslugiwane w n8n Community).`,
      });
    }

    // 3h. Ensure unique name (rename duplicates by appending suffix)
    // Handled at workflow level below.
  }

  // 4. Deduplicate node names (rare but validation flags it)
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node?.name) continue;
    if (seen.has(node.name)) {
      const newName = `${node.name}_${Math.random().toString(36).slice(2, 6)}`;
      changes.push({ nodeName: node.name, field: 'name', reason: `Zmieniono na ${newName} (duplikat).` });
      node.name = newName;
    }
    seen.add(node.name);
  }

  // Suggestions from findings that we can't auto-fix get reflected as no-ops here;
  // they'll appear in remaining issues after re-validation.
  void findings;

  return {
    success: changes.length > 0,
    patchedWorkflow: patched,
    changes,
    remainingIssues: [],
  };
}

function replaceInDeep(value: unknown, search: string, replacement: string): { value: any; changed: boolean } {
  if (typeof value === 'string') {
    if (value.includes(search)) {
      return { value: value.split(search).join(replacement), changed: true };
    }
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = replaceInDeep(item, search, replacement);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = replaceInDeep(v, search, replacement);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

function stripVars(value: unknown): { value: any; changed: boolean } {
  if (typeof value === 'string') {
    if (/\$vars\./.test(value)) {
      return { value: value.replace(/\$vars\.[a-zA-Z0-9_]+/g, '""'), changed: true };
    }
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = stripVars(item);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = stripVars(v);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

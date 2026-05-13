/**
 * Log-only policy layer for coding harness tool actions.
 *
 * The first rollout is intentionally non-blocking. Decisions record what the
 * harness would allow, warn about, or block once enforcement is enabled, while
 * `effectiveAllow` remains true in log-only mode.
 */

import { randomUUID } from 'crypto';
import { isAbsolute, normalize, relative, resolve, sep } from 'path';

import { isHarnessFeatureEnabled } from '../config/harness-flags.js';
import { getDb } from '../lib/mongo.js';
import { redactSecrets } from '../lib/secrets-redactor.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { logHarnessEvent } from './harness-events.js';

export type HarnessPolicyAction =
  | 'read_file'
  | 'write_file'
  | 'run_command'
  | 'apply_patch'
  | 'network'
  | 'git'
  | 'approval'
  | 'memory_write';

export type HarnessPolicyRisk = 'low' | 'medium' | 'high';
export type HarnessPolicySeverity = 'info' | 'warning' | 'block';
export type HarnessPolicyMode = 'off' | 'log_only' | 'enforce';

export type HarnessPolicyRequest = {
  runId?: string;
  turnId?: string;
  taskId?: string;
  subtaskId?: string;
  threadId?: string;
  agentId: string;
  toolId?: string;
  action: HarnessPolicyAction;
  target?: string;
  command?: string;
  riskHint?: HarnessPolicyRisk;
};

export type HarnessPolicyDecision = {
  id: string;
  allow: boolean;
  effectiveAllow: boolean;
  requiresApproval: boolean;
  severity: HarnessPolicySeverity;
  reason: string;
  approvalType?: string;
  matchedRule: string;
  enforcementMode: HarnessPolicyMode;
  enforced: boolean;
};

type CodingTaskScope = {
  artifactExists: boolean;
  worktreePath?: string;
};

const DEFAULT_POLICY_MODE: HarnessPolicyMode = 'log_only';

export function getHarnessPolicyMode(): HarnessPolicyMode {
  if (!isHarnessFeatureEnabled('FEATURE_HARNESS_POLICY', true)) return 'off';

  const requestedMode = process.env.HARNESS_POLICY_MODE?.trim().toLowerCase();
  if (requestedMode === 'off' || requestedMode === 'disabled') return 'off';
  if (requestedMode === 'enforce' || requestedMode === 'enforced') return 'enforce';
  return DEFAULT_POLICY_MODE;
}

export async function evaluateAndLogHarnessPolicy(
  request: HarnessPolicyRequest,
): Promise<HarnessPolicyDecision> {
  const enforcementMode = getHarnessPolicyMode();
  const baseDecision = enforcementMode === 'off'
    ? allowDecision('policy_disabled', 'Harness policy is disabled.')
    : await safeEvaluatePolicy(request);

  const decision = applyEnforcementMode(baseDecision, enforcementMode);
  if (enforcementMode !== 'off') {
    await logPolicyDecision(request, decision);
  }

  return decision;
}

function applyEnforcementMode(
  decision: Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>,
  enforcementMode: HarnessPolicyMode,
): HarnessPolicyDecision {
  const enforced = enforcementMode === 'enforce' && !decision.allow;
  return {
    ...decision,
    id: randomUUID(),
    enforcementMode,
    enforced,
    effectiveAllow: enforcementMode === 'enforce' ? decision.allow : true,
  };
}

async function safeEvaluatePolicy(
  request: HarnessPolicyRequest,
): Promise<Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>> {
  try {
    return await evaluatePolicy(request);
  } catch (error) {
    return allowDecision(
      'policy_evaluation_failed',
      `Policy evaluation failed and was treated as log-only allow: ${(error as Error).message}`,
      'warning',
    );
  }
}

async function evaluatePolicy(
  request: HarnessPolicyRequest,
): Promise<Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>> {
  switch (request.action) {
    case 'read_file':
      return evaluateReadFilePolicy(request);
    case 'write_file':
      return evaluateWriteFilePolicy(request);
    case 'run_command':
      return evaluateCommandPolicy(request);
    case 'apply_patch':
      return requireApprovalDecision(
        'apply_patch_requires_approval',
        'Applying a worktree patch mutates the live repository and should require approval.',
        'merge_live_repo',
        'warning',
      );
    case 'network':
      return requireApprovalDecision(
        'network_requires_approval',
        'Network access should require approval before enforcement mode is enabled.',
        'network',
      );
    case 'git':
      return requireApprovalDecision(
        'git_mutation_requires_approval',
        'Git mutation should require approval before enforcement mode is enabled.',
        'git_mutation',
      );
    case 'approval':
    case 'memory_write':
      return allowDecision(`${request.action}_allowed`, `${request.action} is allowed and logged.`);
  }
}

async function evaluateReadFilePolicy(
  request: HarnessPolicyRequest,
): Promise<Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>> {
  const target = request.target?.trim();
  if (!target) {
    return blockDecision('read_target_missing', 'Read action did not include a target path.');
  }

  const scope = await getCodingTaskScope(request.taskId);
  const rootPath = scope.worktreePath ?? AGENTIC_AGENTS_REPO;
  const pathCheck = checkPathInsideRoot(target, rootPath);
  if (!pathCheck.inside) {
    return blockDecision('read_outside_workspace', `Read target is outside coding workspace: ${safeText(target)}`);
  }

  if (isBlockedRepoPath(pathCheck.relativePath)) {
    return blockDecision('read_blocked_path', `Read target is blocked by policy: ${pathCheck.relativePath}`);
  }

  return allowDecision('read_workspace_file', `Read target is inside ${scope.worktreePath ? 'task worktree' : 'repo workspace'}.`);
}

async function evaluateWriteFilePolicy(
  request: HarnessPolicyRequest,
): Promise<Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'>> {
  const target = request.target?.trim();
  if (!target) {
    return blockDecision('write_target_missing', 'Write action did not include a target path.');
  }

  const scope = await getCodingTaskScope(request.taskId);
  if (!request.taskId) {
    return blockDecision('write_missing_task', 'Write action did not include taskId; task worktree cannot be verified.');
  }
  if (!scope.artifactExists) {
    return blockDecision('write_missing_artifact', `Task artifact does not exist for ${request.taskId}.`);
  }
  if (!scope.worktreePath) {
    return blockDecision(
      'write_without_worktree',
      `Write would target the live repository for ${request.taskId}. Run coding_init_worktree first.`,
    );
  }

  const pathCheck = checkPathInsideRoot(target, scope.worktreePath);
  if (!pathCheck.inside) {
    return blockDecision('write_outside_worktree', `Write target is outside task worktree: ${safeText(target)}`);
  }
  if (isBlockedRepoPath(pathCheck.relativePath)) {
    return blockDecision('write_blocked_path', `Write target is blocked by policy: ${pathCheck.relativePath}`);
  }

  return allowDecision('write_task_worktree', 'Write target is inside the task worktree.');
}

function evaluateCommandPolicy(
  request: HarnessPolicyRequest,
): Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'> {
  const command = normalizeCommand(request.command ?? '');
  if (!command) {
    return blockDecision('command_missing', 'Command action did not include a command.');
  }

  if (isDestructiveCommand(command)) {
    return requireApprovalDecision(
      'destructive_command_requires_approval',
      `Destructive command requires approval: ${safeText(command)}`,
      'destructive_command',
      'block',
    );
  }
  if (isGitMutationCommand(command)) {
    return requireApprovalDecision(
      'git_mutation_requires_approval',
      `Git mutation requires approval: ${safeText(command)}`,
      'git_mutation',
    );
  }
  if (isPackageInstallCommand(command)) {
    return requireApprovalDecision(
      'package_install_requires_approval',
      `Package install/update requires approval: ${safeText(command)}`,
      'package_install',
    );
  }
  if (isNetworkCommand(command)) {
    return requireApprovalDecision(
      'network_command_requires_approval',
      `Network command requires approval: ${safeText(command)}`,
      'network',
    );
  }
  if (isReadOnlyCommand(command)) {
    return allowDecision('readonly_command_allowed', 'Read-only command is allowed.');
  }
  if (isSafeVerificationCommand(command)) {
    return allowDecision('verification_command_allowed', 'Verification command is allowed.');
  }

  return requireApprovalDecision(
    'unknown_command_requires_approval',
    `Unknown command should require approval before enforcement mode is enabled: ${safeText(command)}`,
    'unknown_command',
  );
}

async function getCodingTaskScope(taskId: string | undefined): Promise<CodingTaskScope> {
  if (!taskId) return { artifactExists: false };
  const db = await getDb();
  const artifact = await db.collection('code_task_artifacts').findOne(
    { taskId },
    { projection: { worktreePath: 1 } },
  );

  return {
    artifactExists: Boolean(artifact),
    worktreePath: typeof artifact?.worktreePath === 'string' && artifact.worktreePath.trim()
      ? artifact.worktreePath
      : undefined,
  };
}

function allowDecision(
  matchedRule: string,
  reason: string,
  severity: HarnessPolicySeverity = 'info',
): Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'> {
  return {
    allow: true,
    requiresApproval: false,
    severity,
    reason,
    matchedRule,
  };
}

function requireApprovalDecision(
  matchedRule: string,
  reason: string,
  approvalType: string,
  severity: HarnessPolicySeverity = 'warning',
): Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'> {
  return {
    allow: false,
    requiresApproval: true,
    severity,
    reason,
    approvalType,
    matchedRule,
  };
}

function blockDecision(
  matchedRule: string,
  reason: string,
): Omit<HarnessPolicyDecision, 'id' | 'effectiveAllow' | 'enforcementMode' | 'enforced'> {
  return {
    allow: false,
    requiresApproval: false,
    severity: 'block',
    reason,
    matchedRule,
  };
}

function checkPathInsideRoot(target: string, rootPath: string): { inside: boolean; relativePath: string } {
  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(resolvedRoot, target);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  const inside = resolvedTarget === resolvedRoot || resolvedTarget.startsWith(rootWithSep);
  const relativePath = normalize(relative(resolvedRoot, resolvedTarget)).replace(/\\/g, '/');

  return {
    inside: inside && relativePath !== '..' && !relativePath.startsWith('../'),
    relativePath,
  };
}

function isBlockedRepoPath(relativePath: string): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  return (
    normalizedPath === '.' ||
    normalizedPath === '.git' ||
    normalizedPath.startsWith('.git/') ||
    normalizedPath === 'node_modules' ||
    normalizedPath.startsWith('node_modules/') ||
    normalizedPath === '.env' ||
    normalizedPath.startsWith('.env.')
  );
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isReadOnlyCommand(command: string): boolean {
  return [
    /^pwd$/,
    /^ls(\s|$)/,
    /^find\s/,
    /^rg(\s|$)/,
    /^sed\s+-n\s/,
    /^cat\s/,
    /^head(\s|$)/,
    /^tail(\s|$)/,
    /^wc(\s|$)/,
    /^git\s+status(\s|$)/,
    /^git\s+diff(\s|$)/,
    /^git\s+log(\s|$)/,
    /^git\s+show(\s|$)/,
  ].some((pattern) => pattern.test(command));
}

function isSafeVerificationCommand(command: string): boolean {
  return [
    /^npx\s+tsc\s+--noEmit$/,
    /^npx\s+vitest(\s|$)/,
    /^npx\s+jest(\s|$)/,
    /^npx\s+eslint(\s|$)/,
    /^npm\s+test(\s|$)/,
    /^npm\s+run\s+test(\s|$)/,
    /^npm\s+run\s+lint(\s|$)/,
    /^npm\s+run\s+build(\s|$)/,
    /^pnpm\s+test(\s|$)/,
    /^pnpm\s+lint(\s|$)/,
    /^node\s+--check(\s|$)/,
  ].some((pattern) => pattern.test(command));
}

function isPackageInstallCommand(command: string): boolean {
  return [
    /^npm\s+install\b/,
    /^npm\s+update\b/,
    /^npm\s+add\b/,
    /^pnpm\s+install\b/,
    /^pnpm\s+add\b/,
    /^pnpm\s+update\b/,
    /^yarn\s+add\b/,
    /^yarn\s+install\b/,
    /^yarn\s+upgrade\b/,
  ].some((pattern) => pattern.test(command));
}

function isNetworkCommand(command: string): boolean {
  return [
    /^curl\b/,
    /^wget\b/,
    /^git\s+fetch\b/,
    /^git\s+pull\b/,
    /^docker\s+pull\b/,
    /^docker\s+compose\s+pull\b/,
    /^npx\s+(?!tsc\s+--noEmit\b|vitest\b|jest\b|eslint\b)/,
    /\bfetch\s*\(/,
  ].some((pattern) => pattern.test(command));
}

function isGitMutationCommand(command: string): boolean {
  return [
    /^git\s+merge\b/,
    /^git\s+push\b/,
    /^git\s+branch\s+-D\b/,
    /^git\s+branch\s+--delete\s+--force\b/,
    /^git\s+worktree\s+remove\b/,
    /^git\s+commit\b/,
    /^git\s+add\b/,
  ].some((pattern) => pattern.test(command));
}

function isDestructiveCommand(command: string): boolean {
  return [
    /\brm\s+-rf\b/,
    /^rm\s/,
    /^sudo\b/,
    /^su\b/,
    /^chmod\s+-R\b/,
    /^chown\s+-R\b/,
    /^git\s+reset\b/,
    /^git\s+clean\b/,
    /^git\s+checkout\s+--\b/,
    /^git\s+push\s+--force\b/,
    /^docker\s+system\s+prune\b/,
    /^mongo\b.*--eval\b.*drop/i,
    /\bdropDatabase\s*\(/i,
  ].some((pattern) => pattern.test(command));
}

async function logPolicyDecision(
  request: HarnessPolicyRequest,
  decision: HarnessPolicyDecision,
): Promise<void> {
  await logHarnessEvent({
    type: decision.allow ? 'policy_allowed' : 'policy_blocked',
    agentId: request.agentId,
    runId: request.runId,
    turnId: request.turnId,
    threadId: request.threadId,
    taskId: request.taskId,
    subtaskId: request.subtaskId,
    feature: 'harness_policy',
    toolId: request.toolId,
    status: decision.effectiveAllow ? 'success' : 'error',
    input: policyPreview(request),
    errorMessage: decision.effectiveAllow ? undefined : decision.reason,
    data: {
      decisionId: decision.id,
      action: request.action,
      target: request.target ? safeText(request.target) : undefined,
      command: request.command ? safeText(request.command) : undefined,
      riskHint: request.riskHint,
      allow: decision.allow,
      effectiveAllow: decision.effectiveAllow,
      requiresApproval: decision.requiresApproval,
      severity: decision.severity,
      reason: decision.reason,
      approvalType: decision.approvalType,
      matchedRule: decision.matchedRule,
      enforcementMode: decision.enforcementMode,
      enforced: decision.enforced,
    },
  });
}

function policyPreview(request: HarnessPolicyRequest): string {
  const target = request.command ?? request.target ?? '';
  return safeText(`${request.action}${target ? `: ${target}` : ''}`, 500);
}

function safeText(text: string, maxLength = 300): string {
  const redacted = redactSecrets(text).text;
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}

import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { IsolationBackend } from '@mastra/core/workspace';
import { getDb } from '../lib/mongo.js';

export const AGENTIC_AGENTS_REPO = '/projekty/mastra-agentic-environment/agentic-agents';

export async function getWorkspacePath(taskId: string): Promise<string> {
  const db = await getDb();
  const artifact = await db.collection('code_task_artifacts').findOne({ taskId });
  if (artifact && typeof artifact.worktreePath === 'string') {
    return artifact.worktreePath;
  }
  return AGENTIC_AGENTS_REPO;
}

const CODE_SANDBOX_ISOLATION: IsolationBackend =
  process.env.CODING_SANDBOX_ISOLATION === 'bwrap' ||
  process.env.CODING_SANDBOX_ISOLATION === 'seatbelt'
    ? process.env.CODING_SANDBOX_ISOLATION
    : 'none';

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isReadOnlyCommand(command: string): boolean {
  const c = normalizeCommand(command);
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
    /^git\s+branch(\s|$)/,
  ].some((pattern) => pattern.test(c));
}

function isSafeVerificationCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /^npx\s+tsc\s+--noEmit$/,
    /^npm\s+test(\s|$)/,
    /^npm\s+run\s+test(\s|$)/,
    /^npm\s+run\s+lint(\s|$)/,
    /^pnpm\s+test(\s|$)/,
    /^pnpm\s+lint(\s|$)/,
  ].some((pattern) => pattern.test(c));
}

function isNetworkCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return [
    /^npm\s+install\b/,
    /^pnpm\s+install\b/,
    /^npm\s+update\b/,
    /^pnpm\s+update\b/,
    /^npx\s+(?!tsc\s+--noEmit\b)/,
    /^curl\b/,
    /^wget\b/,
    /^git\s+fetch\b/,
    /^git\s+pull\b/,
    /^docker\s+pull\b/,
    /^docker\s+compose\s+pull\b/,
    /\bnode\s+.*fetch\s*\(/,
  ].some((pattern) => pattern.test(c));
}

function isBlockedCommand(command: string): boolean {
  const c = normalizeCommand(command);
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
  ].some((pattern) => pattern.test(c));
}

export function requiresCodeCommandApproval(command: string): boolean {
  if (isBlockedCommand(command)) return true;
  if (isNetworkCommand(command)) return true;
  if (isReadOnlyCommand(command)) return false;
  if (isSafeVerificationCommand(command)) return false;
  return true;
}

export const codeWorkspace = new Workspace({
  id: 'agentic-agents-code-workspace',
  name: 'Agentic Agents Repo Workspace',

  filesystem: new LocalFilesystem({
    basePath: AGENTIC_AGENTS_REPO,
    contained: true,
  }),

  sandbox: new LocalSandbox({
    workingDirectory: AGENTIC_AGENTS_REPO,
    isolation: CODE_SANDBOX_ISOLATION,
    nativeSandbox: {
      allowNetwork: false,
    },
  }),

  lsp: true,
  bm25: true,
  autoIndexPaths: [
    'src',
    'docs',
    'ideas',
    'scratch',
    'package.json',
    'tsconfig.json',
  ],
  skills: [
    'src/mastra/_skills/terminal',
  ],

  tools: {
    enabled: false,
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
      enabled: true,
      name: 'view',
    },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      enabled: true,
      name: 'write_file',
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
      enabled: true,
      name: 'find_files',
    },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
      enabled: true,
      name: 'search_content',
    },
    [WORKSPACE_TOOLS.SEARCH.SEARCH]: {
      enabled: true,
      name: 'workspace_search',
    },
    [WORKSPACE_TOOLS.SEARCH.INDEX]: {
      enabled: true,
      name: 'index_content',
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
      enabled: true,
      name: 'lsp_inspect',
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      enabled: true,
      name: 'execute_command',
      requireApproval: ({ args }) => requiresCodeCommandApproval(String(args.command ?? '')),
    },
  },
});

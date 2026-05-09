/**
 * External Project Workspace Factory (Etap 10.4)
 *
 * Creates isolated workspaces for coding OTHER projects — not the agent itself.
 * Each project gets its own directory under /projekty/agent-projects/<name>.
 *
 * Key safety properties:
 *   - CANNOT access /projekty/mastra-agentic-environment/ (agent's own code)
 *   - Each project is fully sandboxed (own filesystem, sandbox, LSP)
 *   - Network disabled by default (same as self-coding workspace)
 *   - Approval required for writes (agent must read before write)
 */

import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { IsolationBackend } from '@mastra/core/workspace';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { requiresCodeCommandApproval } from './code-workspace.js';

// ── Config ───────────────────────────────────────────────────────────────────

export const AGENT_PROJECTS_BASE = process.env.AGENT_PROJECTS_DIR || '/projekty/agent-projects';

const EXTERNAL_SANDBOX_ISOLATION: IsolationBackend =
  process.env.CODING_SANDBOX_ISOLATION === 'bwrap' ||
  process.env.CODING_SANDBOX_ISOLATION === 'seatbelt'
    ? process.env.CODING_SANDBOX_ISOLATION
    : 'none';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExternalProject {
  name: string;
  path: string;
  workspace: Workspace;
  createdAt: string;
}

// ── Registry (in-memory, populated at runtime) ───────────────────────────────

const projectRegistry = new Map<string, ExternalProject>();

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create or get a workspace for an external project.
 *
 * @param projectName - Name of the project (alphanumeric + dashes)
 * @param options - Optional overrides
 * @returns ExternalProject with ready workspace
 */
export function getOrCreateExternalProject(
  projectName: string,
  options?: {
    initGit?: boolean;       // git init (default: true)
    initNpm?: boolean;       // npm init -y (default: false)
    template?: 'empty' | 'typescript' | 'node';  // scaffold template
  },
): ExternalProject {
  // Sanitize project name
  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');

  // Return from cache if already registered
  const cached = projectRegistry.get(sanitized);
  if (cached) return cached;

  // Build path
  const projectDir = resolve(AGENT_PROJECTS_BASE, sanitized);

  // ── Safety check: block access to agent's own code ──
  const agentDir = '/projekty/mastra-agentic-environment';
  if (projectDir.startsWith(agentDir)) {
    throw new Error(
      `[ExternalProject] BLOCKED: Cannot create external project inside agent's own directory (${agentDir}). ` +
      `Use the code-workspace for self-modifications.`
    );
  }

  // Create directory if needed
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
    console.log(`[ExternalProject] Created project directory: ${projectDir}`);

    // Optional: git init
    if (options?.initGit !== false) {
      try {
        execSync('git init', { cwd: projectDir, stdio: 'pipe' });
        console.log(`[ExternalProject] Initialized git repo`);
      } catch (e) {
        console.warn(`[ExternalProject] git init failed (non-critical)`);
      }
    }

    // Optional: npm init
    if (options?.initNpm) {
      try {
        execSync('npm init -y', { cwd: projectDir, stdio: 'pipe' });
        console.log(`[ExternalProject] Initialized npm package`);
      } catch (e) {
        console.warn(`[ExternalProject] npm init failed (non-critical)`);
      }
    }

    // Optional: TypeScript template
    if (options?.template === 'typescript') {
      try {
        execSync('npm init -y && npm install --save-dev typescript @types/node', {
          cwd: projectDir,
          stdio: 'pipe',
          timeout: 60000,
        });
        execSync('npx tsc --init --target es2022 --module nodenext --outDir dist --rootDir src', {
          cwd: projectDir,
          stdio: 'pipe',
        });
        mkdirSync(resolve(projectDir, 'src'), { recursive: true });
        console.log(`[ExternalProject] TypeScript template applied`);
      } catch (e) {
        console.warn(`[ExternalProject] TypeScript template setup failed (non-critical)`);
      }
    }
  }

  // Create workspace
  const workspace = new Workspace({
    id: `external-project-${sanitized}`,
    name: `External: ${sanitized}`,

    filesystem: new LocalFilesystem({
      basePath: projectDir,
      contained: true,     // Cannot escape project directory
    }),

    sandbox: new LocalSandbox({
      workingDirectory: projectDir,
      isolation: EXTERNAL_SANDBOX_ISOLATION,
      nativeSandbox: {
        allowNetwork: false,
      },
    }),

    lsp: true,
    bm25: true,
    autoIndexPaths: [
      'src',
      'lib',
      'app',
      'components',
      'pages',
      'package.json',
      'tsconfig.json',
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
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
        enabled: true,
        name: 'execute_command',
        requireApproval: ({ args }) => requiresCodeCommandApproval(String(args.command ?? '')),
      },
      [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
        enabled: true,
        name: 'lsp_inspect',
      },
    },
  });

  const project: ExternalProject = {
    name: sanitized,
    path: projectDir,
    workspace,
    createdAt: new Date().toISOString(),
  };

  projectRegistry.set(sanitized, project);
  return project;
}

// ── Listing ──────────────────────────────────────────────────────────────────

/**
 * List all external projects (from disk + registry).
 */
export function listExternalProjects(): Array<{ name: string; path: string; hasGit: boolean }> {
  const results: Array<{ name: string; path: string; hasGit: boolean }> = [];

  if (!existsSync(AGENT_PROJECTS_BASE)) return results;

  try {
    const { readdirSync, statSync } = require('fs');
    const entries = readdirSync(AGENT_PROJECTS_BASE) as string[];

    for (const entry of entries) {
      const fullPath = resolve(AGENT_PROJECTS_BASE, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          results.push({
            name: entry,
            path: fullPath,
            hasGit: existsSync(resolve(fullPath, '.git')),
          });
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Base dir not readable
  }

  return results;
}

/**
 * Get an existing external project workspace (without creating).
 * Returns null if project doesn't exist.
 */
export function getExternalProject(projectName: string): ExternalProject | null {
  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');

  // Check cache first
  const cached = projectRegistry.get(sanitized);
  if (cached) return cached;

  // Check disk
  const projectDir = resolve(AGENT_PROJECTS_BASE, sanitized);
  if (!existsSync(projectDir)) return null;

  // Create workspace wrapper (lazy init)
  return getOrCreateExternalProject(sanitized);
}

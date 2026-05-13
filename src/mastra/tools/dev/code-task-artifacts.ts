import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { getWorkspacePath } from '../../workspaces/code-workspace.js';
import { recordFileActivity } from '../../services/file-activity.js';
import { withToolEnvelope } from '../../services/harness-tool-envelope.js';
import { compactHarnessOutput } from '../../services/harness-output-compactor.js';

const execAsync = promisify(exec);

const CODE_TASK_STATUSES = [
  'planning',
  'editing',
  'testing',
  'reviewing',
  'waiting_approval',
  'done',
  'failed',
] as const;

const CODE_AGENT_IDS = ['codingAgent', 'codeReviewAgent', 'metaAgent'] as const;
const REVIEW_VERDICTS = ['approve', 'needs_changes', 'block'] as const;
const TEST_STATUSES = ['passed', 'failed', 'skipped'] as const;

const fileChangeSchema = z.object({
  path: z.string(),
  beforeHash: z.string(),
  afterHash: z.string(),
  summary: z.string(),
});

const commandRunSchema = z.object({
  command: z.string(),
  approvalRequired: z.boolean(),
  exitCode: z.number().optional(),
  summary: z.string(),
  outputPreview: z.string().optional(),
  outputArtifactId: z.string().optional(),
  outputTruncated: z.boolean().optional(),
});

const approvalRequestSchema = z.object({
  approvalId: z.string(),
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
});

const testResultSchema = z.object({
  command: z.string(),
  status: z.enum(TEST_STATUSES),
  summary: z.string(),
  outputArtifactId: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  originalBytes: z.number().optional(),
  previewBytes: z.number().optional(),
});

const subtaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  targetFiles: z.array(z.string()),
  type: z.enum(['edit', 'create', 'delete', 'test', 'config']),
  priority: z.number(),
  estimatedComplexity: z.enum(['trivial', 'simple', 'moderate', 'complex']).optional(),
  dependencies: z.array(z.string()),
  // ── Model routing (populated by Smart Router, not by LLM) ──
  assignedModel: z.string().optional().describe('Model ID assigned by router, e.g. ollama/local/qwen3:1.7b'),
  parallelGroup: z.number().optional().describe('Execution group number — subtasks in same group run concurrently'),
  estimatedVramMb: z.number().optional().describe('VRAM needed for assigned model'),
});

const diagnosticPlanSchema = z.object({
  rootCause: z.string(),
  hypothesis: z.string(),
  impactAnalysis: z.object({
    errorFile: z.string(),
    errorLine: z.number().optional(),
    directFiles: z.array(z.string()),
    dependentFiles: z.array(z.string()),
    testFiles: z.array(z.string()),
    configFiles: z.array(z.string()),
  }),
  riskLevel: z.enum(['low', 'medium', 'high']),
  riskJustification: z.string(),
  subtasks: z.array(subtaskSchema),
  verificationPlan: z.object({
    commands: z.array(z.string()),
    expectedOutcome: z.string(),
  }),
});

const codeTaskArtifactSchema = z.object({
  taskId: z.string(),
  status: z.enum(CODE_TASK_STATUSES),
  agentId: z.enum(CODE_AGENT_IDS),
  userRequest: z.string(),
  plan: z.array(z.string()),
  filesRead: z.array(z.string()),
  filesChanged: z.array(fileChangeSchema),
  commandsRun: z.array(commandRunSchema),
  approvalsRequested: z.array(approvalRequestSchema),
  worktreePath: z.string().optional(),
  branchName: z.string().optional(),
  diffSummary: z.string(),
  testResult: testResultSchema.optional(),
  diagnosticPlan: diagnosticPlanSchema.optional(),
  reviewVerdict: z.enum(REVIEW_VERDICTS).optional(),
  rollbackAvailable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const compressedFileChangeSchema = z.object({
  path: z.string(),
  summary: z.string(),
});

const compressedArtifactSchema = codeTaskArtifactSchema.omit({ filesChanged: true }).extend({
  filesChanged: z.array(compressedFileChangeSchema),
});

type CodeTaskArtifact = z.infer<typeof codeTaskArtifactSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeArtifact(doc: Record<string, unknown>): CodeTaskArtifact {
  return {
    taskId: String(doc.taskId),
    status: doc.status as CodeTaskArtifact['status'],
    agentId: doc.agentId as CodeTaskArtifact['agentId'],
    userRequest: String(doc.userRequest ?? ''),
    plan: Array.isArray(doc.plan) ? doc.plan.map(String) : [],
    filesRead: Array.isArray(doc.filesRead) ? doc.filesRead.map(String) : [],
    filesChanged: Array.isArray(doc.filesChanged) ? doc.filesChanged as CodeTaskArtifact['filesChanged'] : [],
    commandsRun: Array.isArray(doc.commandsRun) ? doc.commandsRun as CodeTaskArtifact['commandsRun'] : [],
    approvalsRequested: Array.isArray(doc.approvalsRequested)
      ? doc.approvalsRequested as CodeTaskArtifact['approvalsRequested']
      : [],
    worktreePath: typeof doc.worktreePath === 'string' ? doc.worktreePath : undefined,
    branchName: typeof doc.branchName === 'string' ? doc.branchName : undefined,
    diffSummary: String(doc.diffSummary ?? ''),
    testResult: doc.testResult as CodeTaskArtifact['testResult'],
    diagnosticPlan: doc.diagnosticPlan as CodeTaskArtifact['diagnosticPlan'],
    reviewVerdict: doc.reviewVerdict as CodeTaskArtifact['reviewVerdict'],
    rollbackAvailable: Boolean(doc.rollbackAvailable),
    createdAt: String(doc.createdAt),
    updatedAt: String(doc.updatedAt),
  };
}

export const createCodeTaskArtifactTool = createTool({
  id: 'coding_create_artifact',
  description:
    'Tworzy artifact zadania kodowego: plan, pliki, komendy, diff, wynik testow i status rollbacku. Wywolaj na poczatku kazdego coding taska.',
  inputSchema: z.object({
    taskId: z.string().optional().describe('Opcjonalne ID zadania. Jesli puste, narzedzie wygeneruje UUID.'),
    userRequest: z.string().min(1).describe('Oryginalna prosba uzytkownika lub zwiezly opis zadania.'),
    agentId: z.enum(CODE_AGENT_IDS).optional().default('codingAgent'),
    plan: z.array(z.string()).optional().default([]),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string().optional(),
    artifact: codeTaskArtifactSchema.optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const timestamp = nowIso();
      const taskId = context.taskId?.trim() || randomUUID();
      const artifact: CodeTaskArtifact = {
        taskId,
        status: 'planning',
        agentId: context.agentId ?? 'codingAgent',
        userRequest: context.userRequest,
        plan: normalizeStringList(context.plan) ?? [],
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
        approvalsRequested: [],
        diffSummary: '',
        rollbackAvailable: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await db.collection('code_task_artifacts').insertOne(artifact);

      return {
        success: true,
        taskId,
        artifact,
        message: `Artifact zadania utworzony: ${taskId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Nie udalo sie utworzyc artifactu zadania kodowego.',
        error: (error as Error).message,
      };
    }
  },
});

export const updateCodeTaskArtifactTool = createTool({
  id: 'coding_update_artifact',
  description:
    'Aktualizuje artifact zadania kodowego. Przekazane pola zastepuja poprzednie wartosci, wiec podawaj kompletny stan dla aktualizowanych list.',
  inputSchema: z.object({
    taskId: z.string(),
    status: z.enum(CODE_TASK_STATUSES).optional(),
    plan: z.array(z.string()).optional(),
    filesRead: z.array(z.string()).optional(),
    filesChanged: z.array(fileChangeSchema).optional(),
    commandsRun: z.array(commandRunSchema).optional(),
    approvalsRequested: z.array(approvalRequestSchema).optional(),
    diffSummary: z.string().optional(),
    testResult: testResultSchema.optional(),
    diagnosticPlan: diagnosticPlanSchema.optional(),
    reviewVerdict: z.enum(REVIEW_VERDICTS).optional(),
    rollbackAvailable: z.boolean().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    artifact: codeTaskArtifactSchema.optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const set: Record<string, unknown> = { updatedAt: nowIso() };

      if (context.status) set.status = context.status;
      if (context.plan) set.plan = normalizeStringList(context.plan) ?? [];
      if (context.filesRead) set.filesRead = normalizeStringList(context.filesRead) ?? [];
      if (context.filesChanged) set.filesChanged = context.filesChanged;
      if (context.commandsRun) set.commandsRun = context.commandsRun;
      if (context.approvalsRequested) set.approvalsRequested = context.approvalsRequested;
      if (context.diffSummary !== undefined) set.diffSummary = context.diffSummary;
      if (context.testResult) set.testResult = context.testResult;
      if (context.diagnosticPlan) set.diagnosticPlan = context.diagnosticPlan;
      if (context.reviewVerdict) set.reviewVerdict = context.reviewVerdict;
      if (context.rollbackAvailable !== undefined) set.rollbackAvailable = context.rollbackAvailable;

      const result = await db.collection('code_task_artifacts').findOneAndUpdate(
        { taskId: context.taskId },
        { $set: set },
        { returnDocument: 'after' },
      );

      if (!result) {
        return {
          success: false,
          taskId: context.taskId,
          message: `Artifact ${context.taskId} nie istnieje.`,
        };
      }

      return {
        success: true,
        taskId: context.taskId,
        artifact: normalizeArtifact(result),
        message: `Artifact ${context.taskId} zaktualizowany.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        message: 'Nie udalo sie zaktualizowac artifactu zadania kodowego.',
        error: (error as Error).message,
      };
    }
  },
});

export const getCodeTaskArtifactTool = createTool({
  id: 'coding_get_artifact',
  description: 'Pobiera artifact zadania kodowego po taskId. Artefakt jest kompresowany (pomija hashe ledgerowe), zeby chronic okno kontekstu LLM.',
  inputSchema: z.object({
    taskId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    artifact: compressedArtifactSchema.optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return {
          success: false,
          taskId: context.taskId,
          message: `Artifact ${context.taskId} nie istnieje.`,
        };
      }

      const normalized = normalizeArtifact(artifact);
      const compressedArtifact = {
        ...normalized,
        filesChanged: normalized.filesChanged.map((f) => ({
          path: f.path,
          summary: f.summary,
        })),
      };

      return {
        success: true,
        taskId: context.taskId,
        artifact: compressedArtifact,
        message: `Artifact ${context.taskId} pobrany i skompresowany.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        message: 'Nie udalo sie pobrac artifactu zadania kodowego.',
        error: (error as Error).message,
      };
    }
  },
});

export const runTestCommandTool = createTool({
  id: 'coding_run_test',
  description: 'Uruchamia polecenie testowe (np. npm test, npx tsc) w glownym katalogu repozytorium i zapisuje wynik do artifact.testResult oraz commandsRun.',
  inputSchema: z.object({
    taskId: z.string(),
    command: z.string().describe('Komenda do uruchomienia, np. npx tsc --noEmit'),
    summary: z.string().describe('Krotki cel testu, np. Weryfikacja skladni'),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    exitCode: z.number().optional(),
    output: z.string(),
    outputArtifactId: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    originalBytes: z.number().optional(),
    previewBytes: z.number().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: withToolEnvelope({
    toolId: 'coding_run_test',
    category: 'shell',
    risk: 'medium',
    policy: (context, metadata) => ({
      action: 'run_command',
      command: context.command,
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      agentId: metadata.agentId,
      threadId: context.threadId,
      runId: metadata.runId,
      turnId: metadata.turnId,
    }),
    execute: async (context) => {
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return {
          success: false,
          taskId: context.taskId,
          output: '',
          message: `Artifact ${context.taskId} nie istnieje.`,
        };
      }

      // ── Command Allowlist (Phase 0 — Bug #2.5) ──
      const ALLOWED_PREFIXES = [
        'npx tsc', 'npx vitest', 'npx jest', 'npx eslint',
        'npm test', 'npm run test', 'npm run lint', 'npm run build',
        'node --check', 'cat ', 'head ', 'tail ', 'wc ',
      ];
      const command = context.command.trim();
      const isAllowed = ALLOWED_PREFIXES.some((p) => command.startsWith(p));
      if (!isAllowed) {
        return {
          success: false,
          taskId: context.taskId,
          output: '',
          message: `Command not in allowlist. Allowed prefixes: ${ALLOWED_PREFIXES.join(', ')}`,
        };
      }

      let exitCode = 0;
      let output = '';
      let status: 'passed' | 'failed' = 'passed';

      try {
        const workspacePath = await getWorkspacePath(context.taskId);
        const { stdout, stderr } = await execAsync(command, { cwd: workspacePath, timeout: 60000 });
        output = stdout || stderr;
      } catch (err: any) {
        exitCode = err.code ?? 1;
        output = err.stdout || err.stderr || err.message;
        status = 'failed';
      }

      const timestamp = nowIso();
      const compaction = await compactHarnessOutput({
        text: output,
        kind: 'command_log',
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        runId: context.runId,
        turnId: context.turnId,
        toolId: 'coding_run_test',
        metadata: {
          command,
          exitCode,
          status,
          summary: context.summary,
        },
      });

      const newCommandRun = {
        command: context.command,
        approvalRequired: false,
        exitCode,
        summary: context.summary,
        outputPreview: compaction.preview,
        outputArtifactId: compaction.fullTextArtifactId,
        outputTruncated: compaction.truncated,
      };

      const testResult = {
        command: context.command,
        status,
        summary: compaction.preview,
        outputArtifactId: compaction.fullTextArtifactId,
        outputTruncated: compaction.truncated,
        originalBytes: compaction.originalBytes,
        previewBytes: compaction.previewBytes,
      };

      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        {
          $push: { commandsRun: newCommandRun } as any,
          $set: {
            testResult,
            updatedAt: timestamp,
          },
        }
      );
      await recordFileActivity({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        agentId: context.agentId,
        threadId: context.threadId,
        op: 'test',
        summary: `${context.summary}: ${command} (${status})`,
        diffPreview: compaction.preview,
      });

      return {
        success: exitCode === 0,
        taskId: context.taskId,
        exitCode,
        output: compaction.preview,
        outputArtifactId: compaction.fullTextArtifactId,
        outputTruncated: compaction.truncated,
        originalBytes: compaction.originalBytes,
        previewBytes: compaction.previewBytes,
        message: exitCode === 0 ? 'Test zakonczony sukcesem.' : 'Test zwrocil bledy.',
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        output: '',
        message: 'Nie udalo sie wykonac testu.',
        error: (error as Error).message,
      };
    }
    },
  }),
});

export const submitReviewTool = createTool({
  id: 'coding_submit_review',
  description: 'Zapisuje wynik code review w artifact (approve, needs_changes, block). Używane przez CodeReviewAgenta.',
  inputSchema: z.object({
    taskId: z.string(),
    verdict: z.enum(REVIEW_VERDICTS),
    summary: z.string().describe('Uzasadnienie decyzji (wymagane)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return {
          success: false,
          taskId: context.taskId,
          message: `Artifact ${context.taskId} nie istnieje.`,
        };
      }

      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        {
          $set: {
            reviewVerdict: context.verdict,
            updatedAt: nowIso(),
          },
          $push: {
            plan: `[REVIEW] ${context.verdict}: ${context.summary}`,
          } as any,
        }
      );

      return {
        success: true,
        taskId: context.taskId,
        message: `Zapisano review verdict: ${context.verdict}.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        message: 'Nie udalo sie zapisac review.',
        error: (error as Error).message,
      };
    }
  },
});

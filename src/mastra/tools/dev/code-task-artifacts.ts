import { randomUUID } from 'crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';

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
  diffSummary: z.string(),
  testResult: testResultSchema.optional(),
  reviewVerdict: z.enum(REVIEW_VERDICTS).optional(),
  rollbackAvailable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
    diffSummary: String(doc.diffSummary ?? ''),
    testResult: doc.testResult as CodeTaskArtifact['testResult'],
    reviewVerdict: doc.reviewVerdict as CodeTaskArtifact['reviewVerdict'],
    rollbackAvailable: Boolean(doc.rollbackAvailable),
    createdAt: String(doc.createdAt),
    updatedAt: String(doc.updatedAt),
  };
}

export const createCodeTaskArtifactTool = createTool({
  id: 'coding.create_artifact',
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
  id: 'coding.update_artifact',
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
  id: 'coding.get_artifact',
  description: 'Pobiera artifact zadania kodowego po taskId.',
  inputSchema: z.object({
    taskId: z.string(),
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
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return {
          success: false,
          taskId: context.taskId,
          message: `Artifact ${context.taskId} nie istnieje.`,
        };
      }

      return {
        success: true,
        taskId: context.taskId,
        artifact: normalizeArtifact(artifact),
        message: `Artifact ${context.taskId} pobrany.`,
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

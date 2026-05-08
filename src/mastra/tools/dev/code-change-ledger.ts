import { exec } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';

const execAsync = promisify(exec);

const SNAPSHOT_STATUSES = ['open', 'accepted', 'rejected', 'conflict'] as const;
const MISSING_HASH = 'missing';
const MAX_SNAPSHOT_BYTES = 2_000_000;

const snapshotOutputSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  path: z.string(),
  beforeHash: z.string(),
  afterHash: z.string().optional(),
  status: z.enum(SNAPSHOT_STATUSES),
  summary: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type SnapshotDoc = {
  id: string;
  taskId: string;
  path: string;
  beforeHash: string;
  beforeContent: string;
  beforeExists: boolean;
  afterHash?: string;
  afterContent?: string;
  afterExists?: boolean;
  status: (typeof SNAPSHOT_STATUSES)[number];
  summary?: string;
  createdAt: string;
  updatedAt: string;
};

type FileState = {
  exists: boolean;
  content: string;
  hash: string;
  bytes: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRepoPath(inputPath: string): { absolutePath: string; relativePath: string } {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error('Path is required.');

  const relativeCandidate = isAbsolute(trimmed)
    ? relative(AGENTIC_AGENTS_REPO, trimmed)
    : trimmed;

  const relativePath = normalize(relativeCandidate).replace(/\\/g, '/');
  if (
    relativePath === '.' ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Path is outside coding workspace: ${inputPath}`);
  }

  const blockedRoots = ['.git', 'node_modules'];
  if (
    blockedRoots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`)) ||
    relativePath === '.env' ||
    relativePath.startsWith('.env.')
  ) {
    throw new Error(`Path is blocked for coding ledger: ${relativePath}`);
  }

  const absolutePath = resolve(AGENTIC_AGENTS_REPO, relativePath);
  const repoWithSep = AGENTIC_AGENTS_REPO.endsWith(sep) ? AGENTIC_AGENTS_REPO : `${AGENTIC_AGENTS_REPO}${sep}`;
  if (absolutePath !== AGENTIC_AGENTS_REPO && !absolutePath.startsWith(repoWithSep)) {
    throw new Error(`Path is outside coding workspace: ${inputPath}`);
  }

  return { absolutePath, relativePath };
}

async function readFileState(absolutePath: string): Promise<FileState> {
  try {
    const content = await readFile(absolutePath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`File is too large for ledger snapshot (${bytes} bytes).`);
    }
    return {
      exists: true,
      content,
      hash: hashContent(content),
      bytes,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        exists: false,
        content: '',
        hash: MISSING_HASH,
        bytes: 0,
      };
    }
    throw error;
  }
}

function toSnapshotOutput(snapshot: SnapshotDoc) {
  return {
    id: snapshot.id,
    taskId: snapshot.taskId,
    path: snapshot.path,
    beforeHash: snapshot.beforeHash,
    afterHash: snapshot.afterHash,
    status: snapshot.status,
    summary: snapshot.summary,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

async function upsertArtifactFileChange(snapshot: SnapshotDoc, afterHash: string, summary: string): Promise<void> {
  const db = await getDb();
  const artifact = await db.collection('code_task_artifacts').findOne({ taskId: snapshot.taskId });
  if (!artifact) return;

  const filesChanged = Array.isArray(artifact.filesChanged) ? artifact.filesChanged : [];
  const nextFilesChanged = [
    ...filesChanged.filter((entry) => entry?.path !== snapshot.path),
    {
      path: snapshot.path,
      beforeHash: snapshot.beforeHash,
      afterHash,
      summary,
    },
  ];

  await db.collection('code_task_artifacts').updateOne(
    { taskId: snapshot.taskId },
    {
      $set: {
        filesChanged: nextFilesChanged,
        rollbackAvailable: true,
        updatedAt: nowIso(),
      },
    },
  );
}

async function rejectSnapshot(snapshot: SnapshotDoc) {
  const db = await getDb();
  const { absolutePath } = normalizeRepoPath(snapshot.path);
  const current = await readFileState(absolutePath);

  if (!snapshot.afterHash) {
    await db.collection('code_change_snapshots').updateOne(
      { id: snapshot.id },
      { $set: { status: 'rejected', updatedAt: nowIso() } },
    );
    return { path: snapshot.path, status: 'rejected' as const, message: 'Snapshot nie mial afterHash; oznaczono jako rejected.' };
  }

  if (current.hash !== snapshot.afterHash) {
    await db.collection('code_change_snapshots').updateOne(
      { id: snapshot.id },
      { $set: { status: 'conflict', updatedAt: nowIso(), conflictHash: current.hash } },
    );
    return {
      path: snapshot.path,
      status: 'conflict' as const,
      message: 'Plik zmienil sie po pracy agenta; rollback nie nadpisal zmian.',
    };
  }

  if (snapshot.beforeExists) {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, snapshot.beforeContent, 'utf8');
  } else if (current.exists) {
    await unlink(absolutePath);
  }

  await db.collection('code_change_snapshots').updateOne(
    { id: snapshot.id },
    { $set: { status: 'rejected', rejectedAt: nowIso(), updatedAt: nowIso() } },
  );

  return { path: snapshot.path, status: 'rejected' as const, message: 'Cofnieto zmiane agenta.' };
}

async function acceptSnapshot(snapshot: SnapshotDoc) {
  const db = await getDb();
  const { absolutePath } = normalizeRepoPath(snapshot.path);
  const current = await readFileState(absolutePath);

  if (snapshot.afterHash && current.hash !== snapshot.afterHash) {
    await db.collection('code_change_snapshots').updateOne(
      { id: snapshot.id },
      { $set: { status: 'conflict', updatedAt: nowIso(), conflictHash: current.hash } },
    );
    return {
      path: snapshot.path,
      status: 'conflict' as const,
      message: 'Plik zmienil sie po pracy agenta; accept_file nie oznaczyl snapshotu jako accepted.',
    };
  }

  await db.collection('code_change_snapshots').updateOne(
    { id: snapshot.id },
    { $set: { status: 'accepted', acceptedAt: nowIso(), updatedAt: nowIso() } },
  );

  return { path: snapshot.path, status: 'accepted' as const, message: 'Zmiana oznaczona jako zaakceptowana.' };
}

export const recordBeforeChangeTool = createTool({
  id: 'coding.record_before_change',
  description:
    'Zapisuje snapshot pliku przed edycja. Wywolaj przed kazdym write_file, po przeczytaniu pliku przez view.',
  inputSchema: z.object({
    taskId: z.string(),
    path: z.string().describe('Sciezka wzgledem repo lub absolutna sciezka wewnatrz repo.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    snapshot: snapshotOutputSchema.optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const { absolutePath, relativePath } = normalizeRepoPath(context.path);
      const existing = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
      });

      if (existing) {
        return {
          success: true,
          snapshot: toSnapshotOutput(existing),
          message: `Snapshot przed edycja juz istnieje dla ${relativePath}.`,
        };
      }

      const before = await readFileState(absolutePath);
      const timestamp = nowIso();
      const snapshot: SnapshotDoc = {
        id: randomUUID(),
        taskId: context.taskId,
        path: relativePath,
        beforeHash: before.hash,
        beforeContent: before.content,
        beforeExists: before.exists,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await db.collection('code_change_snapshots').insertOne(snapshot);
      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        {
          $addToSet: { filesRead: relativePath },
          $set: { updatedAt: timestamp },
        },
      );

      return {
        success: true,
        snapshot: toSnapshotOutput(snapshot),
        message: `Snapshot przed edycja zapisany dla ${relativePath}.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Nie udalo sie zapisac snapshotu przed edycja.',
        error: (error as Error).message,
      };
    }
  },
});

export const recordAfterChangeTool = createTool({
  id: 'coding.record_after_change',
  description:
    'Zapisuje hash i tresc po edycji pliku oraz aktualizuje artifact filesChanged. Wywolaj po write_file.',
  inputSchema: z.object({
    taskId: z.string(),
    path: z.string(),
    summary: z.string().min(1).describe('Krotki opis zmiany w tym pliku.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    snapshot: snapshotOutputSchema.optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const { absolutePath, relativePath } = normalizeRepoPath(context.path);
      const snapshot = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
      });

      if (!snapshot) {
        return {
          success: false,
          message: `Brak snapshotu before dla ${relativePath}. Najpierw wywolaj coding.record_before_change.`,
        };
      }

      const after = await readFileState(absolutePath);
      const updatedSnapshot: SnapshotDoc = {
        ...snapshot,
        afterHash: after.hash,
        afterContent: after.content,
        afterExists: after.exists,
        summary: context.summary,
        status: 'open',
        updatedAt: nowIso(),
      };

      await db.collection('code_change_snapshots').updateOne(
        { id: snapshot.id },
        {
          $set: {
            afterHash: updatedSnapshot.afterHash,
            afterContent: updatedSnapshot.afterContent,
            afterExists: updatedSnapshot.afterExists,
            summary: updatedSnapshot.summary,
            status: updatedSnapshot.status,
            updatedAt: updatedSnapshot.updatedAt,
          },
        },
      );
      await upsertArtifactFileChange(updatedSnapshot, after.hash, context.summary);

      return {
        success: true,
        snapshot: toSnapshotOutput(updatedSnapshot),
        message: `Snapshot po edycji zapisany dla ${relativePath}.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Nie udalo sie zapisac snapshotu po edycji.',
        error: (error as Error).message,
      };
    }
  },
});

export const rejectFileChangeTool = createTool({
  id: 'coding.reject_file',
  description:
    'Cofa zmiane agenta dla pojedynczego pliku, ale tylko jesli aktualny hash pliku nadal zgadza sie z afterHash snapshotu.',
  inputSchema: z.object({
    taskId: z.string(),
    path: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    path: z.string(),
    status: z.enum(SNAPSHOT_STATUSES).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const { relativePath } = normalizeRepoPath(context.path);
      const snapshot = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
      });

      if (!snapshot) {
        return {
          success: false,
          taskId: context.taskId,
          path: relativePath,
          message: `Snapshot dla ${relativePath} nie istnieje.`,
        };
      }

      const result = await rejectSnapshot(snapshot);
      return {
        success: result.status === 'rejected',
        taskId: context.taskId,
        path: relativePath,
        status: result.status,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        path: context.path,
        message: 'Nie udalo sie cofnac zmiany pliku.',
        error: (error as Error).message,
      };
    }
  },
});

export const rejectAllChangesTool = createTool({
  id: 'coding.reject_all',
  description:
    'Cofa wszystkie otwarte zmiany agenta dla taskId. Kazdy plik jest cofany tylko gdy aktualny hash zgadza sie z afterHash.',
  inputSchema: z.object({
    taskId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    rejected: z.number(),
    conflicts: z.number(),
    results: z.array(z.object({
      path: z.string(),
      status: z.enum(['rejected', 'conflict']),
      message: z.string(),
    })),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const snapshots = await db.collection<SnapshotDoc>('code_change_snapshots')
        .find({ taskId: context.taskId, status: 'open' })
        .sort({ updatedAt: -1 })
        .toArray();

      const results = [];
      for (const snapshot of snapshots) {
        results.push(await rejectSnapshot(snapshot));
      }

      const rejected = results.filter((result) => result.status === 'rejected').length;
      const conflicts = results.filter((result) => result.status === 'conflict').length;

      return {
        success: conflicts === 0,
        taskId: context.taskId,
        rejected,
        conflicts,
        results,
        message: conflicts === 0
          ? `Cofnieto ${rejected} zmian dla ${context.taskId}.`
          : `Cofnieto ${rejected} zmian, ${conflicts} plikow wymaga recznej decyzji.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        rejected: 0,
        conflicts: 0,
        results: [],
        message: 'Nie udalo sie cofnac zmian taska.',
        error: (error as Error).message,
      };
    }
  },
});

export const acceptFileChangeTool = createTool({
  id: 'coding.accept_file',
  description:
    'Oznacza pojedyncza zmiane agenta jako zaakceptowana, jesli aktualny hash nadal zgadza sie z afterHash.',
  inputSchema: z.object({
    taskId: z.string(),
    path: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    path: z.string(),
    status: z.enum(SNAPSHOT_STATUSES).optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const { relativePath } = normalizeRepoPath(context.path);
      const snapshot = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
      });

      if (!snapshot) {
        return {
          success: false,
          taskId: context.taskId,
          path: relativePath,
          message: `Snapshot dla ${relativePath} nie istnieje.`,
        };
      }

      const result = await acceptSnapshot(snapshot);
      return {
        success: result.status === 'accepted',
        taskId: context.taskId,
        path: relativePath,
        status: result.status,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        path: context.path,
        message: 'Nie udalo sie zaakceptowac zmiany pliku.',
        error: (error as Error).message,
      };
    }
  },
});

export const acceptAllChangesTool = createTool({
  id: 'coding.accept_all',
  description:
    'Oznacza wszystkie otwarte zmiany agenta dla taskId jako zaakceptowane, jesli hashe plikow nadal zgadzaja sie z afterHash.',
  inputSchema: z.object({
    taskId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string(),
    accepted: z.number(),
    conflicts: z.number(),
    results: z.array(z.object({
      path: z.string(),
      status: z.enum(['accepted', 'conflict']),
      message: z.string(),
    })),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const snapshots = await db.collection<SnapshotDoc>('code_change_snapshots')
        .find({ taskId: context.taskId, status: 'open' })
        .sort({ updatedAt: -1 })
        .toArray();

      const results = [];
      for (const snapshot of snapshots) {
        results.push(await acceptSnapshot(snapshot));
      }

      const accepted = results.filter((result) => result.status === 'accepted').length;
      const conflicts = results.filter((result) => result.status === 'conflict').length;

      return {
        success: conflicts === 0,
        taskId: context.taskId,
        accepted,
        conflicts,
        results,
        message: conflicts === 0
          ? `Zaakceptowano ${accepted} zmian dla ${context.taskId}.`
          : `Zaakceptowano ${accepted} zmian, ${conflicts} plikow wymaga recznej decyzji.`,
      };
    } catch (error) {
      return {
        success: false,
        taskId: context.taskId,
        accepted: 0,
        conflicts: 0,
        results: [],
        message: 'Nie udalo sie zaakceptowac zmian taska.',
        error: (error as Error).message,
      };
    }
  },
});

export const writeFileTrackedTool = createTool({
  id: 'coding.write_file_tracked',
  description:
    'Zapisuje plik po weryfikacji artifactu i automatycznie dodaje snapshoty before/after dla pelnego trackingu i mozliwosci rollbacku. Glowne narzedzie edycyjne agenta.',
  inputSchema: z.object({
    taskId: z.string(),
    path: z.string().describe('Sciezka wzgledem repo lub absolutna sciezka wewnatrz repo.'),
    content: z.string().describe('Nowa zawartosc pliku.'),
    summary: z.string().min(1).describe('Krotki opis zmiany w tym pliku.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    snapshot: snapshotOutputSchema.optional(),
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
          message: `Artifact dla taska ${context.taskId} nie istnieje. Utworz go najpierw przez coding.create_artifact.`,
        };
      }

      const { absolutePath, relativePath } = normalizeRepoPath(context.path);
      
      const existingSnapshot = await db.collection<SnapshotDoc>('code_change_snapshots').findOne({
        taskId: context.taskId,
        path: relativePath,
        status: 'open',
      });

      const timestamp = nowIso();
      let currentSnapshot: SnapshotDoc;

      if (!existingSnapshot) {
        const before = await readFileState(absolutePath);
        currentSnapshot = {
          id: randomUUID(),
          taskId: context.taskId,
          path: relativePath,
          beforeHash: before.hash,
          beforeContent: before.content,
          beforeExists: before.exists,
          status: 'open',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await db.collection('code_change_snapshots').insertOne(currentSnapshot);
        await db.collection('code_task_artifacts').updateOne(
          { taskId: context.taskId },
          {
            $addToSet: { filesRead: relativePath },
            $set: { updatedAt: timestamp },
          },
        );
      } else {
        const { _id, ...rest } = existingSnapshot as any;
        currentSnapshot = rest;
      }

      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, context.content, 'utf8');

      const after = await readFileState(absolutePath);
      
      const updatedSnapshot: SnapshotDoc = {
        ...currentSnapshot,
        afterHash: after.hash,
        afterContent: after.content,
        afterExists: after.exists,
        summary: context.summary,
        status: 'open',
        updatedAt: nowIso(),
      };

      await db.collection('code_change_snapshots').updateOne(
        { id: currentSnapshot.id },
        {
          $set: {
            afterHash: updatedSnapshot.afterHash,
            afterContent: updatedSnapshot.afterContent,
            afterExists: updatedSnapshot.afterExists,
            summary: updatedSnapshot.summary,
            status: updatedSnapshot.status,
            updatedAt: updatedSnapshot.updatedAt,
          },
        },
      );
      await upsertArtifactFileChange(updatedSnapshot, after.hash, context.summary);

      let checkMessage = '';
      if (relativePath.endsWith('.ts') || relativePath.endsWith('.tsx')) {
        try {
          await execAsync('npx tsc --noEmit', { cwd: AGENTIC_AGENTS_REPO, timeout: 15000 });
          checkMessage = ' (tsc passed)';
        } catch (execError: any) {
          const stdout = execError.stdout || '';
          const lines = stdout.split('\n');
          const fileErrors = lines.filter((l: string) => l.includes(relativePath));
          if (fileErrors.length > 0) {
            checkMessage = `\nUWAGA: Wprowadzono błędy kompilacji w tym pliku:\n${fileErrors.slice(0, 5).join('\n')}`;
          } else {
            checkMessage = `\nUWAGA: Projekt nie kompiluje się, ale błędy tsc mogą dotyczyć innych plików.`;
          }
        }
      }

      return {
        success: true,
        snapshot: toSnapshotOutput(updatedSnapshot),
        message: `Plik ${relativePath} zostal pomyslnie zapisany i zablokowany w ledgerze.${checkMessage}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Nie udalo sie zapisac pliku przez tracked write.',
        error: (error as Error).message,
      };
    }
  },
});

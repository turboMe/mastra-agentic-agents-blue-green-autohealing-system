import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, join } from 'path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';
import { copyFile, stat } from 'fs/promises';

const execAsync = promisify(exec);

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const initWorktreeTool = createTool({
  id: 'coding.init_worktree',
  description: 'Tworzy i przygotowuje izolowane srodowisko git worktree dla podanego zadania (branch task-<taskId>). Skrypt umozliwia testowanie bez uszkodzen w glownym branchu.',
  inputSchema: z.object({
    taskId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    worktreePath: z.string().optional(),
    branchName: z.string().optional(),
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
          message: `Artifact zadania ${context.taskId} nie istnieje.`,
        };
      }

      if (artifact.worktreePath) {
        return {
          success: true,
          worktreePath: artifact.worktreePath,
          branchName: artifact.branchName,
          message: 'Worktree juz istnieje dla tego zadania.',
        };
      }

      const branchName = `task-${context.taskId}`;
      // Katalog `../agentic-agents-worktrees/<taskId>`
      const parentDir = resolve(AGENTIC_AGENTS_REPO, '..');
      const worktreePath = resolve(parentDir, 'agentic-agents-worktrees', context.taskId);

      // Dodaj worktree z wlasnym branch'em
      await execAsync(`git worktree add "${worktreePath}" -b ${branchName}`, {
        cwd: AGENTIC_AGENTS_REPO,
      });

      // Kopiowanie pliku .env jesli istnieje
      const envPath = join(AGENTIC_AGENTS_REPO, '.env');
      if (await fileExists(envPath)) {
        await copyFile(envPath, join(worktreePath, '.env'));
      }

      // Aktualizacja artifactu
      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        {
          $set: {
            worktreePath,
            branchName,
            updatedAt: new Date().toISOString(),
          },
        }
      );

      return {
        success: true,
        worktreePath,
        branchName,
        message: `Utworzono git worktree w ${worktreePath} (branch: ${branchName}). Skopiowano .env.`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'Nie udalo sie utworzyc worktree.',
        error: error.message || String(error),
      };
    }
  },
});

export const removeWorktreeTool = createTool({
  id: 'coding.remove_worktree',
  description: 'Sprzata zasoby git worktree powiazane z podanym zadaniem. Usuwa fizyczny folder i lokalny branch.',
  inputSchema: z.object({
    taskId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact) {
        return { success: false, message: `Artifact ${context.taskId} nie istnieje.` };
      }

      if (artifact.worktreePath) {
        try {
          await execAsync(`git worktree remove --force "${artifact.worktreePath}"`, {
            cwd: AGENTIC_AGENTS_REPO,
          });
        } catch (err: any) {
          // Ignoruj bledy jezeli worktree juz nie istnieje w systemie
          if (!err.message?.includes('not registered') && !err.message?.includes('not found')) {
            throw err;
          }
        }
      }

      if (artifact.branchName) {
        try {
          await execAsync(`git branch -D ${artifact.branchName}`, {
            cwd: AGENTIC_AGENTS_REPO,
          });
        } catch (err: any) {
          // Ignoruj bledy jezeli branch juz nie istnieje
          if (!err.message?.includes('not found')) {
            throw err;
          }
        }
      }

      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        {
          $unset: { worktreePath: '', branchName: '' },
          $set: { updatedAt: new Date().toISOString() },
        }
      );

      return {
        success: true,
        message: `Skutecznie usunieto worktree i branch powiazany z ${context.taskId}.`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'Nie udalo sie usunac worktree.',
        error: error.message || String(error),
      };
    }
  },
});

export const applyWorktreePatchTool = createTool({
  id: 'coding.apply_patch',
  description: 'Finalizuje prace w worktree. Commituje zmiany w izolowanym srodowisku i laczy (git merge) je na zywym glownym srodowisku Mastra. Wymaga approval.',
  inputSchema: z.object({
    taskId: z.string(),
    commitMessage: z.string().describe('Tresc wiadomosci commita dla wygenerowanych zmian.').optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
    stdout: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact || !artifact.worktreePath || !artifact.branchName) {
        return { success: false, message: `Brak aktywnego worktree dla zadania ${context.taskId}.` };
      }

      // 1. Commit zmian w izolowanym worktree
      const msg = context.commitMessage || `agent(patch): Apply automated task ${context.taskId}`;
      try {
        await execAsync(`git add . && git commit -m "${msg}"`, {
          cwd: artifact.worktreePath,
        });
      } catch (commitErr: any) {
        // Jesli nic nie ma do zacommitowania, kontynuujemy z czystym branchem
        if (!commitErr.message?.includes('nothing to commit')) {
          throw commitErr;
        }
      }

      // 2. Merge na glownym repo
      let stdoutMerge = '';
      try {
        const { stdout } = await execAsync(`git merge ${artifact.branchName} --no-edit`, {
          cwd: AGENTIC_AGENTS_REPO,
        });
        stdoutMerge = stdout;
      } catch (mergeErr: any) {
        // W razie konfliktu - rollback w glownym repo
        await execAsync('git merge --abort', { cwd: AGENTIC_AGENTS_REPO }).catch(() => {});
        return {
          success: false,
          message: 'Konflikt podczas proby zlaczenia do glownego srodowiska (Mastra live). Cale scalenie zostalo przerwane (aborted).',
          error: mergeErr.message || String(mergeErr),
        };
      }

      // 3. Opcjonalnie mozna usunac worktree
      await db.collection('code_task_artifacts').updateOne(
        { taskId: context.taskId },
        { $set: { status: 'done', updatedAt: new Date().toISOString() } }
      );

      return {
        success: true,
        message: `Zmiany prawidlowo zmergowane do glownego repozytorium! Środowisko live zaktualizowane.`,
        stdout: stdoutMerge,
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'Nie udalo sie wykonac apply_patch.',
        error: error.message || String(error),
      };
    }
  },
});

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, join, relative } from 'path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { AGENTIC_AGENTS_REPO } from '../../workspaces/code-workspace.js';
import { copyFile, stat, readFile, readdir } from 'fs/promises';

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

// ── Narzędzia do przeglądania worktree (dla codeReviewAgent) ──────────────────

export const listWorktreeFilesTool = createTool({
  id: 'coding.list_worktree_files',
  description: 'Listuje pliki w worktree dla danego zadania. Pozwala reviewerowi zobaczyć jakie pliki zostały dodane lub zmodyfikowane w izolowanym środowisku.',
  inputSchema: z.object({
    taskId: z.string(),
    directory: z.string().optional().default('.').describe('Podkatalog do listowania (domyślnie root worktree).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    files: z.array(z.string()).optional(),
    worktreePath: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact?.worktreePath) {
        return { success: false, message: `Brak aktywnego worktree dla zadania ${context.taskId}.` };
      }

      const targetDir = resolve(artifact.worktreePath, context.directory || '.');

      // Zabezpieczenie: nie pozwol wyjsc poza worktree
      if (!targetDir.startsWith(artifact.worktreePath)) {
        return { success: false, message: 'Sciezka wykracza poza worktree. Odmowa dostepu.' };
      }

      const entries = await readdir(targetDir, { withFileTypes: true });
      const files = entries
        .filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

      return {
        success: true,
        files,
        worktreePath: artifact.worktreePath,
        message: `Znaleziono ${files.length} elementów w ${context.directory || '.'}`,
      };
    } catch (error: any) {
      return { success: false, message: 'Nie udalo sie wylistowac plikow.', error: error.message };
    }
  },
});

export const readWorktreeFileTool = createTool({
  id: 'coding.read_worktree_file',
  description: 'Czyta zawartość pliku z worktree danego zadania. Niezbędne dla reviewera do weryfikacji kodu źródłowego w izolowanym środowisku.',
  inputSchema: z.object({
    taskId: z.string(),
    filePath: z.string().describe('Ścieżka względna do pliku w worktree, np. "scratch/test.js" lub "src/index.ts".'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    content: z.string().optional(),
    filePath: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact?.worktreePath) {
        return { success: false, message: `Brak aktywnego worktree dla zadania ${context.taskId}.` };
      }

      const fullPath = resolve(artifact.worktreePath, context.filePath);

      // Zabezpieczenie: nie pozwol wyjsc poza worktree
      if (!fullPath.startsWith(artifact.worktreePath)) {
        return { success: false, message: 'Sciezka wykracza poza worktree. Odmowa dostepu.' };
      }

      const content = await readFile(fullPath, 'utf-8');

      // Limit rozmiaru (200KB) zeby nie przeciazyc LLM
      if (content.length > 200_000) {
        return {
          success: true,
          content: content.slice(0, 200_000) + '\n... (plik skrocony do 200KB)',
          filePath: context.filePath,
          message: `Plik ${context.filePath} odczytany (skrocony).`,
        };
      }

      return {
        success: true,
        content,
        filePath: context.filePath,
        message: `Plik ${context.filePath} odczytany pomyslnie.`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Nie udalo sie odczytac pliku ${context.filePath}.`,
        error: error.message,
      };
    }
  },
});

export const worktreeDiffTool = createTool({
  id: 'coding.worktree_diff',
  description: 'Zwraca git diff z worktree dla danego zadania. Pokazuje dokładnie jakie zmiany zostały wprowadzone względem głównego brancha.',
  inputSchema: z.object({
    taskId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    diff: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const artifact = await db.collection('code_task_artifacts').findOne({ taskId: context.taskId });

      if (!artifact?.worktreePath) {
        return { success: false, message: `Brak aktywnego worktree dla zadania ${context.taskId}.` };
      }

      // git diff HEAD pokazuje zmiany (staged i unstaged)
      const { stdout: diff } = await execAsync('git diff HEAD', {
        cwd: artifact.worktreePath,
        maxBuffer: 1024 * 1024, // 1MB
      });

      // Jesli brak diffa, moze sa nowe pliki (untracked)
      let fullDiff = diff;
      if (!diff.trim()) {
        const { stdout: statusOutput } = await execAsync('git status --porcelain', {
          cwd: artifact.worktreePath,
        });
        if (statusOutput.trim()) {
          // Pokaz zawartosc nowych plikow
          const newFiles = statusOutput
            .split('\n')
            .filter((l) => l.startsWith('??') || l.startsWith('A '))
            .map((l) => l.replace(/^(\?\?|A\s+)\s*/, '').trim());

          const fileDiffs: string[] = [];
          for (const file of newFiles) {
            try {
              const content = await readFile(resolve(artifact.worktreePath, file), 'utf-8');
              fileDiffs.push(`--- /dev/null\n+++ b/${file}\n${content.split('\n').map((l) => `+${l}`).join('\n')}`);
            } catch {
              // pomiń pliki binarne
            }
          }
          fullDiff = fileDiffs.join('\n\n');
        }
      }

      // Limit 8000 znaków
      const truncated = fullDiff.length > 8000
        ? fullDiff.slice(0, 8000) + '\n... (diff skrocony)'
        : fullDiff;

      return {
        success: true,
        diff: truncated || '(brak zmian)',
        message: truncated ? `Diff pobrany (${truncated.length} znaków).` : 'Brak zmian w worktree.',
      };
    } catch (error: any) {
      return { success: false, message: 'Nie udalo sie pobrac diffa.', error: error.message };
    }
  },
});

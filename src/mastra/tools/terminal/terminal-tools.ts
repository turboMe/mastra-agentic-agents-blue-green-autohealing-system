import { createTool } from '@mastra/core/tools';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { checkCommand, logSafetyEvent } from '../../lib/terminal-safety-guard.js';

const execAsync = promisify(exec);

async function getSandboxDir(): Promise<string> {
  let sandboxPath = '/tmp/sandbox-Jarvis';
  
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentforge');
  try {
    await client.connect();
    const db = client.db();
    const setting = await db.collection('settings').findOne({ key: 'sandbox_path' });
    if (setting?.value) {
      sandboxPath = setting.value;
    }
  } catch (error) {
    console.warn('[TerminalTools] Nie udało się pobrać sandbox_path z MongoDB, używam domyślnego:', sandboxPath);
  } finally {
    await client.close();
  }
  
  return path.resolve(sandboxPath);
}

export const readFileTool = createTool({
  id: 'fs_read_file',
  description: 'Odczytuje zawartość pliku z katalogu piaskownicy (sandbox). Używaj tego narzędzia do sprawdzania kodu, konfiguracji lub innych plików tekstowych.',
  inputSchema: z.object({
    filePath: z.string().describe('Ścieżka do pliku względem katalogu piaskownicy.'),
  }),
  execute: async (context) => {
    try {
      const sandboxDir = await getSandboxDir();
      await fs.mkdir(sandboxDir, { recursive: true });
      
      const safePath = path.resolve(sandboxDir, context.filePath);
      if (!safePath.startsWith(sandboxDir)) {
        return { success: false, error: 'Odmowa dostępu: Próba wyjścia poza katalog sandbox.' };
      }
      
      const content = await fs.readFile(safePath, 'utf8');
      return { success: true, content };
    } catch (err: any) {
      return { success: false, error: `Błąd odczytu pliku: ${err.message}` };
    }
  },
});

export const writeFileTool = createTool({
  id: 'fs_write_file',
  description: 'Zapisuje tekst do pliku w katalogu piaskownicy (sandbox). Jeżeli katalogi po drodze nie istnieją, zostaną utworzone.',
  inputSchema: z.object({
    filePath: z.string().describe('Ścieżka docelowa pliku względem katalogu piaskownicy.'),
    content: z.string().describe('Zawartość do zapisania w pliku.'),
  }),
  execute: async (context) => {
    try {
      const sandboxDir = await getSandboxDir();
      await fs.mkdir(sandboxDir, { recursive: true });
      
      const safePath = path.resolve(sandboxDir, context.filePath);
      if (!safePath.startsWith(sandboxDir)) {
        return { success: false, error: 'Odmowa dostępu: Próba wyjścia poza katalog sandbox.' };
      }
      
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, context.content, 'utf8');
      
      return { success: true, path: context.filePath };
    } catch (err: any) {
      return { success: false, error: `Błąd zapisu pliku: ${err.message}` };
    }
  },
});

export const shellExecuteTool = createTool({
  id: 'shell_execute',
  description: 'Wykonuje komendę powłoki (bash) wewnatrz katalogu piaskownicy. Przydatne do analizy, kompilacji, uruchamiania skryptów itp. Komenda jest weryfikowana przez Terminal Safety Guard przed wykonaniem.',
  inputSchema: z.object({
    command: z.string().describe('Komenda bash do wykonania.'),
  }),
  execute: async (context) => {
    try {
      // ── Safety Guard Check ──
      const verdict = checkCommand(context.command);
      
      if (verdict.action === 'BLOCK') {
        await logSafetyEvent(verdict, 'shell-executor');
        return {
          success: false,
          error: verdict.reason,
          safetyAction: 'BLOCKED',
          ruleId: verdict.ruleId,
        };
      }

      if (verdict.action === 'CONFIRM') {
        await logSafetyEvent(verdict, 'shell-executor');
        // Log warning but allow execution (future: require explicit approval)
        console.warn(`[TerminalSafety] ${verdict.reason} — command: ${context.command.slice(0, 100)}`);
      }

      // ── Execute ──
      const sandboxDir = await getSandboxDir();
      await fs.mkdir(sandboxDir, { recursive: true });
      
      const { stdout, stderr } = await execAsync(context.command, {
        cwd: sandboxDir,
        timeout: 15000,
        maxBuffer: 1024 * 1024 * 2 // 2MB
      });

      return {
        success: true,
        stdout: stdout.trim().slice(0, 4000), // Obcinamy, żeby nie przekroczyć limitów LLM
        stderr: stderr.trim().slice(0, 4000),
        ...(verdict.action === 'CONFIRM' ? { safetyWarning: verdict.reason } : {}),
      };
    } catch (err: any) {
      return { 
        success: false, 
        error: `Błąd wykonania (Code ${err.code}): ${err.stderr || err.message}` 
      };
    }
  },
});


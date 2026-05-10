/**
 * Meta Execute Command (Workaround dla Mastra v1.31/1.32 bug)
 *
 * Zastępuje workspace `execute_command` (LocalSandbox) bo ten emituje
 * `data-workspace-metadata` + `data-sandbox-exit` parts, które w v1.31/1.32
 * łamią persistencję `text` part w `mastra_messages` po multi-step generation.
 * Zob. analiza w czacie 2026-05-10 — text dochodzi w streamie, ale po reload
 * konwersacji w Studio znika, bo persistance gubi text part.
 *
 * Custom tool używa Node `child_process.spawn` bezpośrednio, bez sandbox
 * events → message persistence nie ma race condition.
 *
 * Bezpieczeństwo: idzie przez `checkCommand` (terminal-safety-guard).
 */
import { spawn } from 'child_process';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { checkCommand, logSafetyEvent } from '../../lib/terminal-safety-guard.js';

const MAX_OUTPUT_BYTES = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_CWD = '/projekty/Jarvis-Projects';

function truncateOutput(buf: string): string {
  if (Buffer.byteLength(buf, 'utf8') <= MAX_OUTPUT_BYTES) return buf;
  const head = buf.slice(0, MAX_OUTPUT_BYTES);
  return head + `\n... (truncated, original ${Buffer.byteLength(buf, 'utf8')} bytes)`;
}

export const metaExecuteCommandTool = createTool({
  id: 'execute_command',
  description:
    'Uruchamia polecenie powloki na hoscie (workingDir: /projekty/Jarvis-Projects domyslnie). ' +
    'Sieć dozwolona. Komendy destrukcyjne sa blokowane przez terminal-safety-guard. ' +
    'Zwraca stdout, stderr, exitCode, durationMs.',
  inputSchema: z.object({
    command: z.string().describe('Polecenie powloki (np. "curl -s http://...", "ls -la").'),
    cwd: z.string().optional().describe(`Working directory. Default: ${DEFAULT_CWD}.`),
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional()
      .describe(`Timeout w ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().nullable(),
    durationMs: z.number(),
    command: z.string(),
    blocked: z.string().optional(),
    timedOut: z.boolean().optional(),
  }),
  execute: async (context) => {
    const command = context.command;
    const cwd = context.cwd || DEFAULT_CWD;
    const timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    // Safety check
    const verdict = checkCommand(command);
    if (verdict.action === 'BLOCK') {
      void logSafetyEvent(verdict, 'meta-agent').catch(() => {});
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: Date.now() - startedAt,
        command,
        blocked: `[SAFETY BLOCK] ${verdict.reason || 'destructive command pattern detected'}`,
      };
    }
    if (verdict.action === 'CONFIRM') {
      void logSafetyEvent(verdict, 'meta-agent').catch(() => {});
      // Continue with warning logged
    }

    return await new Promise((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let timedOut = false;

      const child = spawn('bash', ['-lc', command], {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (Buffer.byteLength(stdoutBuf, 'utf8') < MAX_OUTPUT_BYTES * 2) {
          stdoutBuf += chunk.toString();
        }
      });
      child.stderr.on('data', (chunk) => {
        if (Buffer.byteLength(stderrBuf, 'utf8') < MAX_OUTPUT_BYTES * 2) {
          stderrBuf += chunk.toString();
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          success: !timedOut && code === 0,
          stdout: truncateOutput(stdoutBuf),
          stderr: truncateOutput(stderrBuf),
          exitCode: code,
          durationMs: Date.now() - startedAt,
          command,
          ...(timedOut ? { timedOut: true } : {}),
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          stdout: truncateOutput(stdoutBuf),
          stderr: truncateOutput(stderrBuf + '\nspawn error: ' + err.message),
          exitCode: null,
          durationMs: Date.now() - startedAt,
          command,
        });
      });
    });
  },
});

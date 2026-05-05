/**
 * Loads prompts from src/mastra/prompts/<path>.md
 * Usage: await loadPrompt('meta/base') → string
 * Prompts can be edited without rebuild (just hot-reload the file).
 */
import { readFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve prompts root - handles both:
 * - Source: src/mastra/lib/../prompts  (__dirname = src/mastra/lib)
 * - Bundled: .mastra/output/  (__dirname = .mastra/output → ../../src/mastra/prompts)
 */
function resolvePromptsRoot(): string {
  // Candidate paths in priority order
  const candidates = [
    resolve(__dirname, '../prompts'),                    // source: src/mastra/lib/../prompts
    resolve(__dirname, '../../src/mastra/prompts'),      // bundle: .mastra/output/../../src/mastra/prompts
    join(process.cwd(), 'src', 'mastra', 'prompts'),    // fallback from CWD
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

const PROMPTS_ROOT = resolvePromptsRoot();

export async function loadPrompt(relativePath: string): Promise<string> {
  const filePath = resolve(PROMPTS_ROOT, relativePath.endsWith('.md') ? relativePath : `${relativePath}.md`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Prompt not found: ${filePath}. Create it in src/mastra/prompts/${relativePath}.md`);
  }
}

/**
 * Combine multiple prompts into one system prompt.
 * Each section is separated by a double newline.
 */
export async function combinePrompts(...paths: string[]): Promise<string> {
  const parts = await Promise.all(paths.map(loadPrompt));
  return parts.join('\n\n');
}

/**
 * Inject dynamic context into a prompt string.
 * Appends a ## Context section with JSON.
 */
export function withContext(prompt: string, context: Record<string, unknown>): string {
  return `${prompt}\n\n## Aktywny kontekst\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;
}

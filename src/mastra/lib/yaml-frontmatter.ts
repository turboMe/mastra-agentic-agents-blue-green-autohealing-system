/**
 * YAML Frontmatter Parser (Phase 2.2)
 *
 * Parses YAML frontmatter from markdown files (--- delimited).
 * Also supports updating frontmatter fields in-place.
 *
 * Compatible with agentskills.io SKILL.md standard and existing
 * _skills/*.md files.
 */

import { readFile, writeFile } from 'fs/promises';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { metadata, body } where metadata is a flat key-value object
 * and body is the markdown content without frontmatter.
 */
export function parseFrontmatter(content: string): {
  metadata: Record<string, any>;
  body: string;
} {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = content.slice(match[0].length).replace(/^\r?\n/, '');

  // Simple YAML parser (handles flat key-value, arrays, and nested objects)
  const metadata: Record<string, any> = {};
  const lines = yamlBlock.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();

    if (value === '') {
      // Empty value
      metadata[key] = '';
      continue;
    }

    // Boolean
    if (value === 'true') { metadata[key] = true; continue; }
    if (value === 'false') { metadata[key] = false; continue; }
    if (value === 'null') { metadata[key] = null; continue; }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      metadata[key] = Number(value);
      continue;
    }

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      metadata[key] = inner.split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      continue;
    }

    // Quoted string
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      metadata[key] = value.slice(1, -1);
      continue;
    }

    // Plain string
    metadata[key] = value;
  }

  return { metadata, body };
}

/**
 * Update specific fields in YAML frontmatter of a file.
 * Preserves existing fields and adds new ones.
 */
export async function updateFrontmatter(
  filePath: string,
  updates: Record<string, any>,
): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    // No frontmatter — create one
    const yamlLines = Object.entries(updates)
      .map(([k, v]) => `${k}: ${serializeValue(v)}`)
      .join('\n');
    const newContent = `---\n${yamlLines}\n---\n${content}`;
    await writeFile(filePath, newContent, 'utf-8');
    return;
  }

  const { metadata } = parseFrontmatter(content);
  const merged = { ...metadata, ...updates };

  const yamlLines = Object.entries(merged)
    .map(([k, v]) => `${k}: ${serializeValue(v)}`)
    .join('\n');

  const body = content.slice(match[0].length);
  const newContent = `---\n${yamlLines}\n---${body}`;
  await writeFile(filePath, newContent, 'utf-8');
}

function serializeValue(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

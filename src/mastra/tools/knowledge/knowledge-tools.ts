/**
 * NotebookLM knowledge tools.
 * Replaces: MCP notebooklm (disabled due to Selenium issues).
 * Ported from: apps/workers/src/agents/meta-agent/tool-definitions.ts (jarvis).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getNlmClient } from './notebooklm-client.js';

// Known notebooks (from jarvis knowledge-plan.md)
export const KNOWN_NOTEBOOKS = [
  'rynek', 'rhd', 'konkurencja', 'founder', 'leady', 'project', 'docs',
  'chef_master', 'chef_flavor', 'chef_texture', 'chef_classic', 'chef_modern',
  'chef_europe', 'chef_asia', 'chef_americas_mena', 'chef_psychology',
] as const;

// ────────────────────────────────────────────────────────────────────────────
// knowledge.query – query existing notebook
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeQueryTool = createTool({
  id: 'knowledge_query',
  description: `Zadaje pytanie do istniejącego notebooka NotebookLM (RAG po dokumentach).
Dostępne notebooki: ${KNOWN_NOTEBOOKS.join(', ')}.
Używaj do: pytań o rynek HoReCa (rynek), regulacje RHD (rhd), konkurencję (konkurencja), wiedzę chefa (chef_*).`,
  inputSchema: z.object({
    notebook: z.string().describe(`Nazwa notebooka. Znane: ${KNOWN_NOTEBOOKS.join(', ')}`),
    question: z.string().describe('Pytanie do notebooka (naturalny język)'),
    timeout: z.number().optional().default(120).describe('Timeout w sekundach (domyślnie 120)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    answer: z.string().optional(),
    citations: z.array(z.string()).optional(),
    notebook: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const result = await nlm.query({
        notebook: context.notebook,
        question: context.question,
        timeout: context.timeout,
      });
      return { success: true, answer: result.answer, citations: result.citations, notebook: context.notebook };
    } catch (error) {
      return { success: false, notebook: context.notebook, error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// knowledge.query_multi – cross-notebook query
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeQueryMultiTool = createTool({
  id: 'knowledge_query_multi',
  description: 'Pyta kilka notebooków jednocześnie i zwraca odpowiedzi z każdego. Używaj gdy pytanie dotyczy wielu domen (np. rynek + konkurencja).',
  inputSchema: z.object({
    notebooks: z.array(z.string()).min(1).max(4).describe('Lista nazw notebooków (max 4)'),
    question: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.record(z.string(), z.object({
      answer: z.string().optional(),
      citations: z.array(z.string()).optional(),
      error: z.string().optional(),
    })),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const results = await nlm.crossNotebookQuery({ notebooks: context.notebooks, question: context.question });
      return { success: true, results: results as any };
    } catch (error) {
      return { success: false, results: {}, error: (error as Error).message } as any;
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// knowledge.list_notebooks
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeListNotebooksTool = createTool({
  id: 'knowledge_list_notebooks',
  description: 'Zwraca listę wszystkich dostępnych notebooków NotebookLM (ID + tytuł).',
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    notebooks: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const nlm = getNlmClient();
      const notebooks = await nlm.listNotebooks();
      return { success: true, notebooks };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// knowledge.create_temp_notebook (for enrichment workflows)
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeCreateNotebookTool = createTool({
  id: 'knowledge_create_notebook',
  description: 'Tworzy tymczasowy notebook NotebookLM do jednorazowego researchu (np. dla jednej firmy w producer-hunt). Użyj knowledge.add_source aby dodać URL, potem knowledge.query, na końcu knowledge.delete_notebook.',
  inputSchema: z.object({
    title: z.string().describe('Tytuł notebooka (np. "Temp: Acme Farm research")'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    notebookId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const notebookId = await nlm.createNotebook(context.title);
      return { success: true, notebookId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const knowledgeAddSourceTool = createTool({
  id: 'knowledge_add_source',
  description: 'Dodaje źródło (URL lub tekst) do notebooka NotebookLM.',
  inputSchema: z.object({
    notebook: z.string().describe('ID lub tytuł notebooka'),
    sourceType: z.enum(['url', 'text']),
    url: z.string().optional(),
    text: z.string().optional(),
    title: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    sourceId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const result = await nlm.addSource({
        notebook: context.notebook,
        sourceType: context.sourceType,
        url: context.url,
        text: context.text,
        title: context.title,
      });
      return { success: true, sourceId: result.sourceId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

export const knowledgeDeleteNotebookTool = createTool({
  id: 'knowledge_delete_notebook',
  description: 'Usuwa notebook NotebookLM (używaj do czyszczenia tymczasowych notebooków po researchu).',
  inputSchema: z.object({
    notebookId: z.string().describe('ID notebooka do usunięcia'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      await nlm.deleteNotebook(context.notebookId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// knowledge.research_start
// ────────────────────────────────────────────────────────────────────────────
export const knowledgeResearchStartTool = createTool({
  id: 'knowledge_research_start',
  description: 'Rozpoczyna pogłębiony research (Deep Research) w NotebookLM na dany temat lub dla konkretnej firmy.',
  inputSchema: z.object({
    query: z.string().describe('Temat researchu (np. "Deep research about Acme Farm products and history")'),
    notebookId: z.string().optional().describe('Opcjonalny ID istniejącego notebooka'),
    mode: z.enum(['fast', 'deep']).optional().default('deep').describe('Tryb researchu (domyślnie deep)'),
    autoImport: z.boolean().optional().default(true).describe('Czy automatycznie zaimportować znalezione źródła do notebooka'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      const result = await nlm.researchStart({
        query: context.query,
        notebookId: context.notebookId,
        mode: context.mode,
        autoImport: context.autoImport,
      });
      return { success: true, taskId: result.taskId, output: result.output };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  },
});

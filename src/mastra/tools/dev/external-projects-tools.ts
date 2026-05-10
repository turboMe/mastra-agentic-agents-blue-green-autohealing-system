import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getOrCreateExternalProject } from '../../workspaces/external-project-workspace.js';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

// Import subagent directly for delegation
import { codeReviewAgent } from '../../agents/code-review-agent.js';
import { anthropicCacheOptions } from '../../lib/anthropic-cache.js';

export const createExternalProjectTool = createTool({
  id: 'createExternalProject',
  description: 'Tworzy lub pobiera zewnetrzny projekt do bezpiecznego kodowania poza agentem',
  inputSchema: z.object({
    projectName: z.string().describe('Nazwa projektu (tylko alfanumeryczne i myslniki)'),
    template: z.enum(['empty', 'typescript', 'node']).optional().describe('Szablon startowy'),
  }),
  execute: async (context) => {
    try {
      const project = getOrCreateExternalProject(context.projectName, { template: context.template });
      return { success: true, path: project.path };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});

export const writeExternalProjectFileTool = createTool({
  id: 'writeExternalProjectFile',
  description: 'Zapisuje plik w zewnetrznym projekcie',
  inputSchema: z.object({
    projectName: z.string().describe('Nazwa projektu'),
    filePath: z.string().describe('Wzgledna sciezka pliku w projekcie'),
    content: z.string().describe('Zawartosc pliku'),
  }),
  execute: async (context) => {
    try {
      const project = getOrCreateExternalProject(context.projectName);
      const fullPath = resolve(project.path, context.filePath);
      
      if (!fullPath.startsWith(project.path)) {
        throw new Error('Path escape attempt blocked');
      }
      
      writeFileSync(fullPath, context.content, 'utf-8');
      return { success: true, message: `Zapisano ${context.filePath}` };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});

export const runExternalProjectCommandTool = createTool({
  id: 'runExternalProjectCommand',
  description: 'Uruchamia polecenie terminalowe w zewnetrznym projekcie',
  inputSchema: z.object({
    projectName: z.string().describe('Nazwa projektu'),
    command: z.string().describe('Polecenie powloki (np. npm run build)'),
  }),
  execute: async (context) => {
    try {
      const project = getOrCreateExternalProject(context.projectName);
      const output = execSync(context.command, { cwd: project.path, encoding: 'utf-8', timeout: 30000 });
      return { success: true, output };
    } catch (e: any) {
      return { success: false, error: e.message, output: e.stdout?.toString() || e.stderr?.toString() };
    }
  },
});

export const delegateToReviewerTool = createTool({
  id: 'delegateToReviewer',
  description: 'Przekazuje kod lub architekturę sub-agentowi (Code Review Agent) do weryfikacji',
  inputSchema: z.object({
    context: z.string().describe('Opis tego co zrobiles i kod do sprawdzenia'),
  }),
  execute: async (context) => {
    try {
      const response = await codeReviewAgent.generate(
        `Jako sub-agent recenzujacy, sprawdz ponizszy kontekst i kod. Daj krotka, ekspercka odpowiedz czy jest on bezpieczny i prawidlowy:\n\n${context.context}`,
        anthropicCacheOptions(),
      );
      
      return { success: true, review: response.text };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});

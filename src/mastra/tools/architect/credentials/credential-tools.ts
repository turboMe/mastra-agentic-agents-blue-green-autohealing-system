import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { resolveCredentials } from './credential-resolver.js';

export const resolveCredentialsTool = createTool({
  id: 'architect.resolve_credentials',
  description: 'Mapuje wymagane serwisy na referencje credentiali w n8n.',
  inputSchema: z.object({
    required: z.array(
      z.object({
        service: z.string(),
        required: z.boolean(),
        credentialName: z.string().optional(),
      }),
    ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    credentials: z.record(
      z.string(),
      z.object({
        service: z.string(),
        n8nCredentialType: z.string(),
        id: z.string(),
        name: z.string(),
      }),
    ),
    missing: z.array(
      z.object({
        service: z.string(),
        required: z.boolean(),
        setupHint: z.string(),
      }),
    ),
  }),
  execute: async (context) => {
    return resolveCredentials(context.required);
  },
});

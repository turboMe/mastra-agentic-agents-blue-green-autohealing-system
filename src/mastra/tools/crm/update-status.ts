/**
 * CRM: Update lead status (real MongoDB).
 * Appends to history[], updates lastInteractionAt.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { CRM_STATUSES } from './search-leads.js';

export const updateStatusTool = createTool({
  id: 'crm_update_status',
  description: 'Zmienia status leada w CRM i zapisuje powód w historii interakcji. Używaj gdy lead odpowie, przejdzie do kolejnego etapu, lub zrezygnuje.',
  inputSchema: z.object({
    idOrEmail: z.string().describe('ID leada (UUID) lub email kontaktu'),
    status: z.enum(CRM_STATUSES).describe('Nowy status CRM'),
    reason: z.string().describe('Powód zmiany statusu (pojawi się w historii)'),
    agentId: z.string().optional().default('meta-agent'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const db = await getDb();
      const col = db.collection('leads');
      const now = new Date();

      const isEmail = context.idOrEmail.includes('@');
      const filter = isEmail ? { email: context.idOrEmail } : { id: context.idOrEmail };

      const historyEntry = {
        timestamp: now,
        action: 'status_change',
        description: `Status zmieniony na "${context.status}". Powód: ${context.reason}`,
        agentId: context.agentId ?? 'meta-agent',
      };

      const result = await col.updateOne(filter, {
        $set: { status: context.status, updatedAt: now, lastInteractionAt: now },
        $push: { history: historyEntry as any },
      });

      if (result.matchedCount === 0) {
        return { success: false, message: `Lead nie znaleziony: ${context.idOrEmail}` };
      }

      return { success: true, message: `Status zmieniony na "${context.status}" dla ${context.idOrEmail}` };
    } catch (error) {
      return { success: false, message: 'Błąd aktualizacji statusu', error: (error as Error).message };
    }
  },
});

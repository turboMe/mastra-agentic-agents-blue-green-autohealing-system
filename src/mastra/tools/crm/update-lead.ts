/**
 * CRM: Update lead fields (real MongoDB).
 * Updates arbitrary lead fields, validates status, appends to history.
 * Throws if lead does not exist.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getDb } from '../../lib/mongo.js';
import { CRM_STATUSES } from './search-leads.js';

export const updateLeadTool = createTool({
  id: 'crm.update_lead',
  description:
    'Aktualizuje dowolne pola istniejącego leada (companyName, segment, region, contactPerson, phone, status, metadata, etc.) i dodaje wpis do historii. Używaj gdy zdobędziesz nowe info o leadzie poza zwykłą zmianą statusu.',
  inputSchema: z.object({
    idOrEmail: z.string().describe('ID leada (UUID) lub email kontaktu'),
    updates: z
      .record(z.string(), z.unknown())
      .describe('Pola do nadpisania, np. { contactPerson: "Anna", region: "Mazowsze" }'),
    reason: z.string().describe('Uzasadnienie zmiany (trafia do historii)'),
    agentId: z.string().optional().default('meta-agent'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    updatedFields: z.array(z.string()),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const { idOrEmail, updates, reason, agentId } = context;
      if (Object.keys(updates).length === 0) {
        return { success: false, updatedFields: [], message: 'Pusty zestaw aktualizacji.' };
      }
      if (typeof updates.status === 'string' && !CRM_STATUSES.includes(updates.status as any)) {
        return {
          success: false,
          updatedFields: [],
          message: `Niedozwolony status: ${updates.status}. Dopuszczalne: ${CRM_STATUSES.join(', ')}`,
        };
      }
      const db = await getDb();
      const col = db.collection('leads');
      const filter = idOrEmail.includes('@') ? { email: idOrEmail } : { id: idOrEmail };
      const existing = await col.findOne(filter);
      if (!existing) {
        return { success: false, updatedFields: [], message: `Lead nie znaleziony: ${idOrEmail}` };
      }

      const now = new Date();
      const historyEntry = {
        timestamp: now,
        action: typeof updates.status === 'string' ? 'status_changed' : 'lead_updated',
        description: reason,
        agentId: agentId ?? 'meta-agent',
      };

      await col.updateOne(filter, {
        $set: { ...updates, updatedAt: now, lastInteractionAt: now },
        $push: { history: historyEntry as any },
      });

      return {
        success: true,
        updatedFields: Object.keys(updates),
        message: `Zaktualizowano ${Object.keys(updates).length} pól dla ${idOrEmail}`,
      };
    } catch (error) {
      return {
        success: false,
        updatedFields: [],
        message: 'Błąd aktualizacji leada',
        error: (error as Error).message,
      };
    }
  },
});

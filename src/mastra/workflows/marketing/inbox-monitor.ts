/**
 * Workflow: inbox-monitor
 * Skanuje Gmail w poszukiwaniu odpowiedzi od leadów, kategoryzuje je
 * i generuje draft odpowiedzi lub aktualizuje CRM.
 * Etap 6 – marketing workflows.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { marketingAgent } from '../../agents/marketing-agent';
import { getDb } from '../../lib/mongo';

/* ─────────────────────────────────────────────
   Step 1: scan Gmail for lead replies
───────────────────────────────────────────── */
const scanInboxStep = createStep({
  id: 'scan-inbox',
  description: 'Przeszukuje Gmail w poszukiwaniu odpowiedzi od leadów z ostatnich N godzin.',
  inputSchema: z.object({
    hoursBack: z.number().default(24),
    maxResults: z.number().default(20),
  }),
  outputSchema: z.object({
    emails: z.array(z.object({
      messageId: z.string(),
      from: z.string(),
      subject: z.string(),
      snippet: z.string(),
      receivedAt: z.string(),
    })),
    emailCount: z.number(),
    knownLeadEmails: z.array(z.string()),
  }),
  execute: async (context) => {
    const db = await getDb();
    const cutoff = new Date(Date.now() - context.inputData.hoursBack * 3600 * 1000);

    // Get all known lead emails for filtering
    const leads = await db.collection('leads')
      .find({ email: { $exists: true, $ne: null } })
      .project({ email: 1 })
      .toArray();
    const knownLeadEmails = leads.map((l) => (l.email as string).toLowerCase());

    // Fetch recent emails via Gmail search stored results (from gmail sync collection)
    const recentEmails = await db.collection('gmail_messages')
      .find({
        receivedAt: { $gte: cutoff.toISOString() },
        direction: 'inbound',
      })
      .sort({ receivedAt: -1 })
      .limit(context.inputData.maxResults)
      .toArray();

    const emails = recentEmails.map((m) => ({
      messageId: String(m.messageId ?? m._id),
      from: String(m.from ?? ''),
      subject: String(m.subject ?? '(bez tematu)'),
      snippet: String((m.snippet ?? m.body ?? '').slice(0, 300)),
      receivedAt: String(m.receivedAt ?? ''),
    }));

    return { emails, emailCount: emails.length, knownLeadEmails };
  },
});

/* ─────────────────────────────────────────────
   Step 2: categorize & generate draft responses
───────────────────────────────────────────── */
const categorizeAndDraftStep = createStep({
  id: 'categorize-and-draft',
  description: 'Marketing Agent kategoryzuje emaile i generuje draft odpowiedzi.',
  inputSchema: z.object({
    emails: z.array(z.object({
      messageId: z.string(),
      from: z.string(),
      subject: z.string(),
      snippet: z.string(),
      receivedAt: z.string(),
    })),
    emailCount: z.number(),
    knownLeadEmails: z.array(z.string()),
  }),
  outputSchema: z.object({
    categorized: z.array(z.object({
      messageId: z.string(),
      from: z.string(),
      subject: z.string(),
      category: z.enum(['positive', 'negative', 'question', 'meeting_request', 'other']),
      isKnownLead: z.boolean(),
      draftReply: z.string().optional(),
      action: z.string(),
    })),
    summary: z.string(),
  }),
  execute: async (context) => {
    if (context.inputData.emailCount === 0) {
      return {
        categorized: [],
        summary: 'Brak nowych wiadomości do przeanalizowania.',
      };
    }

    const knownSet = new Set(context.inputData.knownLeadEmails);

    const prompt = `Jesteś Agentem Marketingu GastroBridge. Przeanalizuj ${context.inputData.emailCount} wiadomości emailowych.

## Wiadomości do kategoryzacji:
${context.inputData.emails.map((e, i) => `
### Email ${i + 1}
- ID: ${e.messageId}
- Od: ${e.from}
- Temat: ${e.subject}
- Treść (fragment): ${e.snippet}
- Otrzymano: ${e.receivedAt}
- Znany lead: ${knownSet.has(e.from.toLowerCase()) ? 'TAK' : 'NIE'}
`).join('\n')}

## Zadanie
Dla KAŻDEGO emaila:
1. Przypisz kategorię: positive (zainteresowanie/tak), negative (odmowa), question (pytanie), meeting_request (prośba o spotkanie), other
2. Jeśli positive/question/meeting_request — napisz krótki (2-3 zdania) draft odpowiedzi po polsku
3. Określ recommended action (np. "zaplanuj demo", "zaktualizuj status w CRM", "odpisz na pytanie", "oznacz jako odrzucony")

Zwróć JSON:
{
  "results": [
    {
      "messageId": "...",
      "from": "...",
      "subject": "...",
      "category": "...",
      "isKnownLead": true/false,
      "draftReply": "...",
      "action": "..."
    }
  ],
  "summary": "Krótkie podsumowanie (1-2 zdania)"
}`;

    const result = await marketingAgent.generate(prompt);
    let categorized: typeof context.inputData.emails extends Array<infer _> ? {
      messageId: string;
      from: string;
      subject: string;
      category: 'positive' | 'negative' | 'question' | 'meeting_request' | 'other';
      isKnownLead: boolean;
      draftReply?: string;
      action: string;
    }[] : never[] = [];
    let summary = '';

    try {
      const match = result.text.match(/```(?:json)?\n?([\s\S]*?)```/);
      const jsonStr = match ? match[1] : result.text;
      const parsed = JSON.parse(jsonStr);
      categorized = (parsed.results ?? []).map((r: any) => ({
        messageId: r.messageId ?? '',
        from: r.from ?? '',
        subject: r.subject ?? '',
        category: r.category ?? 'other',
        isKnownLead: knownSet.has((r.from ?? '').toLowerCase()),
        draftReply: r.draftReply,
        action: r.action ?? '',
      }));
      summary = parsed.summary ?? '';
    } catch {
      summary = 'Nie udało się sparsować odpowiedzi agenta.';
    }

    return { categorized, summary };
  },
});

/* ─────────────────────────────────────────────
   Step 3: update CRM + save drafts
───────────────────────────────────────────── */
const applyActionsStep = createStep({
  id: 'apply-actions',
  description: 'Aktualizuje CRM i zapisuje draft odpowiedzi w bazie.',
  inputSchema: z.object({
    categorized: z.array(z.object({
      messageId: z.string(),
      from: z.string(),
      subject: z.string(),
      category: z.enum(['positive', 'negative', 'question', 'meeting_request', 'other']),
      isKnownLead: z.boolean(),
      draftReply: z.string().optional(),
      action: z.string(),
    })),
    summary: z.string(),
  }),
  outputSchema: z.object({
    updatedLeads: z.number(),
    savedDrafts: z.number(),
    summary: z.string(),
  }),
  execute: async (context) => {
    const db = await getDb();
    const now = new Date();
    let updatedLeads = 0;
    let savedDrafts = 0;

    for (const item of context.inputData.categorized) {
      // Update CRM for known leads
      if (item.isKnownLead) {
        const newStatus =
          item.category === 'positive' || item.category === 'meeting_request'
            ? 'odpowiedział'
            : item.category === 'negative'
            ? 'odrzucony'
            : undefined;

        const update: Record<string, any> = {
          lastInteractionAt: now,
          updatedAt: now,
        };
        if (newStatus) update.status = newStatus;

        await db.collection('leads').updateOne(
          { email: { $regex: new RegExp(item.from.split('@')[1] ?? item.from, 'i') } },
          {
            $set: update,
            $push: {
              history: {
                timestamp: now,
                action: 'email_received',
                description: `Otrzymano odpowiedź (${item.category}): ${item.subject}`,
                agentId: 'inbox-monitor-workflow',
              } as any,
            },
          },
        );
        updatedLeads++;
      }

      // Save draft reply if generated
      if (item.draftReply) {
        await db.collection('inbox_drafts').insertOne({
          messageId: item.messageId,
          from: item.from,
          subject: item.subject,
          category: item.category,
          draftReply: item.draftReply,
          action: item.action,
          createdAt: now,
          status: 'pending',
        });
        savedDrafts++;
      }
    }

    // Store summary in shared memory
    if (context.inputData.summary) {
      await db.collection('shared_memory').updateOne(
        { key: `inbox-monitor-${now.toISOString().split('T')[0]}` },
        {
          $set: {
            key: `inbox-monitor-${now.toISOString().split('T')[0]}`,
            type: 'signal',
            sourceAgent: 'inbox-monitor-workflow',
            content: context.inputData.summary,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
          },
        },
        { upsert: true },
      );
    }

    return { updatedLeads, savedDrafts, summary: context.inputData.summary };
  },
});

/* ─────────────────────────────────────────────
   Workflow definition
───────────────────────────────────────────── */
export const inboxMonitorWorkflow = createWorkflow({
  id: 'inbox-monitor',
  description: 'Skanuje Gmail, kategoryzuje odpowiedzi od leadów i generuje draft replik.',
  inputSchema: z.object({
    hoursBack: z.number().default(24),
    maxResults: z.number().default(20),
  }),
  outputSchema: z.object({
    updatedLeads: z.number(),
    savedDrafts: z.number(),
    summary: z.string(),
  }),
})
  .then(scanInboxStep)
  .then(categorizeAndDraftStep)
  .then(applyActionsStep);

inboxMonitorWorkflow.commit();

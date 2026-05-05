import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GmailService } from './gmail.js';
import { CalendarService } from './calendar.js';

// --- GMAIL TOOLS ---

export const gmailSearchTool = createTool({
  id: 'gmail.search',
  description: 'Wyszukuje wątki w skrzynce Gmail po słowach kluczowych lub mailu.',
  inputSchema: z.object({
    query: z.string().describe('Zapytanie wyszukiwania (np. "is:unread", "from:klient@email.com")'),
    maxResults: z.number().optional().default(10),
  }),
  execute: async (context) => {
    try {
      const gmail = await GmailService.create();
      const threads = await gmail.searchThreads(context.query, context.maxResults);
      return { success: true, count: threads.length, threads };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const gmailCreateDraftTool = createTool({
  id: 'gmail.create_draft',
  description: 'Tworzy nowy szkic (draft) wiadomości email w Gmailu.',
  inputSchema: z.object({
    to: z.string().describe('Adres email odbiorcy'),
    subject: z.string().describe('Temat wiadomości'),
    body: z.string().describe('Treść wiadomości (plain text)'),
  }),
  execute: async (context) => {
    try {
      const gmail = await GmailService.create();
      const draftId = await gmail.createDraft({
        to: context.to,
        subject: context.subject,
        body: context.body,
      });
      return { success: true, draftId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const gmailUpdateDraftTool = createTool({
  id: 'gmail.update_draft',
  description: 'Aktualizuje istniejący szkic (draft) w Gmailu po jego ID.',
  inputSchema: z.object({
    draftId: z.string().describe('ID draftu do aktualizacji'),
    to: z.string().optional().describe('Nowy adres email odbiorcy (opcjonalnie)'),
    subject: z.string().optional().describe('Nowy temat (opcjonalnie)'),
    body: z.string().optional().describe('Nowa treść (opcjonalnie)'),
  }),
  execute: async (context) => {
    try {
      const gmail = await GmailService.create();
      const current = await gmail.getDraft(context.draftId);
      const to = context.to ?? current.to;
      const subject = context.subject ?? current.subject;
      const body = context.body ?? current.body ?? '';

      if (!to) return { success: false, error: `Draft ma puste pole 'to'.` };
      if (!subject) return { success: false, error: `Draft ma puste pole 'subject'.` };

      const draftId = await gmail.updateDraft({
        draftId: context.draftId,
        to,
        subject,
        body,
        threadId: current.threadId ?? undefined,
      });

      return { success: true, draftId, previousDraftId: context.draftId, to, subject };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const gmailListDraftsTool = createTool({
  id: 'gmail.list_drafts',
  description: 'Pobiera listę aktualnych szkiców (draftów) w Gmailu.',
  inputSchema: z.object({
    maxResults: z.number().optional().default(20),
  }),
  execute: async (context) => {
    try {
      const gmail = await GmailService.create();
      const drafts = await gmail.listDrafts(context.maxResults);
      return { success: true, count: drafts.length, drafts };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const gmailGetDraftTool = createTool({
  id: 'gmail.get_draft',
  description: 'Pobiera szczegóły i treść konkretnego draftu w Gmailu.',
  inputSchema: z.object({
    draftId: z.string().describe('ID draftu w Gmailu'),
  }),
  execute: async (context) => {
    try {
      const gmail = await GmailService.create();
      const draft = await gmail.getDraft(context.draftId);
      return { success: true, draft };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const gmailSendDraftTool = createTool({
  id: 'gmail.send_draft',
  description: 'Wysyła istniejący szkic (draft) w Gmailu.',
  inputSchema: z.object({
    draftId: z.string().describe('ID draftu w Gmailu do wysłania'),
  }),
  execute: async (context) => {
    try {
      const gmail = await GmailService.create();
      await gmail.sendDraft(context.draftId);
      return { success: true, draftId: context.draftId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const gmailDeleteDraftTool = createTool({
  id: 'gmail.delete_draft',
  description: 'Usuwa szkic (draft) z Gmaila.',
  inputSchema: z.object({
    draftId: z.string().describe('ID draftu w Gmailu do usunięcia'),
  }),
  execute: async (context) => {
    try {
      const gmail = await GmailService.create();
      await gmail.deleteDraft(context.draftId);
      return { success: true, draftId: context.draftId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// --- CALENDAR TOOLS ---

export const calendarCreateEventTool = createTool({
  id: 'calendar.create_event',
  description: 'Tworzy wydarzenie w kalendarzu.',
  inputSchema: z.object({
    title: z.string().describe('Tytuł wydarzenia'),
    description: z.string().describe('Opis wydarzenia'),
    scheduledFor: z.string().describe('Data i czas rozpoczęcia (format ISO, np. 2026-05-10T12:00:00Z)'),
    durationMinutes: z.number().optional().default(60).describe('Czas trwania w minutach'),
  }),
  execute: async (context) => {
    try {
      const calendar = await CalendarService.create();
      const eventId = await calendar.createEvent({
        title: context.title,
        description: context.description,
        start: new Date(context.scheduledFor),
      });
      return { success: true, eventId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const calendarFindEventTool = createTool({
  id: 'calendar.find_event',
  description: 'Wyszukuje wydarzenie w kalendarzu po słowach kluczowych (np. nazwie firmy, kontaktu).',
  inputSchema: z.object({
    query: z.string().describe('Słowa kluczowe do wyszukania (np. "Acme spotkanie", "Patryk")'),
    timeMin: z.string().optional().describe('Szukaj od daty (ISO string). Domyślnie: teraz'),
  }),
  execute: async (context) => {
    try {
      const calendar = await CalendarService.create();
      const events = await calendar.findEventByQuery(
        context.query,
        context.timeMin ? new Date(context.timeMin) : new Date(),
      );
      return {
        success: true,
        count: events.length,
        events: events.map(e => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime ?? e.start?.date,
          end: e.end?.dateTime ?? e.end?.date,
          description: e.description,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const calendarUpdateEventTool = createTool({
  id: 'calendar.update_event',
  description: 'Aktualizuje istniejące wydarzenie w kalendarzu (tytuł, czas, opis).',
  inputSchema: z.object({
    eventId: z.string().describe('ID wydarzenia z Google Calendar'),
    title: z.string().optional().describe('Nowy tytuł'),
    description: z.string().optional().describe('Nowy opis'),
    start: z.string().optional().describe('Nowy czas rozpoczęcia (ISO)'),
    end: z.string().optional().describe('Nowy czas zakończenia (ISO)'),
  }),
  execute: async (context) => {
    try {
      const calendar = await CalendarService.create();
      await calendar.updateEvent(context.eventId, {
        title: context.title,
        description: context.description,
        start: context.start ? new Date(context.start) : undefined,
        end: context.end ? new Date(context.end) : undefined,
      });
      return { success: true, eventId: context.eventId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const calendarDeleteEventTool = createTool({
  id: 'calendar.delete_event',
  description: 'Usuwa wydarzenie z kalendarza po ID.',
  inputSchema: z.object({
    eventId: z.string().describe('ID wydarzenia do usunięcia'),
  }),
  execute: async (context) => {
    try {
      const calendar = await CalendarService.create();
      await calendar.deleteEvent(context.eventId);
      return { success: true, eventId: context.eventId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

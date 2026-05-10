import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GmailService } from './gmail.js';
import { CalendarService } from './calendar.js';
import { SheetsService } from './sheets.js';
import { SlidesService } from './slides.js';

// --- GMAIL TOOLS ---

export const gmailSearchTool = createTool({
  id: 'gmail_search',
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
  id: 'gmail_create_draft',
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
  id: 'gmail_update_draft',
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
  id: 'gmail_list_drafts',
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
  id: 'gmail_get_draft',
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
  id: 'gmail_send_draft',
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
  id: 'gmail_delete_draft',
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
  id: 'calendar_create_event',
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
  id: 'calendar_find_event',
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
  id: 'calendar_update_event',
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
  id: 'calendar_delete_event',
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

// --- GOOGLE SHEETS TOOLS (Faza 6.1) ---

export const sheetsCreateSpreadsheetTool = createTool({
  id: 'sheets_create_spreadsheet',
  description: 'Tworzy nowy arkusz Google Sheets. Zwraca spreadsheetId + URL. Używaj do raportów, eksportu danych CRM, list dystrybucyjnych.',
  inputSchema: z.object({
    title: z.string().describe('Tytuł nowego arkusza'),
    sheetTitles: z.array(z.string()).optional().describe('Nazwy zakładek (domyślnie ["Sheet1"])'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    spreadsheetId: z.string().optional(),
    url: z.string().optional(),
    sheets: z.array(z.object({ sheetId: z.number(), title: z.string() })).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.createSpreadsheet(context.title, context.sheetTitles);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const sheetsReadRangeTool = createTool({
  id: 'sheets_read_range',
  description: 'Odczytuje zakres komórek z arkusza Google Sheets. Range w formacie A1: "Sheet1!A1:C10" lub "A1:C10" dla pierwszej zakładki.',
  inputSchema: z.object({
    spreadsheetId: z.string().describe('ID arkusza (z URL: /spreadsheets/d/{ID}/edit)'),
    range: z.string().describe('Zakres A1, np. "Arkusz1!A1:D100"'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    range: z.string().optional(),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional(),
    rowCount: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.readRange(context.spreadsheetId, context.range);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const sheetsWriteRangeTool = createTool({
  id: 'sheets_write_range',
  description: 'NADPISUJE zakres w arkuszu Google Sheets podanymi wartościami. Wymaga confirm: true. Aby dodać dane bez nadpisywania użyj sheets.append_rows.',
  inputSchema: z.object({
    spreadsheetId: z.string(),
    range: z.string().describe('Zakres A1 do nadpisania, np. "Arkusz1!A1:C5"'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('Tablica wierszy (każdy wiersz = tablica wartości)'),
    confirm: z.boolean().describe('Musi być true — nadpisanie wymaga zgody użytkownika'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    blocked: z.boolean().optional(),
    updatedRange: z.string().optional(),
    updatedRows: z.number().optional(),
    updatedCells: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    if (!context.confirm) {
      return {
        success: false,
        blocked: true,
        error: 'BLOCKED: confirm musi być true. Poinformuj użytkownika co i gdzie zostanie nadpisane, uzyskaj zgodę i wywołaj ponownie z confirm: true.',
      };
    }
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.writeRange(context.spreadsheetId, context.range, context.values);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const sheetsAppendRowsTool = createTool({
  id: 'sheets_append_rows',
  description: 'Dodaje wiersze na końcu istniejącej tabeli w arkuszu Google Sheets. Bezpieczne — nie nadpisuje istniejących danych.',
  inputSchema: z.object({
    spreadsheetId: z.string(),
    range: z.string().describe('Zakres źródłowy tabeli, np. "Arkusz1!A1" — Sheets sam znajdzie pierwszy pusty wiersz'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    updatedRange: z.string().optional(),
    appendedRows: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.appendRows(context.spreadsheetId, context.range, context.values);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const sheetsGetMetadataTool = createTool({
  id: 'sheets_get_metadata',
  description: 'Pobiera metadane arkusza Google Sheets: tytuł, listę zakładek, wymiary. Użyj przed odczytem żeby wiedzieć jakie zakładki są dostępne.',
  inputSchema: z.object({
    spreadsheetId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    spreadsheetId: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    sheets: z.array(z.object({
      sheetId: z.number(),
      title: z.string(),
      rowCount: z.number(),
      columnCount: z.number(),
    })).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.getMetadata(context.spreadsheetId);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// --- GOOGLE SLIDES TOOLS (Faza 6.1) ---

export const slidesCreatePresentationTool = createTool({
  id: 'slides_create_presentation',
  description: 'Tworzy nową prezentację Google Slides (pustą, z 1 slajdem startowym). Używaj do raportów, deck-ów dla klientów, prezentacji wewnętrznych.',
  inputSchema: z.object({
    title: z.string().describe('Tytuł prezentacji'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    presentationId: z.string().optional(),
    url: z.string().optional(),
    slideIds: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.createPresentation(context.title);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesGetMetadataTool = createTool({
  id: 'slides_get_metadata',
  description: 'Pobiera metadane prezentacji Google Slides: tytuł, listę slajdów z ID i indeksami.',
  inputSchema: z.object({
    presentationId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    presentationId: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    slideCount: z.number().optional(),
    slides: z.array(z.object({
      slideId: z.string(),
      index: z.number(),
      layoutType: z.string().optional(),
    })).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.getMetadata(context.presentationId);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesAddSlideTool = createTool({
  id: 'slides_add_slide',
  description: 'Dodaje nowy slajd do prezentacji Google Slides. Layouts: TITLE, TITLE_AND_BODY (default), TITLE_AND_TWO_COLUMNS, BLANK, SECTION_HEADER.',
  inputSchema: z.object({
    presentationId: z.string(),
    layout: z.enum(['TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS', 'BLANK', 'SECTION_HEADER']).optional().default('TITLE_AND_BODY'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    slideId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.addSlide(context.presentationId, { layout: context.layout });
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesReplaceTextTool = createTool({
  id: 'slides_replace_text',
  description: 'Zamienia placeholdery na wartości w całej prezentacji. Konwencja: użyj {{KLUCZ}} w slajdach (lub w skopiowanym templatce), potem przekaż mapę zamian. Idealne do generowania slajdów z danych.',
  inputSchema: z.object({
    presentationId: z.string(),
    replacements: z.record(z.string(), z.string()).describe('Mapa "find → replace", np. {"{{NAZWA_KLIENTA}}": "Acme Corp"}'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    replacementsCount: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.replaceAllText(context.presentationId, context.replacements);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesAddTextBoxTool = createTool({
  id: 'slides_add_text_box',
  description: 'Dodaje pole tekstowe do konkretnego slajdu. Pozycja w EMU (1 cal = 914400). Używaj dla custom contentu który nie pasuje do placeholderów layoutu.',
  inputSchema: z.object({
    presentationId: z.string(),
    slideId: z.string().describe('ID slajdu (z slides.get_metadata)'),
    text: z.string(),
    fontSize: z.number().optional().describe('Rozmiar w punktach (np. 14, 18, 24)'),
    bold: z.boolean().optional().default(false),
    x: z.number().optional().describe('Pozycja X w EMU (default 100000)'),
    y: z.number().optional().describe('Pozycja Y w EMU (default 100000)'),
    width: z.number().optional().describe('Szerokość w EMU (default ~6.5 cala)'),
    height: z.number().optional().describe('Wysokość w EMU (default ~1 cal)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    textBoxId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.addTextBox(
        context.presentationId,
        context.slideId,
        context.text,
        {
          fontSize: context.fontSize,
          bold: context.bold,
          x: context.x,
          y: context.y,
          width: context.width,
          height: context.height,
        },
      );
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesDeleteSlideTool = createTool({
  id: 'slides_delete_slide',
  description: 'Usuwa slajd z prezentacji. Wymaga confirm: true. Operacja nieodwracalna.',
  inputSchema: z.object({
    presentationId: z.string(),
    slideId: z.string(),
    confirm: z.boolean().describe('Musi być true'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    blocked: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    if (!context.confirm) {
      return {
        success: false,
        blocked: true,
        error: 'BLOCKED: confirm musi być true. Slajd zostanie usunięty bez możliwości cofnięcia.',
      };
    }
    try {
      const slides = await SlidesService.create();
      await slides.deleteSlide(context.presentationId, context.slideId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

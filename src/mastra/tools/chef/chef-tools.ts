import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ChefService } from './chef-service';
import { getNlmClient } from '../knowledge/notebooklm-client';

const CHEF_NOTEBOOK_IDS = [
  'chef_master', 'chef_flavor', 'chef_texture', 'chef_classic',
  'chef_modern', 'chef_europe', 'chef_asia', 'chef_americas_mena', 'chef_psychology',
] as const;
type ChefNotebookId = typeof CHEF_NOTEBOOK_IDS[number];

// ─── Existing tools (updated) ─────────────────────────────────────────────────

export const chefStartProjectTool = createTool({
  id: 'chef.start_project',
  description: 'Rozpoczyna nowy projekt menu dla restauracji lub eventu. Tworzy ankietę z brakującymi polami i pytaniami kontekstowymi.',
  inputSchema: z.object({
    name: z.string().describe('Nazwa projektu (np. "Menu letnie 2025 – Bistro Roma")'),
    establishmentType: z.string().describe('Typ lokalu: bistro, fine_dining, upscale, casual, food_truck, hotel, event_catering'),
    eventType: z.string().optional().describe('Typ eventu (jeśli event_catering): wedding, corporate, cocktail, gala, seasonal, private'),
    cuisineTypes: z.array(z.string()).optional().describe('Lista typów kuchni, np. ["włoska", "śródziemnomorska"]'),
    serviceFormat: z.string().optional().describe('Format serwisu: a_la_carte, tasting_menu, prix_fixe, buffet, family_style, stations, canape'),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const result = await chef.createProject({
        name: context.name,
        establishmentType: context.establishmentType,
        eventType: context.eventType,
        cuisineTypes: context.cuisineTypes,
        serviceFormat: context.serviceFormat,
      });
      return {
        success: true,
        project: result.project,
        missingFields: result.missingFields,
        contextualQuestions: result.contextualQuestions,
        defaultSuggestions: result.defaultSuggestions,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefUpdateProfileTool = createTool({
  id: 'chef.update_profile',
  description: 'Aktualizuje odpowiedzi na pytania ankietowe w projekcie menu. Zwraca brakujące pola i czy profil jest kompletny.',
  inputSchema: z.object({
    projectId: z.string().describe('UUID projektu'),
    updates: z.record(z.string(), z.any()).describe('Pola profilu do aktualizacji (np. { guestProfile: { count: 120 }, seasonality: { targetSeason: "summer" } })'),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const result = await chef.updateProfile(context.projectId, context.updates);
      return {
        success: true,
        project: result.project,
        isComplete: result.isComplete,
        missingFields: result.missingFields,
        contextualQuestions: result.contextualQuestions,
        defaultSuggestions: result.defaultSuggestions,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefGenerateMenuTool = createTool({
  id: 'chef.generate_menu',
  description: 'Pobiera profil projektu i kontekst z notebooków kulinarnych, aby agent mógł wygenerować menu. Po wywołaniu tego narzędzia MUSISZ samodzielnie skomponować JSON menu i zapisać przez chef.save_menu.',
  inputSchema: z.object({
    projectId: z.string().describe('UUID projektu (musi mieć kompletny profil)'),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const project = await chef.getProject(context.projectId);
      if (!project) return { success: false, error: `Projekt ${context.projectId} nie znaleziony.` };

      if (project.status === 'questionnaire') {
        return { success: false, error: 'Profil projektu nie jest kompletny. Użyj chef.update_profile aby uzupełnić brakujące pola.' };
      }

      await chef.updateProjectStatus(context.projectId, 'generating');

      // Determine relevant notebooks
      const profile = project.profile;
      const notebooksToQuery: ChefNotebookId[] = ['chef_master'];

      if (profile.cuisineTypes.some(c => /(francus|włos|italia|śródziem|mediterranean|europe)/i.test(c))) {
        notebooksToQuery.push('chef_europe');
      } else if (profile.cuisineTypes.some(c => /(japon|chin|kore|taj|azj|india|asian|japanese|chinese|thai)/i.test(c))) {
        notebooksToQuery.push('chef_asia');
      } else if (profile.cuisineTypes.some(c => /(meksyk|mexican|bliski|middle.east|nordic|nordyc)/i.test(c))) {
        notebooksToQuery.push('chef_americas_mena');
      }
      notebooksToQuery.push('chef_flavor');

      const cacheKey = `generate:${notebooksToQuery.sort().join(',')}:${profile.establishmentType}:${profile.cuisineTypes.sort().join(',')}:${profile.seasonality?.targetSeason ?? 'all'}`;
      const cached = await chef.getCachedNlmResult(cacheKey);

      let notebookContext = '';
      if (cached) {
        notebookContext = cached;
      } else {
        try {
          const nlm = getNlmClient();
          const menuQuestion = `Zaprojektuj ${profile.serviceFormat ?? 'a_la_carte'} menu dla ${profile.establishmentType}. ` +
            `Kuchnia: ${profile.cuisineTypes.join(', ') || 'międzynarodowa'}. ` +
            `Gości: ${profile.guestProfile?.count ?? 'nieokreślono'}. ` +
            `Sezon: ${profile.seasonality?.targetSeason ?? 'cały rok'}. ` +
            (profile.identity?.narrative ? `Narracja: ${profile.identity.narrative}. ` : '') +
            `Podaj strukturę sekcji, sugerowane dania z opisami, pairingi i balans tekstur.`;

          const results = await nlm.crossNotebookQuery({
            notebooks: notebooksToQuery.slice(0, 3),
            question: menuQuestion,
          });

          for (const [nb, res] of Object.entries(results) as Array<[string, any]>) {
            if (!res.error) notebookContext += `\n\n### Wiedza z ${nb}:\n${res.answer}`;
          }
          if (notebookContext) await chef.setCachedNlmResult(cacheKey, notebookContext);
        } catch {
          notebookContext = '(Notatniki kulinarne niedostępne — generuj na podstawie wiedzy wbudowanej.)';
        }
      }

      const nextVersion = await chef.getLatestMenuVersion(context.projectId) + 1;

      return {
        success: true,
        projectId: context.projectId,
        nextVersion,
        profile,
        notebookContext,
        instruction: [
          'Na podstawie profilu i kontekstu z notebooków wygeneruj kompletne menu jako JSON:',
          '{ title, narrative, sections: [{ name, dishes: [{ name, description, ingredients[], techniques[], flavorProfile?, textures[], temperature, allergens[], dietaryTags[], pairingWine? }] }] }',
          'Zasady: min. 3 tekstury per danie, progresja lekkie→ciężkie, max 2 te same techniki, równoległe ścieżki dietetyczne.',
          `Następnie wywołaj chef.save_menu z projectId="${context.projectId}", version=${nextVersion}, title, narrative, sections.`,
        ].join(' '),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefDraftRecipeTool = createTool({
  id: 'chef.draft_recipe',
  description: 'Generuje i zapisuje kartę technologiczną (BOM, mise en place, serwis) dla dania z projektu.',
  inputSchema: z.object({
    projectId: z.string(),
    dishName: z.string(),
    yield: z.object({ amount: z.number(), unit: z.string() }),
    components: z.array(z.object({
      componentName: z.string(),
      ingredients: z.array(z.object({ name: z.string(), quantity: z.number(), unit: z.string(), notes: z.string().optional() })),
      miseEnPlace: z.array(z.object({ order: z.number(), instruction: z.string(), temperature: z.string().optional(), time: z.string().optional() })),
    })),
    serviceSteps: z.array(z.object({ order: z.number(), instruction: z.string(), temperature: z.string().optional(), time: z.string().optional() })),
    allergens: z.array(z.string()).optional(),
    equipmentNeeded: z.array(z.string()).optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const recipe = await chef.saveRecipe({
        projectId: context.projectId,
        dishName: context.dishName,
        yield: context.yield,
        components: context.components,
        serviceSteps: context.serviceSteps,
        allergens: context.allergens,
        equipmentNeeded: context.equipmentNeeded,
      });
      return { success: true, recipeId: recipe.id, dishName: recipe.dishName, message: 'Receptura zapisana w formacie BOM.' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// ─── New tools ────────────────────────────────────────────────────────────────

export const chefGetProjectTool = createTool({
  id: 'chef.get_project',
  description: 'Pobiera szczegóły projektu menu wraz z aktualnym profilem i statusem.',
  inputSchema: z.object({
    projectId: z.string().describe('UUID projektu menu'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    project: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const project = await chef.getProject(context.projectId);
      if (!project) return { success: false, error: `Projekt ${context.projectId} nie znaleziony.` };
      return { success: true, project };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefListProjectsTool = createTool({
  id: 'chef.list_projects',
  description: 'Zwraca listę projektów menu z ich statusami. Filtruj po status opcjonalnie.',
  inputSchema: z.object({
    status: z.string().optional().describe('Filter po statusie: questionnaire, review, generating, approved, archived'),
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    projects: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const projects = await chef.listProjects(
        context.status ? { status: context.status } : undefined,
        context.limit ?? 10,
      );
      return {
        success: true,
        count: projects.length,
        projects: projects.map(p => ({
          id: p.id,
          name: p.name,
          status: p.status,
          establishmentType: p.profile.establishmentType,
          cuisineTypes: p.profile.cuisineTypes,
          currentMenuId: p.currentMenuId,
          updatedAt: p.updatedAt,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSaveMenuTool = createTool({
  id: 'chef.save_menu',
  description: 'Zapisuje menu (ręcznie skomponowane lub po iteracji) do projektu. Automatycznie numeruje wersje.',
  inputSchema: z.object({
    projectId: z.string().describe('UUID projektu'),
    title: z.string().describe('Tytuł menu'),
    narrative: z.string().optional().default('').describe('2-3 zdaniowy opis narracyjny menu'),
    version: z.number().int().optional().describe('Numer wersji (pomijaj – zostanie automatycznie obliczony)'),
    sections: z.array(z.object({
      name: z.string(),
      dishes: z.array(z.object({
        name: z.string(),
        description: z.string(),
        ingredients: z.array(z.string()).optional().default([]),
        techniques: z.array(z.string()).optional().default([]),
        flavorProfile: z.object({
          dominant: z.array(z.string()).optional(),
          bridges: z.array(z.string()).optional(),
          family: z.string().optional(),
        }).optional(),
        textures: z.array(z.string()).optional(),
        temperature: z.string().optional(),
        allergens: z.array(z.string()).optional().default([]),
        dietaryTags: z.array(z.string()).optional().default([]),
        pairingWine: z.string().optional(),
        pairingNonAlcoholic: z.string().optional(),
        plateDescription: z.string().optional(),
      })).min(1),
    })).min(1),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    menuId: z.string().optional(),
    version: z.number().optional(),
    title: z.string().optional(),
    totalDishes: z.number().optional(),
    sections: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const project = await chef.getProject(context.projectId);
      if (!project) return { success: false, error: `Projekt ${context.projectId} nie znaleziony.` };

      const version = context.version ?? (await chef.getLatestMenuVersion(context.projectId) + 1);
      const allDishes = context.sections.flatMap((s: any) => s.dishes ?? []);

      const techniqueDistribution: Record<string, number> = {};
      const allergenMatrix: Record<string, string[]> = {};
      for (const dish of allDishes) {
        for (const t of dish.techniques ?? []) techniqueDistribution[t] = (techniqueDistribution[t] ?? 0) + 1;
        if (dish.allergens?.length) allergenMatrix[dish.name] = dish.allergens;
      }

      const menu = await chef.saveMenu({
        projectId: context.projectId,
        version,
        title: context.title,
        narrative: context.narrative ?? '',
        sections: context.sections as any,
        metadata: {
          totalDishes: allDishes.length,
          techniqueDistribution,
          allergenMatrix,
          temperatureArc: allDishes.map((d: any) => (d as any).temperature ?? 'warm'),
        },
      });

      return {
        success: true,
        menuId: menu.id,
        version: menu.version,
        title: menu.title,
        totalDishes: allDishes.length,
        sections: menu.sections.map(s => ({ name: s.name, dishCount: s.dishes.length })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefGetMenuTool = createTool({
  id: 'chef.get_menu',
  description: 'Pobiera pełne menu z sekcjami i daniami. Wymaga menuId (UUID), nie myl z projectId.',
  inputSchema: z.object({
    menuId: z.string().describe('UUID menu'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    menu: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const menu = await chef.getMenu(context.menuId);
      if (!menu) return { success: false, error: `Menu ${context.menuId} nie znalezione.` };
      return { success: true, menu };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefIterateMenuTool = createTool({
  id: 'chef.iterate_menu',
  description: 'Zwraca istniejące menu + profil projektu, aby agent mógł zastosować feedback użytkownika i zapisać nową wersję przez chef.save_menu. Po wywołaniu tego narzędzia MUSISZ: (1) zastosować feedback do sekcji, (2) wywołać chef.save_menu z projectId i zaktualizowanymi sections.',
  inputSchema: z.object({
    menuId: z.string().describe('UUID menu do modyfikacji'),
    feedback: z.string().describe('Opis zmian, np. "zamień rybę na pozycji 5 na coś mięsnego" lub "dodaj więcej opcji wegańskich"'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    menuId: z.string().optional(),
    projectId: z.string().optional(),
    currentSections: z.any().optional(),
    profile: z.any().optional(),
    feedback: z.string().optional(),
    instruction: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const menu = await chef.getMenu(context.menuId);
      if (!menu) return { success: false, error: `Menu ${context.menuId} nie znalezione.` };

      const project = await chef.getProject(menu.projectId);
      if (!project) return { success: false, error: `Projekt ${menu.projectId} nie znaleziony.` };

      const nextVersion = await chef.getLatestMenuVersion(menu.projectId) + 1;

      return {
        success: true,
        menuId: menu.id,
        projectId: menu.projectId,
        currentSections: menu.sections,
        profile: project.profile,
        feedback: context.feedback,
        instruction: `Zastosuj poniższy feedback do sekcji menu: "${context.feedback}". Zachowaj: progresję (lekkie→ciężkie), min. 3 tekstury per danie, max 2 te same techniki, równoległe ścieżki dietetyczne. Następnie wywołaj chef.save_menu z projectId="${menu.projectId}", version=${nextVersion}, title="${menu.title}", narrative i zaktualizowanymi sections.`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefGetRecipeTool = createTool({
  id: 'chef.get_recipe',
  description: 'Pobiera wcześniej zapisaną recepturę (BOM) dla dania w projekcie.',
  inputSchema: z.object({
    projectId: z.string().describe('UUID projektu'),
    dishName: z.string().describe('Nazwa dania (case-sensitive)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    recipe: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const recipe = await chef.getRecipe(context.projectId, context.dishName);
      if (!recipe) return { success: false, error: `Brak receptury dla "${context.dishName}". Użyj chef.draft_recipe aby ją wygenerować.` };
      return { success: true, recipe };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefQueryKnowledgeTool = createTool({
  id: 'chef.query_knowledge',
  description: `Odpytuje kulinarne bazy wiedzy NotebookLM. Dostępne notatniki: chef_master (ogólna wiedza szefa), chef_flavor (pairing smaków), chef_texture (tekstury), chef_classic (kuchnia klasyczna), chef_modern (nowoczesne techniki), chef_europe (kuchnia europejska), chef_asia (kuchnia azjatycka), chef_americas_mena (Ameryki/Bliski Wschód), chef_psychology (psychologia gościa).`,
  inputSchema: z.object({
    question: z.string().describe('Pytanie kulinarne (w języku naturalnym)'),
    notebooks: z.array(z.enum(CHEF_NOTEBOOK_IDS)).min(1).max(3).describe('Lista notebooków do odpytania (max 3)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.record(z.string(), z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const nlm = getNlmClient();
      if (context.notebooks.length === 1) {
        const result = await nlm.query({ notebook: context.notebooks[0], question: context.question, timeout: 120 });
        return {
          success: true,
          results: {
            [context.notebooks[0]]: { answer: result.answer, citations: result.citations.slice(0, 5) },
          },
        };
      }
      const results = await nlm.crossNotebookQuery({ notebooks: context.notebooks, question: context.question });
      return {
        success: true,
        results: Object.fromEntries(
          Object.entries(results).map(([nb, res]: [string, any]) => [
            nb,
            res.error ? { error: res.error } : { answer: res.answer, citations: (res.citations ?? []).slice(0, 3) },
          ]),
        ),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSuggestPairingTool = createTool({
  id: 'chef.suggest_pairing',
  description: 'Sugeruje pairingi smakowe dla podanych składników używając wiedzy z chef_flavor i chef_master. Zwraca komplementarne i kontrastowe pairingi oraz bridge ingredients.',
  inputSchema: z.object({
    ingredients: z.array(z.string().min(1)).min(1).max(10).describe('Lista składników do sparowania'),
    cuisineContext: z.string().optional().describe('Kontekst kuchni, np. "japońska", "fusion azjatycko-skandynawski"'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    ingredients: z.array(z.string()).optional(),
    results: z.record(z.string(), z.any()).optional(),
    fallback: z.boolean().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const nlm = getNlmClient();
      const sortedIngredients = [...context.ingredients].sort().join(',');
      const cacheKey = `pairing:${sortedIngredients}:${context.cuisineContext ?? ''}`;
      const cached = await chef.getCachedNlmResult(cacheKey);

      if (cached) {
        try {
          return { success: true, ingredients: context.ingredients, results: JSON.parse(cached) };
        } catch { /* fallthrough */ }
      }

      const question = `Zasugeruj pairingi smakowe dla składników: ${context.ingredients.join(', ')}.` +
        (context.cuisineContext ? ` Kontekst kuchni: ${context.cuisineContext}.` : '') +
        ` Podaj: 1) pairingi komplementarne (ta sama rodzina smakowa), 2) pairingi kontrastowe, 3) bridge ingredients łączące niepowiązane elementy. Uzasadnij przez rodzinę związków aromatycznych.`;

      const results = await nlm.crossNotebookQuery({ notebooks: ['chef_flavor', 'chef_master'], question });
      const mapped = Object.fromEntries(
        Object.entries(results).map(([nb, res]: [string, any]) => [
          nb,
          res.error ? { error: res.error } : { answer: res.answer, citations: (res.citations ?? []).slice(0, 3) },
        ]),
      );
      await chef.setCachedNlmResult(cacheKey, JSON.stringify(mapped));
      return { success: true, ingredients: context.ingredients, results: mapped };
    } catch (err: any) {
      return { success: true, ingredients: context.ingredients, fallback: true, note: `Notatniki niedostępne: ${err.message}. Użyj wiedzy wbudowanej o flavor pairing.` };
    }
  },
});

export const chefCheckSeasonalTool = createTool({
  id: 'chef.check_seasonal',
  description: 'Sprawdza sezonowość składników dla podanego regionu i miesiąca. Pomiń ingredients (lub podaj []) aby uzyskać ogólny przegląd sezonowy.',
  inputSchema: z.object({
    ingredients: z.array(z.string()).optional().default([]).describe('Składniki do sprawdzenia (puste = ogólny przegląd regionu)'),
    region: z.string().optional().default('central_europe').describe('Region, np. "central_europe", "Mazowsze", "Francja"'),
    month: z.number().int().min(1).max(12).optional().describe('Miesiąc 1-12 (domyślnie: bieżący)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    region: z.string().optional(),
    month: z.number().optional(),
    monthName: z.string().optional(),
    answer: z.string().optional(),
    citations: z.array(z.string()).optional(),
    fallback: z.boolean().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const monthNames = ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];
    const month = context.month ?? new Date().getMonth() + 1;
    const ingredients: string[] = Array.isArray(context.ingredients) ? context.ingredients : [];
    const region = context.region ?? 'central_europe';

    const question = ingredients.length > 0
      ? `Sprawdź sezonowość składników: ${ingredients.join(', ')} w regionie ${region} w miesiącu ${monthNames[month - 1]}. Dla każdego podaj: czy w sezonie, jeśli nie — zasugeruj sezonowy zamiennik.`
      : `Podaj ogólny przegląd sezonowości w regionie ${region} w miesiącu ${monthNames[month - 1]}: kluczowe składniki w sezonie (warzywa, owoce, ryby, mięso, zioła) oraz składniki których należy unikać.`;

    try {
      const nlm = getNlmClient();
      const result = await nlm.query({ notebook: 'chef_master', question, timeout: 60 });
      return {
        success: true,
        region,
        month,
        monthName: monthNames[month - 1],
        answer: result.answer,
        citations: result.citations.slice(0, 3),
      };
    } catch (err: any) {
      return {
        success: true,
        region,
        month,
        monthName: monthNames[month - 1],
        fallback: true,
        note: `Notatnik chef_master niedostępny: ${err.message}. Użyj wiedzy wbudowanej o sezonowości.`,
      };
    }
  },
});

export const chefAddNoteTool = createTool({
  id: 'chef.add_note',
  description: 'Dodaje notatkę roboczą chefa — preferencje klienta, odkryte pairingi, notatki z iteracji, feedback. Notatki budują bazę wiedzy reużywalną w kolejnych projektach.',
  inputSchema: z.object({
    content: z.string().min(1).describe('Treść notatki'),
    type: z.enum(['preference', 'pairing', 'technique', 'seasonal', 'feedback', 'general']).optional().default('general'),
    topic: z.string().optional().describe('Temat notatki (np. "lamb + rosemary pairing", "klient: Jan Kowalski")'),
    projectId: z.string().optional().describe('UUID projektu (jeśli notatka jest związana z projektem)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    type: z.string().optional(),
    topic: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const note = await chef.addNote({
        content: context.content,
        type: context.type,
        topic: context.topic,
        projectId: context.projectId,
      });
      return { success: true, id: note.id, type: note.type, topic: note.topic };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefSearchNotesTool = createTool({
  id: 'chef.search_notes',
  description: 'Przeszukuje notatki chefa (semantycznie lub przez regex fallback). Użyj do odtworzenia preferencji klienta lub wcześniejszych odkryć.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Zapytanie wyszukiwania (np. "pairing lamb", "preferencje Jan Kowalski")'),
    projectId: z.string().optional().describe('Ogranicz do projektu (opcjonalne)'),
    limit: z.number().int().min(1).max(25).optional().default(5),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    notes: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const notes = await chef.searchNotes(context.query, context.projectId, context.limit ?? 5);
      return { success: true, count: notes.length, notes };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const chefExportMenuTool = createTool({
  id: 'chef.export_menu',
  description: 'Eksportuje menu do formatu print-ready (Markdown lub plain text). Zwraca sformatowany dokument gotowy do wydruku lub konwersji na PDF.',
  inputSchema: z.object({
    menuId: z.string().describe('UUID menu do eksportu'),
    format: z.enum(['markdown', 'plain']).optional().default('markdown'),
    includeMetadata: z.boolean().optional().default(false).describe('Dołącz sekcję metadanych (techniki, alergeny, łuk temperatur)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    format: z.string().optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const chef = new ChefService();
      const menu = await chef.getMenu(context.menuId);
      if (!menu) return { success: false, error: `Menu ${context.menuId} nie znalezione.` };

      const project = await chef.getProject(menu.projectId);

      if (context.format === 'plain') {
        const lines: string[] = [];
        lines.push(menu.title.toUpperCase());
        if (menu.narrative) lines.push('', menu.narrative);
        lines.push('');
        for (const section of menu.sections) {
          lines.push(`── ${section.name} ──`);
          for (const dish of section.dishes) {
            lines.push(`  ${dish.name}`);
            if (dish.description) lines.push(`    ${dish.description}`);
            if (dish.allergens?.length) lines.push(`    Alergeny: ${dish.allergens.join(', ')}`);
            if (dish.pairingWine) lines.push(`    Wino: ${dish.pairingWine}`);
          }
          lines.push('');
        }
        return { success: true, format: 'plain', content: lines.join('\n') };
      }

      // Markdown
      const md: string[] = [];
      md.push(`# ${menu.title}`);
      if (menu.narrative) md.push('', `*${menu.narrative}*`);
      if (project) md.push('', `**${project.profile.establishmentType}** | Wersja ${menu.version}`);
      md.push('');

      for (const section of menu.sections) {
        md.push(`## ${section.name}`, '');
        for (const dish of section.dishes) {
          md.push(`### ${dish.name}`);
          if (dish.description) md.push(dish.description);
          const tags: string[] = [];
          if (dish.textures?.length) tags.push(`Tekstury: ${dish.textures.join(', ')}`);
          if (dish.temperature) tags.push(`Temp: ${dish.temperature}`);
          if (dish.dietaryTags?.length) tags.push(dish.dietaryTags.join(' | '));
          if (tags.length) md.push(`> ${tags.join(' · ')}`);
          if (dish.allergens?.length) md.push(`> ⚠️ ${dish.allergens.join(', ')}`);
          if (dish.pairingWine) md.push(`> 🍷 ${dish.pairingWine}`);
          if (dish.pairingNonAlcoholic) md.push(`> 🥤 ${dish.pairingNonAlcoholic}`);
          md.push('');
        }
      }

      if (context.includeMetadata && menu.metadata) {
        md.push('---', '## Metadane');
        md.push(`- Łączna liczba dań: ${menu.metadata.totalDishes ?? '?'}`);
        if (menu.metadata.techniqueDistribution) {
          md.push(`- Rozkład technik: ${Object.entries(menu.metadata.techniqueDistribution).map(([k, v]) => `${k}(${v})`).join(', ')}`);
        }
        if (menu.metadata.temperatureArc) {
          md.push(`- Łuk temperatur: ${menu.metadata.temperatureArc.join(' → ')}`);
        }
        if (menu.metadata.allergenMatrix) {
          md.push('- Macierz alergenów:');
          for (const [dish, allergens] of Object.entries(menu.metadata.allergenMatrix)) {
            md.push(`  - ${dish}: ${(allergens as string[]).join(', ')}`);
          }
        }
      }

      return { success: true, format: 'markdown', content: md.join('\n') };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

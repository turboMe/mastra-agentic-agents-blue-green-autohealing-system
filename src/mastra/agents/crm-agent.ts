import { Agent } from '@mastra/core/agent';
import { agentModels, resolveModelId } from '../config/model-manifest.js';

import { searchLeadsTool } from '../tools/crm/search-leads.js';



export const crmAgent = new Agent({
  id: 'crm-agent',
  name: 'CRM Agent (Ollama)',
  instructions: `Jesteś ekspertem ds. CRM i zarządzania leadami.
Twoim zadaniem jest pomaganie użytkownikowi w przeszukiwaniu bazy leadów.

Jeśli użytkownik zapyta o konkretną firmę lub region, użyj narzędzia crm.search_leads.
Odpowiadaj zwięźle, prezentując najważniejsze dane: nazwę firmy, email i aktualny status.`,
  model: resolveModelId(agentModels.crmAgent),

  tools: { searchLeadsTool },
});

import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

const baseUrl = env.N8N_BASE_URL || env.N8N_URL || 'http://localhost:5678';
const apiKey = env.N8N_API_KEY;
if (!apiKey) throw new Error('N8N_API_KEY is required');

async function n8n(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': apiKey,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${init.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json().catch(() => ({}));
}

function extractWorkflowFromPlan() {
  const text = fs.readFileSync('ideas/rich-research.md', 'utf8');
  const marker = '```json\n';
  const start = text.indexOf(marker);
  if (start < 0) throw new Error('No n8n JSON block found in ideas/rich-research.md');
  const end = text.indexOf('\n```', start + marker.length);
  if (end < 0) throw new Error('Unterminated n8n JSON block in ideas/rich-research.md');
  return JSON.parse(text.slice(start + marker.length, end));
}

async function findMongoCredential() {
  const workflows = await n8n('/api/v1/workflows');
  const rssWorkflows = (workflows.data || []).filter((workflow) => /rss/i.test(workflow.name));
  for (const workflow of rssWorkflows) {
    const full = await n8n(`/api/v1/workflows/${workflow.id}`);
    for (const node of full.nodes || []) {
      if (node.credentials?.mongoDb?.id) return node.credentials.mongoDb;
    }
  }
  throw new Error('Could not find existing MongoDB credential in RSS workflows');
}

const parseAiResultCode = String.raw`const items = $input.all();
const originals = $("Find Unprocessed Articles").all();
const now = new Date().toISOString();

return items.map((item, i) => {
  const original = originals[i]?.json || {};
  const raw = String(item.json.response || item.json.text || item.json.data?.response || '');
  let parsed = {};

  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {};
  } catch (e) {
    parsed = { parse_error: e.message };
  }

  const relevance = Number(parsed.relevance_score || 0);
  const confidence = Number(parsed.confidence_score || (relevance >= 6 ? 0.6 : 0));
  const novelty = Number(parsed.novelty_score || 0.5);

  return {
    json: {
      ...original,
      guid: String(original.guid || parsed.guid || ''),
      title: String(original.title || parsed.title || ''),
      canonicalUrl: String(original.canonicalUrl || original.link || parsed.canonicalUrl || ''),
      source: String(original.source || parsed.source || ''),
      sourceName: String(original.sourceName || parsed.sourceName || original.source || ''),
      publishedAt: String(original.publishedAt || parsed.publishedAt || now),
      collectedAt: String(original.collectedAt || now),
      language: String(original.language || 'pl'),
      country: String(original.country || 'PL'),
      category: String(original.category || 'unknown'),
      summary_ai: String(parsed.summary_ai || parsed.summary_pl || ''),
      why_it_matters: String(parsed.why_it_matters || parsed.linkedin_angle || ''),
      relevance_score: Number.isFinite(relevance) ? relevance : 0,
      confidence_score: Number.isFinite(confidence) ? confidence : 0,
      novelty_score: Number.isFinite(novelty) ? novelty : 0,
      tags_ai: Array.isArray(parsed.tags_ai) ? parsed.tags_ai : Array.isArray(parsed.tags) ? parsed.tags : [],
      linkedin_angles: Array.isArray(parsed.linkedin_angles) ? parsed.linkedin_angles : parsed.linkedin_angle ? [parsed.linkedin_angle] : [],
      suggested_hooks: Array.isArray(parsed.suggested_hooks) ? parsed.suggested_hooks : [],
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags : [],
      processed: true,
      processedAt: now,
      ai_parse_error: parsed.parse_error || null
    }
  };
});`;

const buildSignalsCode = String.raw`const now = new Date().toISOString();

return items
  .filter((item) => Number(item.json.relevance_score || 0) >= 6 && Number(item.json.confidence_score || 0) >= 0.55 && item.json.canonicalUrl)
  .map((item) => {
    const j = item.json;
    return {
      json: {
        signalId: 'sig_' + j.guid,
        guid: j.guid,
        title: j.title,
        canonicalUrl: j.canonicalUrl,
        source: j.source,
        sourceName: j.sourceName,
        publishedAt: j.publishedAt,
        collectedAt: j.collectedAt || now,
        processedAt: j.processedAt || now,
        language: j.language || 'pl',
        country: j.country || 'PL',
        category: j.category || 'unknown',
        summary: j.summary_ai,
        whyItMatters: j.why_it_matters,
        tags: j.tags_ai || [],
        contentAngles: j.linkedin_angles || [],
        hooks: j.suggested_hooks || [],
        scores: {
          relevance: Number(j.relevance_score || 0) / 10,
          confidence: Number(j.confidence_score || 0),
          novelty: Number(j.novelty_score || 0)
        },
        usedInTasks: [],
        createdAt: now,
        updatedAt: now
      }
    };
  });`;

function patchWorkflow(workflow, mongoCredential) {
  const patched = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || { executionOrder: 'v1' },
  };

  for (const node of patched.nodes) {
    if (node.type === 'n8n-nodes-base.mongoDb') {
      node.credentials = { mongoDb: mongoCredential };
    }

    if (node.name === 'Every 6 Hours') {
      node.name = 'Every 2 Hours';
      node.parameters.rule.interval = [{ field: 'hours', hoursInterval: 2 }];
    }

    if (node.name === 'Find Unprocessed Articles') {
      delete node.parameters.limit;
      delete node.parameters.sort;
      node.parameters.query = '{ "processed": false, "title": { "$not": { "$regex": "casino|bonus|jogue|apostas|pin-up|five thousand|tigrinho|login|bet|free spins", "$options": "i" } } }';
      node.parameters.options = {
        limit: 12,
        sort: '{ "sourcePriority": -1, "publishedAt": -1, "pubDate": -1 }',
      };
    }

    if (node.name === 'Ollama Analyze Article') {
      node.parameters.jsonBody = "={{ { model: 'huihui_ai/qwen3.5-abliterated:9b', stream: false, think: false, options: { temperature: 0.2, num_predict: 900 }, prompt: $json.prompt } }}";
      node.parameters.options = { timeout: 180000 };
      node.retryOnFail = true;
      node.maxTries = 3;
      node.waitBetweenTries = 15000;
    }

    if (node.name === 'Parse AI Result') {
      node.parameters.jsCode = parseAiResultCode;
    }

    if (node.name === 'Build content_signals') {
      node.parameters.jsCode = buildSignalsCode;
    }

    if (node.name === 'Upsert rss_articles' || node.name === 'Upsert content_signals') {
      node.parameters.upsert = true;
      if (node.parameters.options?.upsert) delete node.parameters.options.upsert;
    }
  }

  return patched;
}

async function main() {
  const activate = process.argv.includes('--activate');
  const mongoCredential = await findMongoCredential();
  const workflow = patchWorkflow(extractWorkflowFromPlan(), mongoCredential);
  const workflows = await n8n('/api/v1/workflows');
  const existing = (workflows.data || []).find((item) => item.name === workflow.name);

  let saved;
  if (existing) {
    saved = await n8n(`/api/v1/workflows/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(workflow),
    });
  } else {
    saved = await n8n('/api/v1/workflows', {
      method: 'POST',
      body: JSON.stringify(workflow),
    });
  }

  if (activate) {
    await n8n(`/api/v1/workflows/${saved.id}/activate`, { method: 'POST' });
  }

  console.log(JSON.stringify({
    id: saved.id,
    name: saved.name,
    active: activate ? true : Boolean(saved.active),
    action: existing ? 'updated' : 'created',
    mongoCredential,
    editorUrl: `${baseUrl}/workflow/${saved.id}`,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

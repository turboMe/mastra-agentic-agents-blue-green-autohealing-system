export type LeadQuality = {
  score: number;
  decision: 'draft_candidate' | 'research_needed' | 'reject';
  reasons: string[];
};

type LeadForScoring = {
  company: string;
  companyName?: string | null;
  email?: string | null;
  website?: string | null;
  reason?: string | null;
  rawAnalysis?: string | null;
  personalizationHook?: string | null;
  city?: string | null;
  productCategory?: string | null;
  sourceUrls?: string[] | string | null;
  emailSource?: string | null;
  isProducer?: boolean | null;
  confidence?: number | null;
};

const MISSING_VALUES = new Set([
  '',
  '-',
  'brak',
  'brak danych',
  'nie podano',
  'nieznana',
  'nieznany',
  'null',
  'undefined',
  'n/a',
]);

const PUBLIC_EMAIL_DOMAINS = [
  'gmail.com',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'onet.pl',
  'op.pl',
  'poczta.fm',
  'gazeta.pl',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
];

const DIRECTORIES = [
  'gowork.pl',
  'panoramafirm.pl',
  'pkt.pl',
  'biznesfinder.pl',
  'ksiazka-telefoniczna.pl',
  'katalog-firm.pl',
  'aleo.com',
  'owg.pl',
  'cylex.pl',
  'infoveriti.pl',
  'krs-online.com.pl',
  'rejestr.io',
  'money.pl',
  'oferteo.pl',
];

const SOCIAL_DOMAINS = ['facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com'];

const PRODUCTION_KEYWORDS = [
  'producent',
  'produkc',
  'wytworc',
  'wytwarza',
  'zaklad',
  'przetwor',
  'manufaktur',
  'masarnia',
  'tlocznia',
  'piekarnia',
  'cukiernia',
  'gospodarstwo',
  'hodowla',
  'upraw',
  'rhd',
  'rolniczy handel detaliczny',
];

const FOOD_KEYWORDS = [
  'zywn',
  'jedzenie',
  'spozywcz',
  'produkt spozyw',
  'ser',
  'mieso',
  'warzyw',
  'owoc',
  'sok',
  'chleb',
  'maka',
  'olej',
  'nabial',
  'wedlin',
  'ryb',
  'slodycz',
  'cukiern',
  'piekar',
  'pieczyw',
  'pierog',
  'garmaz',
  'bakali',
  'kawa',
  'kaw',
  'herbat',
  'kiszon',
  'przetwor',
  'miod',
  'jaj',
  'catering',
  'kanapk',
  'potraw',
  'wedzon',
  'kasz',
  'zboz',
  'makaron',
];

const NEGATIVE_RESEARCH_SIGNALS = [
  'nie mozna potwierdzic',
  'nie da sie potwierdzic',
  'brak danych pozytywnych',
  'brak mozliwosci przeprowadzenia rzetelnej analizy',
  'niepowiazane z branza spozywcza',
  'nie jest producentem',
  'wyklucza bezposrednia wspolprace',
  'dotyczy innej firmy',
  'inna firma',
  'nie mylic',
  'wymaga weryfikacji tozsamosci',
];

const REGION_TOKENS: Record<string, string[]> = {
  slaskie: [
    'slaskie',
    'slask',
    'katowice',
    'katowick',
    'czestochowa',
    'bielsko',
    'biala',
    'gliwice',
    'zabrze',
    'bytom',
    'chorzow',
    'chorzowsk',
    'tychy',
    'sosnowiec',
    'dabrowa',
    'rybnik',
    'cieszyn',
    'zywiec',
    'zywca',
    'pszczyna',
    'mikolow',
    'myslowic',
    'ruda slaska',
    'czaniec',
    'piekary',
  ],
  dolnoslaskie: [
    'dolnoslaskie',
    'dolny slask',
    'wroclaw',
    'wroclawsk',
    'legnica',
    'walbrzych',
    'jelenia gora',
    'baryczy',
  ],
  wroclaw: ['wroclaw', 'wroclawsk', 'dolnoslaskie', 'dolny slask', 'baryczy'],
  mazowieckie: ['mazowieckie', 'mazowsze', 'mazowsza', 'warszawa', 'grójec', 'grojec', 'radom', 'siedlce', 'plock'],
  lubelskie: ['lubelskie', 'lublin', 'lubelszczyzna', 'janow lubelski', 'godziszow', 'izbica', 'hopkie'],
};

export function isKnownMissingValue(value?: string | null): boolean {
  if (value == null) return true;
  return MISSING_VALUES.has(value.trim().toLowerCase());
}

export function normalizeOptionalText(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return isKnownMissingValue(trimmed) ? null : trimmed;
}

function normalizeForMatch(value?: string | null): string {
  return normalizeOptionalText(value)
    ?.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ł/g, 'l') ?? '';
}

function getDomain(value?: string | null): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isValidEmail(e?: string | null): e is string {
  return !!normalizeOptionalText(e) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeOptionalText(e)!);
}

function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.some((publicDomain) => domain === publicDomain || domain.endsWith(`.${publicDomain}`));
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(normalizeForMatch(keyword)));
}

function getRegionTokens(region: string): string[] {
  const normalizedRegion = normalizeForMatch(region);
  const direct = REGION_TOKENS[normalizedRegion];
  if (direct) return direct;

  const matched = Object.entries(REGION_TOKENS).find(([key, tokens]) =>
    normalizedRegion.includes(key) || tokens.some((token) => normalizedRegion.includes(normalizeForMatch(token))),
  );

  return matched ? matched[1] : [region];
}

function sourceUrlsText(sourceUrls?: string[] | string | null): string {
  if (!sourceUrls) return '';
  if (Array.isArray(sourceUrls)) return sourceUrls.join(' ');
  return sourceUrls;
}

function hasUsableSourceUrl(sourceUrls?: string[] | string | null): boolean {
  const urls = Array.isArray(sourceUrls) ? sourceUrls : sourceUrls ? [sourceUrls] : [];
  return urls.some((url) => {
    const domain = getDomain(url);
    if (!domain) return false;
    return !DIRECTORIES.some((d) => domain.includes(d)) && !SOCIAL_DOMAINS.some((d) => domain.endsWith(d));
  });
}

export function scoreLead(lead: LeadForScoring, region: string): LeadQuality {
  let score = 0;
  const reasons: string[] = [];

  const email = normalizeOptionalText(lead.email);
  const website = normalizeOptionalText(lead.website);
  const text = [
    lead.reason,
    lead.rawAnalysis,
    lead.personalizationHook,
    lead.city,
    lead.productCategory,
    lead.emailSource,
    sourceUrlsText(lead.sourceUrls),
  ].map((part) => normalizeForMatch(part)).filter(Boolean).join(' ');

  if (isValidEmail(email)) {
    score += 25;
    reasons.push('+25: poprawny email');

    const emailDomain = email.split('@')[1].toLowerCase();
    const webDomain = getDomain(website);
    if (webDomain && !isPublicEmailDomain(emailDomain) && (emailDomain.includes(webDomain) || webDomain.includes(emailDomain))) {
      score += 20;
      reasons.push('+20: domena email pasuje do website');
    } else if (isPublicEmailDomain(emailDomain)) {
      reasons.push('0: email w publicznej domenie, bez kary za brak zgodności domeny');
    }
  }

  const websiteDomain = getDomain(website);
  const hasDirectoryWebsite = !!website && DIRECTORIES.some(d => website.toLowerCase().includes(d));
  const hasSocialWebsite = !!websiteDomain && SOCIAL_DOMAINS.some(d => websiteDomain.endsWith(d));

  if (websiteDomain && !hasDirectoryWebsite && !hasSocialWebsite) {
    score += 20;
    reasons.push('+20: website wygląda jak oficjalna strona');
  }

  if (hasUsableSourceUrl(lead.sourceUrls)) {
    score += 10;
    reasons.push('+10: discovery podało użyteczne źródło');
  }

  const hasProductionSignal = hasAny(text, PRODUCTION_KEYWORDS);
  if (hasProductionSignal) {
    score += 15;
    reasons.push('+15: reason zawiera słowa produkcyjne');
  }

  const hasFoodSignal = hasAny(text, FOOD_KEYWORDS);
  if (hasFoodSignal) {
    score += 15;
    reasons.push('+15: reason zawiera słowa branży spożywczej');
  }

  if (normalizeOptionalText(lead.productCategory)) {
    score += 10;
    reasons.push('+10: podana kategoria produktu');
  }

  if (lead.isProducer === true) {
    score += 20;
    reasons.push('+20: oznaczone jako producent');
  }

  if (typeof lead.confidence === 'number') {
    if (lead.confidence >= 0.8) {
      score += 10;
      reasons.push('+10: wysokie confidence discovery');
    } else if (lead.confidence >= 0.5) {
      score += 5;
      reasons.push('+5: średnie confidence discovery');
    } else if (lead.confidence < 0.35) {
      score -= 25;
      reasons.push('-25: niskie confidence discovery');
    }
  }

  const regionTokens = getRegionTokens(region);
  if (regionTokens.some((token) => text.includes(normalizeForMatch(token)))) {
    score += 10;
    reasons.push('+10: region zgodny z inputem');
  }

  const legalForms = ['sp. z o.o.', 's.c.', 'sp.j.', 'sp. j.', 'spółka', 'p.h.u.', 'p.p.h.u.', 'phup', 'f.p.u.h.', 'firma produkcyjna'];
  if (legalForms.some(f => normalizeForMatch(lead.company).includes(normalizeForMatch(f)))) {
    score += 10;
    reasons.push('+10: firma ma formę prawną');
  }

  if (hasDirectoryWebsite) {
    score -= 40;
    reasons.push('-40: website to katalog/portal');
  }

  if (hasSocialWebsite) {
    score -= 15;
    reasons.push('-15: social media jako główne źródło');
  }

  if (!hasFoodSignal && !normalizeOptionalText(lead.productCategory)) {
    score -= 20;
    reasons.push('-20: brak słów kluczowych branży spożywczej');
  }

  if (!hasProductionSignal && lead.isProducer !== true) {
    score -= 15;
    reasons.push('-15: brak jasnego sygnału produkcji/wytwórstwa');
  }

  if (lead.isProducer === false) {
    score -= 50;
    reasons.push('-50: oznaczone jako nie-producent');
  }

  if (hasAny(text, NEGATIVE_RESEARCH_SIGNALS)) {
    score -= 50;
    reasons.push('-50: research zawiera negatywny sygnał potwierdzenia');
  }

  let decision: LeadQuality['decision'] = 'reject';
  if (score >= 55) decision = 'draft_candidate';
  else if (score >= 25) decision = 'research_needed';

  return { score, decision, reasons };
}

export type IdentityCheck = {
  ok: boolean;
  confidence: number;
  reasons: string[];
};

export function validateEnrichmentIdentity(lead: any, enriched: any): IdentityCheck {
  const reasons: string[] = [];
  let confidence = 1.0;

  // 1. Token matching, only when the model explicitly returned a company name.
  if (enriched.companyName) {
    const leadTokens = normalizeForMatch(lead.company).replace(/[^a-z0-9 ]/g, '').split(' ').filter((t: string) => t.length > 2);
    const enrichedTokens = normalizeForMatch(enriched.companyName).replace(/[^a-z0-9 ]/g, '').split(' ').filter((t: string) => t.length > 2) || [];
    
    const commonTokens = leadTokens.filter((t: string) => enrichedTokens.includes(t));
    if (commonTokens.length === 0 && leadTokens.length > 0) {
      confidence -= 0.6;
      reasons.push('Brak wspólnych słów kluczowych w nazwie firmy');
    }
  }

  // 2. Domain check
  if (lead.email && enriched.website) {
    const emailDomain = String(lead.email).split('@')[1]?.toLowerCase();
    const webDomain = getDomain(enriched.website);
    if (emailDomain && webDomain && !isPublicEmailDomain(emailDomain) && !emailDomain.includes(webDomain) && !webDomain.includes(emailDomain)) {
      confidence -= 0.6;
      reasons.push('Domena website nie pasuje do domeny email');
    }
  }

  const webDomain = getDomain(enriched.website);
  if (webDomain && /\.(co\.uk|com\.au|ca|de|fr|it|es)$/.test(webDomain) && !webDomain.endsWith('.pl')) {
    confidence -= 0.2;
    reasons.push('Domena wygląda na zagraniczny podmiot');
  }

  return {
    ok: confidence >= 0.5,
    confidence,
    reasons
  };
}

export function validateDraft(draft: { subject: string, body: string }, lead: any): { ok: boolean; hardFailures: string[]; softWarnings: string[] } {
  const hardFailures: string[] = [];
  const softWarnings: string[] = [];
  const subject = typeof draft?.subject === 'string' ? draft.subject : '';
  const body = typeof draft?.body === 'string' ? draft.body : '';

  if (subject.length < 5) hardFailures.push('Temat za krótki');
  
  const placeholders = ['[Twoje Imię i Nazwisko]', '[imię]', '[nazwa firmy]', '{{', '}}', '[...]', 'XYZ'];
  for (const p of placeholders) {
    if (body.includes(p)) hardFailures.push(`Zawiera placeholder: ${p}`);
  }

  if (!body.includes('GastroBridge')) hardFailures.push('Brak nazwy GastroBridge');
  
  const forbiddenNames = ['Gastro-Supply', 'Gastro Market'];
  for (const fn of forbiddenNames) {
    if (body.includes(fn)) hardFailures.push(`Zawiera wymyśloną nazwę: ${fn}`);
  }

  if (!body.includes('Administratorem danych jest GastroBridge') || !body.includes('Odpisz "NIE"')) {
    hardFailures.push('Brak pełnej stopki RODO');
  }

  if (body.length < 200) softWarnings.push('Draft może być za krótki');
  if (lead?.rawAnalysis && body.length > 0) {
    const analysisWords = String(lead.rawAnalysis).toLowerCase().match(/[a-ząćęłńóśźż]{5,}/g) ?? [];
    const matched = analysisWords.slice(0, 30).some((word) => body.toLowerCase().includes(word));
    if (!matched) softWarnings.push('Draft może nie używać konkretów z researchu');
  }
  
  return {
    ok: hardFailures.length === 0,
    hardFailures,
    softWarnings
  };
}

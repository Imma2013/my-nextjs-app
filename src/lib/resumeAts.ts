export const ATS_RESUME_RULES = `ATS resume rules:
- Use a clean, one-column resume with standard section headings such as Profile, Experience, Education, Skills, Projects, Certifications, Awards, and Community Service.
- Use plain text only: no tables, text boxes, columns, images, icons, charts, graphics, or decorative symbols.
- Use normal hyphen or bullet-list wording; avoid special glyph bullets, rating bars, keyword stuffing, and hidden text.
- Keep full URLs visible instead of embedded hyperlink-only labels when links are included.
- Keep dates consistent and readable, using month/year, year, or Present consistently across roles.
- Preserve factual accuracy. Include job keywords only when they are proven by the resume or clearly confirmed by the user.
- If a job-required keyword, tool, certification, or credential is relevant but not supported, list it as missingKeywords instead of adding it to experience, skills, or summary.
- Keep PDF output text-based, copyable, and readable by ATS parsers.`;

export type AtsValidationResult = {
  warnings: string[];
  suggestions: string[];
  missingKeywords: string[];
};

const STANDARD_SECTIONS = [
  'experience',
  'education',
  'skills',
];

const OPTIONAL_STANDARD_SECTIONS = [
  'projects',
  'certifications',
  'awards',
  'communityService',
  'volunteer',
  'volunteering',
];

const ATS_KEYWORDS = [
  'Microsoft Excel',
  'Excel',
  'Microsoft Office',
  'Google Sheets',
  'Salesforce',
  'QuickBooks',
  'CPR',
  'ServSafe',
  'OSHA',
  'SQL',
  'Python',
  'JavaScript',
  'TypeScript',
  'React',
  'Next.js',
  'Node.js',
  'Express.js',
  'HTML',
  'CSS',
  'API',
  'REST',
  'GraphQL',
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'Firebase',
  'Supabase',
  'AWS',
  'Azure',
  'GCP',
  'Docker',
  'Kubernetes',
  'Git',
  'GitHub',
  'CI/CD',
  'Agile',
  'Scrum',
  'Customer service',
  'Sales',
  'Leadership',
  'Scheduling',
  'Training',
  'Data entry',
  'Inventory',
  'Cash handling',
  'Communication',
];

function arr(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return [];
}

function getSection(parsed: any, key: string) {
  return arr(parsed?.sections?.[key] ?? parsed?.[key]);
}

function compact(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(value: unknown) {
  return compact(value).toLowerCase().replace(/[^a-z0-9+#/.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function collectText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(collectText).join('\n');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(collectText).join('\n');
  return '';
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  return values
    .map(compact)
    .filter(value => {
      const key = normalizeText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function includesPhrase(text: string, phrase: string) {
  const normalized = normalizeText(text);
  const key = normalizeText(phrase);
  if (!key) return false;
  return new RegExp(`(^|\\s)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(normalized);
}

function extractCertificationKeywords(jobDescription: string) {
  const text = String(jobDescription || '');
  const matches = text.match(/\b(?:certified|certification|certificate|license|licensed)\b[^.\n;:]{0,80}/gi) || [];
  return matches
    .map(match => compact(match).replace(/^(required|preferred|must have|nice to have)\s+/i, ''))
    .filter(match => match.length <= 90);
}

function extractAcronyms(jobDescription: string) {
  const matches = String(jobDescription || '').match(/\b[A-Z][A-Z0-9+#/.]{1,9}\b/g) || [];
  return matches.filter(value => !/^(EEO|USA|US|HR|PDF|ATS)$/.test(value));
}

export function extractAtsKeywords(jobDescription?: string | null) {
  const text = String(jobDescription || '');
  if (!text.trim()) return [];
  const keywords = dedupe([
    ...ATS_KEYWORDS.filter(keyword => includesPhrase(text, keyword)),
    ...extractCertificationKeywords(text),
    ...extractAcronyms(text),
  ]);
  const normalized = new Set(keywords.map(normalizeText));
  return keywords
    .filter(keyword => !(normalizeText(keyword) === 'excel' && normalized.has('microsoft excel')))
    .slice(0, 20);
}

function hasVisibleUrls(text: string) {
  return !/\b(?:portfolio|linkedin|github|website)\b/i.test(text) || /https?:\/\/|www\./i.test(text);
}

function dateValues(parsed: any) {
  return getSection(parsed, 'experience')
    .map(item => compact(item?.dates || item?.date || item?.duration))
    .filter(Boolean);
}

function dateStyle(value: string) {
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(value)) return 'month-year';
  if (/\b20\d{2}\b|\b19\d{2}\b/.test(value)) return 'year';
  return 'other';
}

export function validateAtsResume(parsedResume: any, jobDescription?: string | null): AtsValidationResult {
  const parsed = parsedResume || {};
  const text = collectText(parsed);
  const normalized = normalizeText(text);
  const warnings: string[] = [];
  const suggestions: string[] = [];

  if (!parsed.contact?.email && !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) {
    warnings.push('Missing a visible email address in contact information.');
  }
  if (!parsed.contact?.phone && !/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text)) {
    warnings.push('Missing a visible phone number in contact information.');
  }

  STANDARD_SECTIONS.forEach(section => {
    if (!getSection(parsed, section).length) {
      warnings.push(`Missing standard ATS section: ${section}.`);
    }
  });

  if (!OPTIONAL_STANDARD_SECTIONS.some(section => getSection(parsed, section).length)) {
    suggestions.push('Add relevant standard sections such as Projects, Certifications, Awards, or Community Service when supported.');
  }

  if (/\b(table|columns?|text box|textbox|image|icon|graphic|chart|photo|headshot)\b/i.test(normalized)) {
    warnings.push('Resume content may reference ATS-hostile formatting such as tables, columns, images, icons, or graphics.');
  }
  if (/[●◆■★✓]/.test(text)) {
    warnings.push('Special bullet or icon glyphs detected; use plain bullets or hyphens.');
  }
  if (!hasVisibleUrls(text)) {
    suggestions.push('Include full visible URLs for portfolio, LinkedIn, GitHub, or website links.');
  }

  const styles = dedupe(dateValues(parsed).map(dateStyle)).filter(style => style !== 'other');
  if (styles.length > 1) {
    suggestions.push('Use one consistent date style across experience entries.');
  }

  const missingKeywords = extractAtsKeywords(jobDescription).filter(keyword => !includesPhrase(text, keyword)).slice(0, 8);
  if (missingKeywords.length) {
    suggestions.push('Keep unsupported job keywords out of resume bullets and track them as missingKeywords.');
  }

  return {
    warnings: dedupe(warnings),
    suggestions: dedupe(suggestions),
    missingKeywords,
  };
}

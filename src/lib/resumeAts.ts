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

export type AtsReviewResult = AtsValidationResult & {
  fixed: string[];
};

const DATE_FIELD_KEYS = new Set([
  'date',
  'dates',
  'duration',
  'start_date',
  'end_date',
  'startDate',
  'endDate',
]);

const SECTION_KEY_ALIASES: Record<string, string> = {
  'community service': 'communityService',
  community_service: 'communityService',
  communityservice: 'communityService',
  volunteerwork: 'volunteer',
  'volunteer work': 'volunteer',
};

const SAFE_TEXT_CORRECTIONS: Array<{ pattern: RegExp; replacement: string; fixed: string }> = [
  { pattern: /\bSix flags\b/gi, replacement: 'Six Flags', fixed: 'cleaned employer capitalization' },
  { pattern: /\bChick fil a\b/gi, replacement: 'Chick-fil-A', fixed: 'cleaned employer capitalization' },
  { pattern: /\bLinkedin\b/g, replacement: 'LinkedIn', fixed: 'cleaned link capitalization' },
  { pattern: /\bGithub\b/g, replacement: 'GitHub', fixed: 'cleaned link capitalization' },
  { pattern: /\bJavascript\b/g, replacement: 'JavaScript', fixed: 'cleaned technology capitalization' },
  { pattern: /\bTypescript\b/g, replacement: 'TypeScript', fixed: 'cleaned technology capitalization' },
  { pattern: /\bNext\.js\b/gi, replacement: 'Next.js', fixed: 'cleaned technology capitalization' },
  { pattern: /\bNode\.js\b/gi, replacement: 'Node.js', fixed: 'cleaned technology capitalization' },
  { pattern: /\bExpress\.js\b/gi, replacement: 'Express.js', fixed: 'cleaned technology capitalization' },
  { pattern: /\bPostgresql\b/g, replacement: 'PostgreSQL', fixed: 'cleaned technology capitalization' },
  { pattern: /\bMysql\b/g, replacement: 'MySQL', fixed: 'cleaned technology capitalization' },
  { pattern: /\bMongodb\b/g, replacement: 'MongoDB', fixed: 'cleaned technology capitalization' },
  { pattern: /\bMiddle school\b/gi, replacement: 'Middle School', fixed: 'cleaned school capitalization' },
  { pattern: /\bHigh school\b/gi, replacement: 'High School', fixed: 'cleaned school capitalization' },
];

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

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {}));
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

function cleanString(value: string, key?: string, fixed?: string[]) {
  let next = value;
  const dateLike = key ? DATE_FIELD_KEYS.has(key) : false;

  if (/\btill\s+date\b/i.test(next)) {
    next = next.replace(/\btill\s+date\b/gi, 'Present');
    fixed?.push('normalized dates');
  }
  if (dateLike && /\b(?:until|to)\s+date\b/i.test(next)) {
    next = next.replace(/\b(?:until|to)\s+date\b/gi, 'Present');
    fixed?.push('normalized dates');
  }
  if (dateLike && /^\s*(?:current|now)\s*$/i.test(next)) {
    next = 'Present';
    fixed?.push('normalized dates');
  }

  const withoutEditorArtifact = next
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\+\s+(?=\S)/, ''))
    .join('\n');
  if (withoutEditorArtifact !== next) {
    next = withoutEditorArtifact;
    fixed?.push('removed editor artifact');
  }

  SAFE_TEXT_CORRECTIONS.forEach(({ pattern, replacement, fixed: fixedLabel }) => {
    const corrected = next.replace(pattern, replacement);
    if (corrected !== next) {
      next = corrected;
      fixed?.push(fixedLabel);
    }
  });

  return next;
}

function normalizedSectionKey(key: string) {
  return SECTION_KEY_ALIASES[normalizeText(key)] || key;
}

function normalizeValue(value: any, key?: string, fixed?: string[]): any {
  if (typeof value === 'string') return cleanString(value, key, fixed).trim();
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeValue(item, key, fixed))
      .filter(item => !(typeof item === 'string' && !item.trim()));
  }
  if (!value || typeof value !== 'object') return value;

  const normalized: any = {};
  Object.entries(value).forEach(([rawKey, rawValue]) => {
    const nextKey = normalizedSectionKey(rawKey);
    const nextValue = normalizeValue(rawValue, rawKey, fixed);
    if (normalized[nextKey] == null) normalized[nextKey] = nextValue;
    else if (Array.isArray(normalized[nextKey])) normalized[nextKey] = normalized[nextKey].concat(arr(nextValue));
    else normalized[nextKey] = nextValue;
  });
  return normalized;
}

function normalizeDateRange(item: any) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const next = { ...item };
  if (!next.dates && (next.start_date || next.end_date || next.startDate || next.endDate)) {
    const start = next.start_date || next.startDate || '';
    const end = next.end_date || next.endDate || '';
    next.dates = [start, end].filter(Boolean).join(' - ');
  }
  if (next.role && !next.title) next.title = next.role;
  if (next.title && !next.role) next.role = next.title;
  return next;
}

function normalizeCommunityItem(item: any, fixed?: string[]) {
  if (typeof item === 'string') {
    const parts = item.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
    if (parts.length >= 3) {
      fixed?.push('formatted community service');
      return {
        role: parts[0],
        organization: parts[1],
        dates: parts[2],
        bullets: parts.slice(3),
      };
    }
    return item;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const next: any = normalizeDateRange({ ...item });
  if (!next.organization && (next.company || next.employer || next.school || next.institution || next.name)) {
    next.organization = next.company || next.employer || next.school || next.institution || next.name;
    fixed?.push('formatted community service');
  }
  if (!next.role && next.title) {
    next.role = next.title;
    fixed?.push('formatted community service');
  }
  if (!Array.isArray(next.bullets)) {
    const bulletSource = next.highlights || next.details || next.description;
    if (Array.isArray(bulletSource)) next.bullets = bulletSource;
    else if (typeof bulletSource === 'string' && bulletSource.trim()) next.bullets = [bulletSource.trim()];
  }
  return next;
}

function normalizeSections(parsed: any, fixed?: string[]) {
  const next = parsed && typeof parsed === 'object' ? parsed : {};
  next.sections = next.sections && typeof next.sections === 'object' && !Array.isArray(next.sections) ? next.sections : {};

  Object.keys(next).forEach(key => {
    const sectionKey = normalizedSectionKey(key);
    if (sectionKey !== key) {
      next[sectionKey] = next[sectionKey] == null ? next[key] : next[sectionKey];
      delete next[key];
    }
  });
  Object.keys(next.sections).forEach(key => {
    const sectionKey = normalizedSectionKey(key);
    if (sectionKey !== key) {
      next.sections[sectionKey] = next.sections[sectionKey] == null ? next.sections[key] : next.sections[sectionKey];
      delete next.sections[key];
    }
  });

  ['experience', 'education', 'projects'].forEach(section => {
    const normalized = getSection(next, section).map(normalizeDateRange);
    if (normalized.length) {
      next.sections[section] = normalized;
      next[section] = normalized;
    }
  });

  const service = [
    ...getSection(next, 'communityService'),
    ...getSection(next, 'volunteer'),
    ...getSection(next, 'volunteering'),
  ].map(item => normalizeCommunityItem(item, fixed));
  if (service.length) {
    next.sections.communityService = service;
    next.communityService = service;
  }

  const skills = getSection(next, 'skills');
  if (skills.length) {
    next.sections.skills = skills;
    next.skills = skills;
  }

  return next;
}

export function normalizeAtsResume<T = any>(parsedResume: T): T {
  const fixed: string[] = [];
  const normalized = normalizeSections(normalizeValue(copy(parsedResume), undefined, fixed), fixed);
  return normalized as T;
}

function detectFixed(before: any, after: any) {
  const beforeText = collectText(before);
  const afterText = collectText(after);
  const fixed: string[] = [];

  if (/\btill\s+date\b/i.test(beforeText) && /\bPresent\b/.test(afterText)) fixed.push('normalized dates');
  if (/^\s*\+\s+\S/m.test(beforeText) && !/^\s*\+\s+\S/m.test(afterText)) fixed.push('removed editor artifact');
  SAFE_TEXT_CORRECTIONS.forEach(({ pattern, fixed: fixedLabel }) => {
    pattern.lastIndex = 0;
    if (pattern.test(beforeText)) fixed.push(fixedLabel);
  });
  if (JSON.stringify(getSection(before, 'communityService')) !== JSON.stringify(getSection(after, 'communityService'))) {
    fixed.push('formatted community service');
  }

  return dedupe(fixed);
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

export function reviewAtsResume(parsedResume: any, jobDescription?: string | null): AtsReviewResult {
  const normalized = normalizeAtsResume(parsedResume);
  const validation = validateAtsResume(normalized, jobDescription);
  return {
    fixed: detectFixed(parsedResume, normalized),
    warnings: validation.warnings,
    suggestions: validation.suggestions,
    missingKeywords: validation.missingKeywords,
  };
}

export function formatAtsReviewSummary(review: AtsReviewResult) {
  const lines: string[] = [];
  if (review.fixed.length) lines.push(`Fixed: ${review.fixed.join(', ')}.`);
  const needsConfirmation = dedupe([
    ...review.missingKeywords,
    ...review.warnings.filter(item => /email|phone|url|unsupported|credential|certification|keyword/i.test(item)),
    ...review.suggestions.filter(item => /url|unsupported|credential|certification|keyword/i.test(item)),
  ]).slice(0, 5);
  if (needsConfirmation.length) lines.push(`Still needs confirmation: ${needsConfirmation.join(', ')}.`);
  return lines.join('\n');
}

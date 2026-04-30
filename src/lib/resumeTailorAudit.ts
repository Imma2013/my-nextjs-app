type TailorAnswer = {
  questionId: string;
  question?: string;
  answer: string;
};

type TailorJob = {
  title?: string;
  company_name?: string;
  location?: string;
  description?: string;
};

type Claim = {
  label: string;
  patterns: RegExp[];
  critical?: boolean;
};

const CLAIMS: Claim[] = [
  { label: 'React', patterns: [/\breact(?:\.js|js)?\b/i], critical: true },
  { label: 'Next.js', patterns: [/\bnext(?:\.js|js)?\b/i], critical: true },
  { label: 'Express.js', patterns: [/\bexpress(?:\.js|js)?\b/i], critical: true },
  { label: 'JavaScript', patterns: [/\bjava\s*script\b/i, /(^|[^a-z0-9.])js($|[^a-z0-9])/i], critical: true },
  { label: 'TypeScript', patterns: [/\btype\s*script\b/i, /(^|[^a-z0-9.])ts($|[^a-z0-9])/i], critical: true },
  { label: 'FinTech', patterns: [/\bfintech\b/i, /\bfinancial technology\b/i] },
  { label: 'CI/CD', patterns: [/\bci\/cd\b/i, /\bcontinuous integration\b/i, /\bcontinuous deployment\b/i, /\bcontinuous delivery\b/i] },
  { label: 'TDD', patterns: [/\btdd\b/i, /\btest[-\s]?driven development\b/i] },
  { label: 'Accessibility', patterns: [/\baccessibility\b/i, /\bada\b/i, /\bwcag\b/i, /\ba11y\b/i] },
  { label: '2+ years', patterns: [/\b(?:2\+|two\+|two plus|at least 2|2 or more)\s+years?\b/i, /\b[2-9]\+?\s+years?\b/i], critical: true },
];

const COMMON_JOB_KEYWORDS = [
  'Customer service',
  'Communication',
  'Teamwork',
  'Problem solving',
  'Operations',
  'Training',
  'Leadership',
  'Sales',
  'Microsoft Office',
  'Data entry',
  'Web design',
  'HTML',
  'CSS',
  'API',
  'Database',
  'Authentication',
  'Deployment',
];

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function arr(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split('\n').map(line => line.trim()).filter(Boolean);
  return [];
}

function getSection(parsed: any, key: string) {
  return arr(parsed?.sections?.[key] ?? parsed?.[key]);
}

function setSection(parsed: any, key: string, values: any[]) {
  parsed.sections = parsed.sections || {};
  parsed.sections[key] = values;
  parsed[key] = values;
}

function normalizeText(value: unknown) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9+#/.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function compact(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(collectText).join('\n');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(collectText).join('\n');
  return '';
}

function isUncertainAnswer(value: string) {
  const text = normalizeText(value);
  return !text
    || ['n/a', 'na', 'none', 'no', 'nope', 'idk', 'unknown', 'skip', 'skipped'].includes(text)
    || /\b(i do not know|i don t know|dont know|don't know|not sure|unsure|uncertain|can't remember|cannot remember)\b/.test(text);
}

function supportedAnswerText(answers: TailorAnswer[]) {
  return answers
    .filter(answer => !isUncertainAnswer(answer.answer))
    .map(answer => `${answer.question || ''}\n${answer.answer}`)
    .join('\n');
}

function containsClaim(text: string, claim: Claim) {
  return claim.patterns.some(pattern => pattern.test(text));
}

function claimsInText(text: string) {
  return CLAIMS.filter(claim => containsClaim(text, claim));
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  return values
    .map(value => compact(value))
    .filter(value => {
      const key = normalizeText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function splitSentences(value: string) {
  return value
    .split(/(?<=[.!?])\s+|\n+/)
    .map(compact)
    .filter(Boolean);
}

function removeUnsupportedSentences(value: unknown, unsupportedClaims: Claim[]) {
  const text = compact(value);
  if (!text) return '';
  if (!unsupportedClaims.some(claim => containsClaim(text, claim))) return text;
  const kept = splitSentences(text).filter(sentence => !unsupportedClaims.some(claim => containsClaim(sentence, claim)));
  return kept.join(' ');
}

function sanitizeBulletList(candidateValue: any, sourceValue: any, unsupportedClaims: Claim[]) {
  const sourceItems = arr(sourceValue);
  const kept = arr(candidateValue).filter(item => {
    const text = typeof item === 'string' ? item : collectText(item);
    return !unsupportedClaims.some(claim => containsClaim(text, claim));
  });
  return kept.length ? kept : sourceItems;
}

function sanitizeDescriptiveFields(item: any, sourceItem: any, unsupportedClaims: Claim[]) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const next = { ...item };
  (['bullets', 'highlights', 'details'] as const).forEach(field => {
    if (field in next || field in (sourceItem || {})) {
      next[field] = sanitizeBulletList(next[field], sourceItem?.[field], unsupportedClaims);
    }
  });
  if (typeof next.description === 'string') {
    next.description = removeUnsupportedSentences(next.description, unsupportedClaims) || sourceItem?.description || '';
  }
  return next;
}

function sanitizeSection(parsed: any, source: any, key: string, unsupportedClaims: Claim[]) {
  const sourceSection = getSection(source, key);
  const sanitized = getSection(parsed, key).map((item, index) => sanitizeDescriptiveFields(item, sourceSection[index], unsupportedClaims));
  if (sanitized.length) setSection(parsed, key, sanitized);
}

function sanitizeSkills(parsed: any, source: any, unsupportedClaims: Claim[]) {
  const skills = getSection(parsed, 'skills').filter(skill => !unsupportedClaims.some(claim => containsClaim(collectText(skill), claim)));
  setSection(parsed, 'skills', skills.length ? skills : getSection(source, 'skills'));
}

function canonicalSummary(parsed: any, source: any, fallback: string) {
  const candidate = compact(parsed.profile || parsed.professionalSummary || parsed.summary);
  const sourceSummary = compact(source.profile || source.professionalSummary || source.summary);
  const summary = candidate || sourceSummary || fallback;
  parsed.summary = summary;
  parsed.profile = summary;
  if (parsed.professionalSummary) parsed.professionalSummary = summary;
  return summary;
}

function keywordSupported(keyword: string, supportCorpus: string) {
  const key = normalizeText(keyword);
  if (!key) return false;
  const claim = CLAIMS.find(item => item.label.toLowerCase() === keyword.toLowerCase() || containsClaim(keyword, item));
  if (claim) return containsClaim(supportCorpus, claim);
  return normalizeText(supportCorpus).includes(key);
}

function keywordAppears(keyword: string, text: string) {
  const key = normalizeText(keyword);
  if (!key) return false;
  const claim = CLAIMS.find(item => item.label.toLowerCase() === keyword.toLowerCase() || containsClaim(keyword, item));
  if (claim) return containsClaim(text, claim);
  return normalizeText(text).includes(key);
}

function deriveMatchedKeywords({
  source,
  tailored,
  jobText,
  supportCorpus,
  geminiMatched,
  unsupportedJobClaims,
}: {
  source: any;
  tailored: any;
  jobText: string;
  supportCorpus: string;
  geminiMatched: unknown;
  unsupportedJobClaims: Claim[];
}) {
  const tailoredText = collectText(tailored);
  const unsupportedLabels = new Set(unsupportedJobClaims.map(claim => claim.label.toLowerCase()));
  const candidates = [
    ...(Array.isArray(geminiMatched) ? geminiMatched.map(String) : []),
    ...claimsInText(jobText).map(claim => claim.label),
    ...COMMON_JOB_KEYWORDS.filter(keyword => keywordAppears(keyword, jobText)),
  ];
  return dedupe(candidates)
    .filter(keyword => !unsupportedLabels.has(keyword.toLowerCase()))
    .filter(keyword => keywordAppears(keyword, tailoredText))
    .filter(keyword => keywordSupported(keyword, supportCorpus || collectText(source)))
    .slice(0, 10);
}

function deriveMissingKeywords({
  jobText,
  geminiMissing,
  unsupportedJobClaims,
}: {
  jobText: string;
  geminiMissing: unknown;
  unsupportedJobClaims: Claim[];
}) {
  const missing = [
    ...unsupportedJobClaims.map(claim => claim.label),
    ...(Array.isArray(geminiMissing) ? geminiMissing.map(String) : []),
  ].filter(keyword => keywordAppears(keyword, jobText) || unsupportedJobClaims.some(claim => claim.label === keyword));
  return dedupe(missing).slice(0, 8);
}

function simpleSectionText(parsed: any, key: string) {
  return normalizeText(getSection(parsed, key).map(collectText).join('\n'));
}

function deriveImprovements(source: any, tailored: any) {
  const improvements: string[] = [];
  if (normalizeText(source.summary || source.profile || source.professionalSummary) !== normalizeText(tailored.summary || tailored.profile || tailored.professionalSummary)) {
    improvements.push('Rewrote the profile using supported resume facts for the target role.');
  }
  if (normalizeText(source.headline || source.title) !== normalizeText(tailored.headline || tailored.title)) {
    improvements.push('Adjusted the headline while preserving the candidate identity.');
  }
  if (simpleSectionText(source, 'experience') !== simpleSectionText(tailored, 'experience')) {
    improvements.push('Refocused existing experience bullets on relevant, supported responsibilities.');
  }
  if (simpleSectionText(source, 'projects') !== simpleSectionText(tailored, 'projects')) {
    improvements.push('Updated project descriptions with only supported tools and scope.');
  }
  if (simpleSectionText(source, 'skills') !== simpleSectionText(tailored, 'skills')) {
    improvements.push('Reordered or trimmed skills to match confirmed qualifications.');
  }
  return improvements.slice(0, 4);
}

function capScore(score: unknown, unsupportedJobClaims: Claim[]) {
  const base = Math.max(0, Math.min(100, Number(score || 0)));
  if (!unsupportedJobClaims.length) return base;
  const criticalCount = unsupportedJobClaims.filter(claim => claim.critical).length;
  const cap = criticalCount >= 3 ? 55 : criticalCount > 0 ? 65 : 75;
  return Math.min(base, cap);
}

export function auditTailoredResume({
  sourceParsed,
  tailoredParsed,
  job,
  answers,
  gemini,
  fallbackSummary,
}: {
  sourceParsed: any;
  tailoredParsed: any;
  job: TailorJob;
  answers: TailorAnswer[];
  gemini: {
    score?: unknown;
    matchedKeywords?: unknown;
    missingKeywords?: unknown;
  };
  fallbackSummary: string;
}) {
  const source = copy(sourceParsed || {});
  const audited = copy(tailoredParsed || {});
  const supportCorpus = [collectText(source), supportedAnswerText(answers)].join('\n');
  const jobText = `${job.title || ''}\n${job.company_name || ''}\n${job.description || ''}`;
  const unsupportedClaims = CLAIMS.filter(claim => containsClaim(collectText(audited), claim) && !containsClaim(supportCorpus, claim));
  const unsupportedJobClaims = CLAIMS.filter(claim => containsClaim(jobText, claim) && !containsClaim(supportCorpus, claim));

  if (unsupportedClaims.length) {
    sanitizeSkills(audited, source, unsupportedClaims);
    (['experience', 'projects', 'communityService', 'volunteer', 'volunteering'] as const).forEach(key => sanitizeSection(audited, source, key, unsupportedClaims));
    (['summary', 'profile', 'professionalSummary', 'headline', 'title'] as const).forEach(field => {
      if (typeof audited[field] === 'string') {
        audited[field] = removeUnsupportedSentences(audited[field], unsupportedClaims) || source[field] || '';
      }
    });
  }

  const summary = canonicalSummary(audited, source, fallbackSummary);
  const matchedKeywords = deriveMatchedKeywords({
    source,
    tailored: audited,
    jobText,
    supportCorpus,
    geminiMatched: gemini.matchedKeywords,
    unsupportedJobClaims,
  });
  const missingKeywords = deriveMissingKeywords({
    jobText,
    geminiMissing: gemini.missingKeywords,
    unsupportedJobClaims,
  });

  return {
    parsed: audited,
    summary,
    score: capScore(gemini.score, unsupportedJobClaims),
    improvements: deriveImprovements(source, audited),
    matchedKeywords,
    missingKeywords,
    unsupportedClaims: unsupportedClaims.map(claim => claim.label),
    unsupportedJobClaims: unsupportedJobClaims.map(claim => claim.label),
  };
}

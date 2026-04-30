import { createClient } from '@supabase/supabase-js';
import {
  assertCanRunPaidAction,
  creditCostForAction,
  inferResumeBillingAction,
  isPaidBillingAction,
  recordPaidActionSuccess,
  type BillingAction,
} from '@/lib/billing';
import { generateGeminiContent } from '@/lib/gemini';
import { RESUME_FACT_SAFETY_RULES } from '@/lib/resumeFacts';

export type EditOp = { operation?: 'replace' | 'add' | 'remove'; path: string; value?: unknown };

export type ResumeEditInput = {
  resumeId?: string;
  userId?: string;
  message?: string;
  value?: unknown;
  edit?: EditOp;
  billingAction?: string | null;
  idempotencyKey?: string | null;
  skipBilling?: boolean;
};

export type ResumeEditResult = {
  handled?: boolean;
  resume?: unknown;
  reply: string;
  operations?: EditOp[];
  billing?: unknown;
  processedBy?: string;
};

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Database is not configured');
  return createClient(url, key);
}

function copy(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function getSection(parsed: any, name: string) {
  parsed.sections = parsed.sections || {};
  if (Array.isArray(parsed.sections[name])) return parsed.sections[name];
  if (Array.isArray(parsed[name])) {
    parsed.sections[name] = parsed[name];
    return parsed.sections[name];
  }
  parsed.sections[name] = [];
  return parsed.sections[name];
}

const EDITABLE_SECTION_KEYS = new Set([
  'experience',
  'education',
  'skills',
  'projects',
  'awards',
  'certifications',
  'communityService',
  'volunteer',
  'volunteering',
]);

function ensureFirstExperience(parsed: any) {
  const exp = getSection(parsed, 'experience');
  if (!exp.length) exp.push({ role: 'Job Title', company: 'Company Name', bullets: [] });
  return exp[0];
}

function valueFromMessage(message: string, fallback = 'Title') {
  const quoted = message.match(/["“”']([^"“”']+)["“”']/)?.[1];
  if (quoted) return quoted.trim();
  if (/just\s+title/i.test(message)) return 'Title';
  const explicitSkill = [
    /(?:add|include)\s+(?:a\s+)?skills?\s+(?:saying|called|named|to|as|with)?\s+(.+)$/i,
    /(?:skills?)\s+(?:saying|called|named|to|as|with)\s+(.+)$/i,
    /(?:add|include)\s+(.+?)\s+(?:as|to)\s+(?:a\s+)?skills?$/i,
  ]
    .map(pattern => message.match(pattern)?.[1]?.trim())
    .find(Boolean);
  if (explicitSkill) return explicitSkill.replace(/[.?!]$/, '').trim();
  const after = message.match(/(?:say|to|as|be|with)\s+(.+)$/i)?.[1]?.trim();
  if (after && after.length < 160) return after.replace(/[.?!]$/, '').trim();
  return fallback;
}

function deterministicOps(message: string): EditOp[] {
  if (message.length > 200) return [];
  const lower = message.toLowerCase();
  const value = valueFromMessage(message);
  if (/job title|\btitle\b|\brole\b|position/.test(lower)) return [{ operation: 'replace', path: 'experience.0.role', value }];
  if (/company|employer/.test(lower)) return [{ operation: 'replace', path: 'experience.0.company', value }];
  if (/location|city/.test(lower)) return [{ operation: 'replace', path: 'experience.0.location', value }];
  if (/date|month|year|present/.test(lower)) return [{ operation: 'replace', path: 'experience.0.dates', value }];
  if (/skill/.test(lower)) return [{ operation: /\b(add|include)\b/.test(lower) ? 'add' : 'replace', path: 'skills', value: /\b(add|include)\b/.test(lower) ? value : [value] }];
  if (/bullet|responsibilit|achievement/.test(lower)) return [{ operation: 'replace', path: 'experience.0.bullets.0', value }];
  return [];
}

export function applyResumeEditOperation(parsedInput: any, op: EditOp) {
  const parsed = copy(parsedInput);
  const parts = String(op.path || '').replace(/^parsed_json\./, '').split('.').filter(Boolean);
  if (!parts.length) return parsed;
  let target: any = parsed;
  let start = 0;
  if (EDITABLE_SECTION_KEYS.has(parts[0])) {
    target = getSection(parsed, parts[0]);
    start = 1;
  } else if (parts[0] === 'sections' && EDITABLE_SECTION_KEYS.has(parts[1])) {
    target = getSection(parsed, parts[1]);
    start = 2;
  }

  if (EDITABLE_SECTION_KEYS.has(parts[0]) && parts.length === 1) {
    if (op.operation === 'add') {
      if (parts[0] === 'experience') target.unshift(op.value);
      else target.push(op.value);
    } else if (op.operation === 'remove') parsed.sections[parts[0]] = [];
    else parsed.sections[parts[0]] = Array.isArray(op.value) ? op.value : [op.value];
    parsed[parts[0]] = parsed.sections[parts[0]];
    return parsed;
  }

  for (let i = start; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const nextKey = parts[i + 1];
    const idx = Number(key);
    if (Array.isArray(target) && Number.isInteger(idx) && String(idx) === key) {
      while (target.length <= idx) target.push({});
      target = target[idx];
    } else {
      if (target[key] == null) target[key] = /^\d+$/.test(nextKey) ? [] : {};
      target = target[key];
    }
  }

  const last = parts[parts.length - 1];
  const lastIndex = Number(last);
  if (op.operation === 'remove') {
    if (Array.isArray(target) && Number.isInteger(lastIndex) && String(lastIndex) === last) target.splice(lastIndex, 1);
    else delete target[last];
  } else if (op.operation === 'add' && Array.isArray(target[last])) {
    if (last === 'experience') target[last].unshift(op.value);
    else target[last].push(op.value);
  } else if (Array.isArray(target) && Number.isInteger(lastIndex) && String(lastIndex) === last) {
    target[lastIndex] = op.value;
  } else {
    target[last] = op.value;
  }

  const exp = parsed.sections?.experience;
  if (Array.isArray(exp)) {
    exp.forEach((item: any) => {
      if (item.role && !item.title) item.title = item.role;
      if (item.title && !item.role) item.role = item.title;
    });
  }
  EDITABLE_SECTION_KEYS.forEach(key => {
    if (Array.isArray(parsed.sections?.[key])) parsed[key] = parsed.sections[key];
  });
  return parsed;
}

export async function generateResumeEditOperations(message: string, parsed: any): Promise<{ operations: EditOp[]; reply?: string; model?: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { operations: [] };
  const prompt = `${RESUME_FACT_SAFETY_RULES}

Convert this resume edit request into JSON operations only. Do not return markdown or a full resume.

Allowed paths include:
- candidateName, name, headline, title, summary, profile, professionalSummary
- skills or skills.0
- experience.0.role, experience.0.company, experience.0.location, experience.0.dates, experience.0.bullets.0
- projects.0.title, projects.0.bullets.0
- communityService.0.organization, communityService.0.role, communityService.0.bullets.0
- volunteer.0.organization, volunteer.0.role, volunteer.0.bullets.0
- volunteering.0.organization, volunteering.0.role, volunteering.0.bullets.0
- education.0.degree, awards.0, certifications.0

For broad requests like "tailor my resume", make conservative, fact-safe edits only: headline, summary/profile, skills ordering, and rewritten preview-visible bullets that highlight honest transferable skills. Never convert customer service, retail, cart handling, volunteer, or operations work into software engineering or technical infrastructure work.
For tailoring, every rewritten experience, project, volunteer, volunteering, or community-service item MUST be saved into its preview-visible bullets array. Do not place rewritten text in highlights, details, description, or any new hidden field.
Preserve candidate identity, existing employers, job titles, dates, education, awards, certifications, and project names unless the user explicitly requests changing those exact fields.
If user clarification answers are included in the request, treat specific non-blank answers as confirmed facts for this edited resume copy only. Ignore blank, skipped, uncertain, "not sure", and "I don't know" answers.

For 'make skills say X' or 'set skills to X', return operation replace, path skills, value [X]. For 'add skill X', return operation add, path skills, value X. If the user pastes a full job description, experience block, or a chunk of text to add as a job, return an operation with operation: 'add', path: 'experience', and a value object containing exactly these fields: { role, company, location, dates, bullets: [...] }. Ensure bullets is an array of strings. Return a JSON object with 'operations' array and a short, conversational 'reply' string confirming the specific change (DO NOT put any JSON or full resume text in the reply field, just a short human-readable confirmation).

Current resume JSON: ${JSON.stringify(parsed).slice(0, 9000)}
Request: ${message}`;
  const { data, model } = await generateGeminiContent({
    apiKey,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            operations: { type: 'array', items: { type: 'object', properties: { operation: { type: 'string' }, path: { type: 'string' }, value: {} }, required: ['operation', 'path'] } },
            reply: { type: 'string' },
          },
          required: ['operations'],
        },
      },
    },
  });
  try {
    return { ...JSON.parse((data.candidates?.[0]?.content?.parts?.[0]?.text || '{}').replace(/```json|```/g, '').trim()), model };
  } catch {
    return { operations: [] };
  }
}

export function applyResumeEditOperations(parsedInput: any, operations: EditOp[]) {
  return operations.reduce((parsed, op) => applyResumeEditOperation(parsed, op), copy(parsedInput));
}

export async function saveResumeParsedJson({
  supabase,
  resumeId,
  userId,
  parsed,
}: {
  supabase: ReturnType<typeof client>;
  resumeId: string;
  userId: string;
  parsed: any;
}) {
  const saved = await supabase
    .from('resumes')
    .update({ parsed_json: parsed, candidate_name: parsed.candidateName || parsed.name || null, headline: parsed.headline || parsed.title || null })
    .eq('id', resumeId)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (saved.error) throw saved.error;
  return saved.data;
}

export async function runResumeEdit({
  resumeId,
  userId,
  message,
  value,
  edit,
  billingAction,
  idempotencyKey,
  skipBilling,
}: ResumeEditInput): Promise<ResumeEditResult> {
  if (!resumeId || !userId) throw new Error('Missing resumeId or userId');

  const supabase = client();
  const loaded = await supabase.from('resumes').select('*').eq('id', resumeId).eq('user_id', userId).single();
  if (loaded.error) throw loaded.error;

  let parsed = copy(loaded.data.parsed_json || {});
  const manualEdit = edit && typeof edit === 'object' && typeof edit.path === 'string';
  const actionType: BillingAction | null = skipBilling || manualEdit
    ? null
    : isPaidBillingAction(billingAction)
      ? billingAction
      : inferResumeBillingAction(String(message || value || ''));
  const cost = actionType ? creditCostForAction(actionType) : 0;
  const chargeKey = String(idempotencyKey || `${userId}:${resumeId}:${Date.now()}:${Math.random().toString(36).slice(2)}`);

  if (actionType) {
    await assertCanRunPaidAction({ userId, actionType, cost, idempotencyKey: chargeKey });
  }

  let operations = manualEdit
    ? [edit as EditOp]
    : deterministicOps(String(message || value || ''));
  let reply = '';
  let processedBy: string | undefined;
  if (!operations.length && message) {
    const ai = await generateResumeEditOperations(String(message), parsed);
    operations = Array.isArray(ai.operations) ? ai.operations : [];
    reply = ai.reply || '';
    processedBy = ai.model;
  }
  if (!operations.length && value) operations = [{ operation: 'replace', path: 'experience.0.role', value }];
  if (!operations.length) return { handled: false, reply: 'I understood that as chat, not a saved resume edit.' };

  parsed = applyResumeEditOperations(parsed, operations);
  ensureFirstExperience(parsed);

  const saved = await supabase
    .from('resumes')
    .update({
      parsed_json: parsed,
      candidate_name: parsed.candidateName || parsed.name || loaded.data.candidate_name || null,
      headline: parsed.headline || parsed.title || loaded.data.headline || null,
    })
    .eq('id', resumeId)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (saved.error) throw saved.error;

  let billing = null;
  if (actionType) {
    billing = await recordPaidActionSuccess({
      userId,
      actionType,
      cost,
      idempotencyKey: chargeKey,
      resumeId,
    });
  }

  const count = operations.length;
  return {
    resume: saved.data,
    reply: reply || `Saved ${count} resume edit${count === 1 ? '' : 's'}. You should see the preview update now.`,
    operations,
    billing,
    processedBy,
  };
}

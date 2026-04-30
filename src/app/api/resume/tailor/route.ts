import { NextRequest, NextResponse } from 'next/server';
import {
  adminClient,
  assertCanRunPaidAction,
  creditCostForAction,
  PaymentRequiredError,
  recordPaidActionSuccess,
} from '@/lib/billing';
import { generateGeminiContent, geminiUserError } from '@/lib/gemini';
import { RESUME_FACT_SAFETY_RULES } from '@/lib/resumeFacts';

type TailorJob = {
  title?: string;
  company_name?: string;
  location?: string;
  description?: string;
};

function copy(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function cleanTitle(value?: string) {
  return String(value || '').replace(/[^\w\s.,&()/-]/g, '').replace(/\s+/g, ' ').trim();
}

function resumeText(parsed: any) {
  return JSON.stringify(parsed || {}).slice(0, 14000);
}

const SECTION_KEYS = ['experience', 'education', 'skills', 'projects', 'awards', 'certifications'] as const;
const PRESERVED_EXPERIENCE_FIELDS = ['role', 'title', 'company', 'organization', 'location', 'dates', 'date', 'duration'] as const;

function arr(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split('\n').map(line => line.trim()).filter(Boolean);
  return [];
}

function unwrapResumeObject(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (value.parsed_json && typeof value.parsed_json === 'object') return value.parsed_json;
  if (value.resume && typeof value.resume === 'object') return value.resume;
  if (value.sections || SECTION_KEYS.some(key => Array.isArray(value[key]))) return value;
  return value;
}

function getSection(parsed: any, key: string) {
  return arr(parsed?.sections?.[key] ?? parsed?.[key]);
}

function normalizeResumeJson(sourceInput: any, candidateInput: any) {
  const source = copy(unwrapResumeObject(sourceInput));
  const candidate = copy(unwrapResumeObject(candidateInput));
  const normalized: any = {
    ...source,
    ...candidate,
    sections: { ...(source.sections || {}) },
  };

  SECTION_KEYS.forEach(key => {
    const candidateSection = getSection(candidate, key);
    const sourceSection = getSection(source, key);
    normalized.sections[key] = candidateSection.length ? candidateSection : sourceSection;
    normalized[key] = normalized.sections[key];
  });

  normalized.contact = candidate.contact && typeof candidate.contact === 'object'
    ? { ...(source.contact || {}), ...candidate.contact }
    : source.contact || {};

  normalized.candidateName = candidate.candidateName || candidate.name || source.candidateName || source.name || '';
  normalized.name = normalized.candidateName || candidate.name || source.name || '';
  normalized.headline = candidate.headline || candidate.title || source.headline || source.title || '';
  normalized.title = normalized.headline || candidate.title || source.title || '';

  const sourceExperience = getSection(source, 'experience');
  if (sourceExperience.length) {
    normalized.sections.experience = getSection(normalized, 'experience')
      .slice(0, sourceExperience.length)
      .map((item: any, index: number) => {
        const sourceItem = sourceExperience[index] || {};
        const next = item && typeof item === 'object' && !Array.isArray(item) ? { ...item } : { bullets: arr(item) };
        PRESERVED_EXPERIENCE_FIELDS.forEach(field => {
          if (sourceItem[field]) next[field] = sourceItem[field];
        });
        if (!arr(next.bullets || next.highlights || next.description || next.details).length) {
          next.bullets = arr(sourceItem.bullets || sourceItem.highlights || sourceItem.description || sourceItem.details);
        }
        if (next.role && !next.title) next.title = next.role;
        if (next.title && !next.role) next.role = next.title;
        return next;
      });
    normalized.experience = normalized.sections.experience;
  }

  (['education', 'awards', 'certifications'] as const).forEach(key => {
    const sourceSection = getSection(source, key);
    if (sourceSection.length) {
      normalized.sections[key] = sourceSection;
      normalized[key] = sourceSection;
    }
  });

  const sourceProjects = getSection(source, 'projects');
  if (sourceProjects.length) {
    normalized.sections.projects = getSection(normalized, 'projects')
      .slice(0, sourceProjects.length)
      .map((item: any, index: number) => {
        const sourceItem = sourceProjects[index] || {};
        const next = item && typeof item === 'object' && !Array.isArray(item) ? { ...item } : { bullets: arr(item) };
        ['name', 'title', 'dates', 'date'].forEach(field => {
          if (sourceItem[field]) next[field] = sourceItem[field];
        });
        return next;
      });
    normalized.projects = normalized.sections.projects;
  }

  const hasMeaningfulSection = SECTION_KEYS.some(key => getSection(normalized, key).length > 0);
  if (!hasMeaningfulSection) {
    return { parsed: source, usedSourceFallback: true };
  }

  return { parsed: normalized, usedSourceFallback: false };
}

async function tailorWithGemini({
  parsed,
  job,
}: {
  parsed: any;
  job: TailorJob;
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key is not configured');

  const prompt = `${RESUME_FACT_SAFETY_RULES}

Tailor this resume JSON for the job below. Improve wording, skills ordering, summary/headline, and supported bullets to align with the job. Keep the same broad JSON structure and return valid JSON only.

Specific constraints:
- Keep all existing experience job titles, employers, locations, and dates unchanged.
- Keep education, certifications, awards, and project names unchanged unless the same fact already exists in the current resume.
- For unsupported job requirements, add them to missingKeywords instead of inserting them into experience.
- Example: HEB/customer service/cart handling work may mention customer support, teamwork, reliability, accuracy, communication, and operational support. It must not mention software engineering, production systems, infrastructure, internal systems, or data migration unless those facts already appear in that HEB role.

Return:
- tailoredResume: the complete tailored resume JSON
- score: integer 0-100 estimating match after tailoring
- summary: one short sentence
- improvements: 3-6 concise changes made
- matchedKeywords: 4-10 relevant matched keywords
- missingKeywords: 0-8 important missing keywords not honestly supported by the resume

Current resume JSON:
${resumeText(parsed)}

Job:
Title: ${job.title || 'Role'}
Company: ${job.company_name || 'Company'}
Location: ${job.location || ''}
Description:
${String(job.description || '').slice(0, 12000)}`;

  const { data, model } = await generateGeminiContent({
    apiKey,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            tailoredResume: { type: 'object' },
            score: { type: 'integer' },
            summary: { type: 'string' },
            improvements: { type: 'array', items: { type: 'string' } },
            matchedKeywords: { type: 'array', items: { type: 'string' } },
            missingKeywords: { type: 'array', items: { type: 'string' } },
          },
          required: ['tailoredResume', 'score', 'summary', 'improvements'],
        },
      },
    },
  });

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const parsedResult = JSON.parse(raw.replace(/```json|```/g, '').trim());
  return { ...parsedResult, model };
}

export async function POST(req: NextRequest) {
  try {
    const {
      userId,
      resumeId,
      job,
      idempotencyKey,
    }: {
      userId?: string;
      resumeId?: string;
      job?: TailorJob;
      idempotencyKey?: string;
    } = await req.json();

    if (!userId || !resumeId) {
      return NextResponse.json({ error: 'Missing userId or resumeId' }, { status: 400 });
    }
    if (!job?.title && !job?.description) {
      return NextResponse.json({ error: 'Missing job details' }, { status: 400 });
    }

    const actionType = 'tailor_resume' as const;
    const cost = creditCostForAction(actionType);
    const chargeKey = String(idempotencyKey || `${userId}:${resumeId}:tailor:${Date.now()}`);
    await assertCanRunPaidAction({ userId, actionType, cost, idempotencyKey: chargeKey });

    const supabase = adminClient();
    const { data: sourceResume, error: sourceError } = await supabase
      .from('resumes')
      .select('*')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .single();
    if (sourceError) throw sourceError;

    const sourceParsed = copy(sourceResume.parsed_json || {});
    const tailored = await tailorWithGemini({ parsed: sourceParsed, job });
    const { parsed: tailoredParsed, usedSourceFallback } = normalizeResumeJson(
      sourceParsed,
      tailored.tailoredResume && typeof tailored.tailoredResume === 'object' ? tailored.tailoredResume : sourceParsed,
    );

    const role = cleanTitle(job.title || 'Tailored Resume');
    const company = cleanTitle(job.company_name || '');
    const tailoredTitle = `${role}${company ? ` - ${company}` : ''} Tailored`;
    const content = JSON.stringify(tailoredParsed);
    const summary = usedSourceFallback
      ? `Created a safe tailored copy for ${role}${company ? ` at ${company}` : ''}; unsupported claims were left out.`
      : tailored.summary || `Tailored for ${role}${company ? ` at ${company}` : ''}.`;

    const { data: savedResume, error: saveError } = await supabase
      .from('resumes')
      .insert({
        user_id: userId,
        title: tailoredTitle,
        file_name: `${tailoredTitle}.pdf`,
        mime_type: 'application/pdf',
        content,
        raw_text: content,
        parsed_json: tailoredParsed,
        summary,
        candidate_name: tailoredParsed.candidateName || tailoredParsed.name || sourceResume.candidate_name || null,
        headline: tailoredParsed.headline || tailoredParsed.title || sourceResume.headline || null,
      })
      .select('*')
      .single();
    if (saveError) throw saveError;

    const billing = await recordPaidActionSuccess({
      userId,
      actionType,
      cost,
      idempotencyKey: chargeKey,
      resumeId: savedResume.id,
    });

    return NextResponse.json({
      resume: savedResume,
      score: Math.max(0, Math.min(100, Number(tailored.score || 0))),
      summary,
      improvements: Array.isArray(tailored.improvements) ? tailored.improvements : [],
      matchedKeywords: Array.isArray(tailored.matchedKeywords) ? tailored.matchedKeywords : [],
      missingKeywords: Array.isArray(tailored.missingKeywords) ? tailored.missingKeywords : [],
      downloadUrl: `/api/resumes/${encodeURIComponent(savedResume.id)}/download?userId=${encodeURIComponent(userId)}`,
      billing,
      processedBy: tailored.model,
    });
  } catch (error) {
    console.error('Failed to tailor resume:', error);
    if (error instanceof PaymentRequiredError) {
      return NextResponse.json({ error: error.message, paymentRequired: true, ...error.details }, { status: 402 });
    }
    return NextResponse.json({ error: geminiUserError(error) || 'Failed to tailor resume' }, { status: 500 });
  }
}

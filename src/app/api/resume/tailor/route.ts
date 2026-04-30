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
import { auditTailoredResume, canonicalVisibleBullets, canonicalizeTailoredResume, hasVisibleTailoringDiff } from '@/lib/resumeTailorAudit';
import { runResumeEdit } from '@/lib/resumeEdit';

type TailorJob = {
  title?: string;
  company_name?: string;
  location?: string;
  description?: string;
};

type TailorAnswer = {
  questionId: string;
  question?: string;
  answer: string;
};

type TailorQuestion = {
  id: string;
  question: string;
  reason: string;
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

function makeClarificationId() {
  return `clarify_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanQuestionId(value: unknown, index: number) {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned || `q${index + 1}`;
}

function normalizeQuestions(value: unknown): TailorQuestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item, index) => {
      const question = String(item?.question || '').replace(/\s+/g, ' ').trim();
      if (!question) return null;
      let id = cleanQuestionId(item?.id || question, index);
      if (seen.has(id)) id = `${id}_${index + 1}`;
      seen.add(id);
      return {
        id,
        question: question.slice(0, 220),
        reason: String(item?.reason || 'This fact materially affects how strongly the resume can match the role.').replace(/\s+/g, ' ').trim().slice(0, 240),
      };
    })
    .filter(Boolean)
    .slice(0, 3) as TailorQuestion[];
}

function defaultClarificationQuestions(job: TailorJob): TailorQuestion[] {
  const role = cleanTitle(job.title || 'this role') || 'this role';
  return [
    {
      id: 'relevant_experience',
      question: `Which of your existing experiences, projects, or skills are most relevant to ${role}?`,
      reason: 'This helps prioritize proven resume content without adding unsupported claims.',
    },
    {
      id: 'confirmed_tools',
      question: 'Which job-required tools, systems, or skills have you personally used and can honestly include?',
      reason: 'Only user-confirmed or resume-supported capabilities should be emphasized.',
    },
    {
      id: 'role_specific_examples',
      question: 'Are there any specific achievements, responsibilities, or examples you want reflected for this job?',
      reason: 'Specific confirmed examples make the tailored copy stronger while preserving fact safety.',
    },
  ];
}

function ensureThreeQuestions(questions: TailorQuestion[], job: TailorJob) {
  const seen = new Set<string>();
  const merged = [...questions, ...defaultClarificationQuestions(job)]
    .map((question, index) => {
      let id = cleanQuestionId(question.id || question.question, index);
      if (seen.has(id)) id = `${id}_${index + 1}`;
      seen.add(id);
      return {
        id,
        question: question.question,
        reason: question.reason,
      };
    })
    .filter(question => question.question)
    .slice(0, 3);
  return merged;
}

function normalizeAnswers(value: unknown): TailorAnswer[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({
      questionId: String(item?.questionId || '').trim(),
      question: String(item?.question || '').trim(),
      answer: String(item?.answer || '').trim(),
    }))
    .filter(item => item.questionId)
    .slice(0, 3);
}

function answerFactsText(answers: TailorAnswer[]) {
  if (!answers.length) return 'No clarification answers were supplied.';
  return answers.map(item => {
    const question = item.question ? `Question: ${item.question}\n` : '';
    const answer = item.answer || '(blank or skipped)';
    return `- ${question}Answer: ${answer}`;
  }).join('\n');
}

function buildTailoringEditInstruction({
  job,
  answers,
  visibleOnlyRetry = false,
}: {
  job: TailorJob;
  answers: TailorAnswer[];
  visibleOnlyRetry?: boolean;
}) {
  return `Tailor this resume copy for the target job using only supported facts.

Target job:
Title: ${job.title || 'Role'}
Company: ${job.company_name || 'Company'}
Location: ${job.location || ''}
Description:
${String(job.description || '').slice(0, 12000)}

User clarification answers:
${answerFactsText(answers)}

Instructions:
- Rewrite preview-visible summary/profile text, skills ordering, and existing bullets to emphasize honest fit for the job.
- Put all rewritten responsibility or achievement text in preview-visible bullets arrays only.
- Keep candidate name, employers, job titles, dates, education, awards, certifications, and project names unchanged.
- Do not add unsupported claims. If a requirement is unsupported, leave it out.
- Use specific non-blank clarification answers where relevant. Ignore blank, skipped, uncertain, or "I don't know" answers.
${visibleOnlyRetry ? '- Retry because the first saved copy did not visibly change: rewrite only summary/profile, skills, and preview-visible bullets. Preserve every identity, employer, title, date, education, and project-name field exactly.' : ''}`;
}

const SECTION_KEYS = ['experience', 'education', 'skills', 'projects', 'awards', 'certifications', 'communityService'] as const;
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

function normalizedText(value: unknown) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isPlaceholder(value: unknown) {
  return ['company', 'organization', 'employer', 'school', 'institution', 'project', 'role', 'job title'].includes(normalizedText(value));
}

function useful(value: unknown) {
  const text = String(value || '').trim();
  return text && !isPlaceholder(text) ? text : '';
}

function parseOrgLocation(prefix: string) {
  const cleaned = prefix.replace(/\s+/g, ' ').trim();
  const comma = cleaned.match(/^(.+?)\s+([^,\s]+)\s*,\s*([A-Za-z][A-Za-z\s.]*)$/);
  if (!comma) return { organization: cleaned, location: '' };

  const beforeCity = comma[1].trim().split(' ');
  let city = comma[2].trim();
  if (beforeCity.length > 1 && ['fort', 'new', 'san', 'los', 'las'].includes(beforeCity[beforeCity.length - 1].toLowerCase())) {
    city = `${beforeCity.pop()} ${city}`;
  }
  const organization = beforeCity.join(' ').trim() || cleaned;
  const state = comma[3].replace(/\s+/g, ' ').trim();
  return { organization, location: `${city}, ${state}` };
}

function enrichExperienceFromRawText(parsedInput: any, rawText?: string | null) {
  const parsed = copy(parsedInput || {});
  const lines = String(rawText || '').split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const experience = getSection(parsed, 'experience');
  if (!experience.length || !lines.length) return parsed;

  parsed.sections = parsed.sections || {};
  parsed.sections.experience = experience.map((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const role = normalizedText(item.role || item.title || item.name);
    if (!role) return item;

    const sourceLine = lines.find(line => {
      const normalized = normalizedText(line);
      return normalized.includes(role) && /[-–—]/.test(line);
    });
    if (!sourceLine) return item;

    const [prefix] = sourceLine.split(/[-–—]/);
    const { organization, location } = parseOrgLocation(prefix);
    return {
      ...item,
      company: useful(item.company) || useful(item.organization) || organization,
      location: useful(item.location) || location,
    };
  });
  parsed.experience = parsed.sections.experience;
  return parsed;
}

function normalizeResumeJson(sourceInput: any, candidateInput: any) {
  const source = copy(unwrapResumeObject(sourceInput));
  const candidate = canonicalizeTailoredResume(source, unwrapResumeObject(candidateInput));
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

  normalized.contact = source.contact || {};
  normalized.candidateName = source.candidateName || source.name || candidate.candidateName || candidate.name || '';
  normalized.name = source.name || normalized.candidateName || '';
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
        next.bullets = canonicalVisibleBullets(next, sourceItem);
        if (next.role && !next.title) next.title = next.role;
        if (next.title && !next.role) next.role = next.title;
        delete next.highlights;
        delete next.details;
        delete next.description;
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

  const sourceService = [
    ...getSection(source, 'communityService'),
    ...getSection(source, 'volunteer'),
    ...getSection(source, 'volunteering'),
  ];
  if (sourceService.length) {
    const candidateService = [
      ...getSection(normalized, 'communityService'),
      ...getSection(normalized, 'volunteer'),
      ...getSection(normalized, 'volunteering'),
    ];
    normalized.sections.communityService = candidateService.length ? candidateService : sourceService;
    normalized.communityService = normalized.sections.communityService;
  }

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
        next.bullets = canonicalVisibleBullets(next, sourceItem);
        delete next.highlights;
        delete next.details;
        if (next.bullets.length) delete next.description;
        return next;
      });
    normalized.projects = normalized.sections.projects;
  }

  const hasMeaningfulSection = SECTION_KEYS.some(key => getSection(normalized, key).length > 0);
  if (!hasMeaningfulSection) {
    return { parsed: source, usedSourceFallback: true };
  }

  return { parsed: canonicalizeTailoredResume(source, normalized), usedSourceFallback: false };
}

async function tailorWithGemini({
  parsed,
  job,
  answers,
  visibleOnlyRetry = false,
}: {
  parsed: any;
  job: TailorJob;
  answers?: TailorAnswer[];
  visibleOnlyRetry?: boolean;
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key is not configured');

  const prompt = `${RESUME_FACT_SAFETY_RULES}

Tailor this resume JSON for the job below. Improve wording, skills ordering, summary/headline, and supported bullets to align with the job. Keep the same broad JSON structure and return valid JSON only.

Specific constraints:
- Keep all existing experience job titles, employers, locations, and dates unchanged.
- Keep education, certifications, awards, and project names unchanged unless the same fact already exists in the current resume.
- For unsupported job requirements, add them to missingKeywords instead of inserting them into experience.
- User clarification answers are confirmed facts for this tailored resume copy only. Use them only where they are specific, relevant, and not blank or "I don't know".
- If a clarification answer is blank, skipped, uncertain, or says "I don't know", do not invent the related fact. Create a conservative resume and list the unsupported keyword or requirement in missingKeywords.
- Example: HEB/customer service/cart handling work may mention customer support, teamwork, reliability, accuracy, communication, and operational support. It must not mention software engineering, production systems, infrastructure, internal systems, or data migration unless those facts already appear in that HEB role.
- For non-technical leadership, service, or operations roles, supported clarification facts may be placed in visible bullets. Six Flags lead work may mention task assignment, schedule coordination, team direction, operational support, and guest assistance when confirmed. Trumpet instruction may mention mentoring, teaching practice methods, and supporting student development when confirmed. Volunteer/admin work may mention event or program support, service coordination, and communication when confirmed.
- Make the tailored resume visibly different in supported places: rewrite existing experience bullets for relevance, improve the profile/summary, and reorder or add honest skills supported by the resume.
- All rewritten item text MUST be written into preview-visible "bullets" arrays. Do not put rewritten item text only in "highlights", "details", or "description".
- Do not add a "Key Responsibilities" section copied from the job description.
- For entry-level customer service/sales roles, honestly emphasize customer assistance, guest support, communication, adaptability, fast-paced service, teamwork, technology comfort if supported by projects/web design, willingness to learn, and growth mindset.
- Every improvement must describe a change that is actually present in tailoredResume.
${visibleOnlyRetry ? '- Retry instruction: the prior output did not visibly change the preview. Rewrite only the preview-visible profile/summary, skills ordering, and bullets arrays. Preserve names, employers, job titles, dates, education, and project names exactly.' : ''}

Return:
- tailoredResume: the complete tailored resume JSON
- score: integer 0-100 estimating match after tailoring
- summary: one short sentence
- improvements: 3-6 concise changes made
- matchedKeywords: 4-10 relevant matched keywords
- missingKeywords: 0-8 important missing keywords not honestly supported by the resume

Current resume JSON:
${resumeText(parsed)}

User-confirmed clarification answers:
${answerFactsText(answers || [])}

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

async function clarifyWithGemini({
  parsed,
  job,
}: {
  parsed: any;
  job: TailorJob;
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key is not configured');

  const prompt = `${RESUME_FACT_SAFETY_RULES}

Inspect the resume facts and target job before resume tailoring. Return exactly 3 short-answer clarification questions before generating a tailored resume.

Rules:
- Ask exactly 3 short-answer questions.
- Ask only for facts that materially affect tailoring and are not already proven by the resume.
- For frontend, web design, software engineering, full-stack, or technical jobs, prioritize project facts such as alu.pics stack, frontend features, backend/API/database/auth/deployment, and what the user personally built.
- For non-technical jobs, ask no technical questions; ask about directly relevant service, operations, communication, sales, leadership, scheduling, safety, or customer-support facts as appropriate.
- Even if the resume already provides enough honest support for the role, still ask 3 optional questions that could safely improve the tailored copy.
- Do not ask for metrics, tools, responsibilities, or credentials unless the job materially depends on them.
- Questions must be answerable in one or two sentences.
- Blank or uncertain answers are allowed and will be ignored later.

Return JSON with:
- needsClarification: true
- questions: exactly 3 objects with id, question, reason

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
            needsClarification: { type: 'boolean' },
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  question: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['id', 'question', 'reason'],
              },
            },
          },
          required: ['needsClarification', 'questions'],
        },
      },
    },
  });

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const parsedResult = JSON.parse(raw.replace(/```json|```/g, '').trim());
  const questions = ensureThreeQuestions(normalizeQuestions(parsedResult.questions), job);
  return {
    needsClarification: true,
    questions,
    model,
  };
}

export async function POST(req: NextRequest) {
  try {
    const {
      userId,
      resumeId,
      job,
      answers,
      clarificationId,
      idempotencyKey,
    }: {
      userId?: string;
      resumeId?: string;
      job?: TailorJob;
      answers?: TailorAnswer[];
      clarificationId?: string;
      idempotencyKey?: string;
    } = await req.json();

    if (!userId || !resumeId) {
      return NextResponse.json({ error: 'Missing userId or resumeId' }, { status: 400 });
    }
    if (!job?.title && !job?.description) {
      return NextResponse.json({ error: 'Missing job details' }, { status: 400 });
    }

    const supabase = adminClient();
    const { data: sourceResume, error: sourceError } = await supabase
      .from('resumes')
      .select('*')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .single();
    if (sourceError) throw sourceError;

    const sourceParsed = enrichExperienceFromRawText(sourceResume.parsed_json || {}, sourceResume.raw_text || sourceResume.content);
    const normalizedAnswers = normalizeAnswers(answers);

    if (!clarificationId) {
      const clarification = await clarifyWithGemini({ parsed: sourceParsed, job });
      return NextResponse.json({
        needsClarification: true,
        clarificationId: makeClarificationId(),
        questions: ensureThreeQuestions(clarification.questions, job),
        processedBy: clarification.model,
      });
    }

    const actionType = 'tailor_resume' as const;
    const cost = creditCostForAction(actionType);
    const chargeKey = String(idempotencyKey || `${userId}:${resumeId}:tailor:${Date.now()}`);
    await assertCanRunPaidAction({ userId, actionType, cost, idempotencyKey: chargeKey });

    const role = cleanTitle(job.title || 'Tailored Resume');
    const company = cleanTitle(job.company_name || '');
    const tailoredTitle = `${role}${company ? ` - ${company}` : ''} Tailored`;
    const fallbackSummary = `Tailored for ${role}${company ? ` at ${company}` : ''}.`;

    const initialContent = JSON.stringify(sourceParsed);
    const { data: copiedResume, error: copyError } = await supabase
      .from('resumes')
      .insert({
        user_id: userId,
        title: tailoredTitle,
        file_name: `${tailoredTitle}.pdf`,
        mime_type: 'application/pdf',
        content: initialContent,
        raw_text: sourceResume.raw_text || sourceResume.content || initialContent,
        parsed_json: sourceParsed,
        summary: sourceResume.summary || sourceParsed.summary || sourceParsed.profile || fallbackSummary,
        candidate_name: sourceParsed.candidateName || sourceParsed.name || sourceResume.candidate_name || null,
        headline: sourceParsed.headline || sourceParsed.title || sourceResume.headline || null,
      })
      .select('*')
      .single();
    if (copyError) throw copyError;

    let editResult = await runResumeEdit({
      resumeId: copiedResume.id,
      userId,
      message: buildTailoringEditInstruction({ job, answers: normalizedAnswers }),
      billingAction: null,
      idempotencyKey: `${chargeKey}:edit`,
      skipBilling: true,
    });

    let editedResume: any = editResult.resume || copiedResume;
    let editedParsed = editedResume.parsed_json || sourceParsed;

    if (!hasVisibleTailoringDiff(sourceParsed, editedParsed)) {
      editResult = await runResumeEdit({
        resumeId: copiedResume.id,
        userId,
        message: buildTailoringEditInstruction({ job, answers: normalizedAnswers, visibleOnlyRetry: true }),
        billingAction: null,
        idempotencyKey: `${chargeKey}:edit:retry`,
        skipBilling: true,
      });
      editedResume = editResult.resume || editedResume;
      editedParsed = editedResume.parsed_json || editedParsed;
    }

    let normalized = normalizeResumeJson(sourceParsed, editedParsed);
    let audited = auditTailoredResume({
      sourceParsed,
      tailoredParsed: normalized.parsed,
      job,
      answers: normalizedAnswers,
      gemini: {
        score: hasVisibleTailoringDiff(sourceParsed, normalized.parsed) ? 82 : 45,
        matchedKeywords: [],
        missingKeywords: [],
      },
      fallbackSummary: normalized.usedSourceFallback
        ? `Created a safe tailored copy for ${role}${company ? ` at ${company}` : ''}; unsupported claims were left out.`
        : fallbackSummary,
    });

    const hasVisibleDiff = hasVisibleTailoringDiff(sourceParsed, audited.parsed);
    if (!hasVisibleDiff) {
      audited = {
        ...audited,
        summary: `Created a conservative copy for ${role}${company ? ` at ${company}` : ''}; unsupported claims were left out.`,
        improvements: [],
      };
      audited.parsed.summary = audited.summary;
      audited.parsed.profile = audited.summary;
      normalized.usedSourceFallback = true;
    }

    const tailoredParsed = audited.parsed;
    const content = JSON.stringify(tailoredParsed);
    const summary = audited.summary;

    const { data: savedResume, error: saveError } = await supabase
      .from('resumes')
      .update({
        content,
        raw_text: content,
        parsed_json: tailoredParsed,
        summary,
        candidate_name: tailoredParsed.candidateName || tailoredParsed.name || sourceResume.candidate_name || null,
        headline: tailoredParsed.headline || tailoredParsed.title || sourceResume.headline || null,
      })
      .eq('id', copiedResume.id)
      .eq('user_id', userId)
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
      needsClarification: false,
      resume: savedResume,
      score: audited.score,
      summary,
      improvements: audited.improvements,
      matchedKeywords: audited.matchedKeywords,
      missingKeywords: audited.missingKeywords,
      downloadUrl: `/api/resumes/${encodeURIComponent(savedResume.id)}/download?userId=${encodeURIComponent(userId)}`,
      billing,
      processedBy: editResult.processedBy,
    });
  } catch (error) {
    console.error('Failed to tailor resume:', error);
    if (error instanceof PaymentRequiredError) {
      return NextResponse.json({ error: error.message, paymentRequired: true, ...error.details }, { status: 402 });
    }
    return NextResponse.json({ error: geminiUserError(error) || 'Failed to tailor resume' }, { status: 500 });
  }
}

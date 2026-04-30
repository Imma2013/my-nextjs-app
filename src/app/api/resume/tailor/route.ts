import { NextRequest, NextResponse } from 'next/server';
import {
  adminClient,
  assertCanRunPaidAction,
  creditCostForAction,
  PaymentRequiredError,
  recordPaidActionSuccess,
} from '@/lib/billing';
import { generateGeminiContent, geminiUserError } from '@/lib/gemini';

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

async function tailorWithGemini({
  parsed,
  job,
}: {
  parsed: any;
  job: TailorJob;
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key is not configured');

  const prompt = `Tailor this resume JSON for the job below without inventing employers, degrees, dates, certifications, or experience. Improve wording, skills ordering, summary/headline, and bullets to align with the job. Keep the same broad JSON structure and return valid JSON only.

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
    const tailoredParsed = tailored.tailoredResume && typeof tailored.tailoredResume === 'object'
      ? tailored.tailoredResume
      : sourceParsed;

    const role = cleanTitle(job.title || 'Tailored Resume');
    const company = cleanTitle(job.company_name || '');
    const tailoredTitle = `${role}${company ? ` - ${company}` : ''} Tailored`;
    const content = JSON.stringify(tailoredParsed);

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
        summary: tailored.summary || `Tailored for ${role}${company ? ` at ${company}` : ''}.`,
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
      summary: tailored.summary || 'Created a tailored resume copy.',
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

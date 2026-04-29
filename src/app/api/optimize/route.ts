import { NextRequest, NextResponse } from 'next/server';
import {
  assertCanRunPaidAction,
  creditCostForAction,
  PaymentRequiredError,
  recordPaidActionSuccess,
} from '@/lib/billing';

const GEMINI_MODEL = 'gemini-2.5-flash';

export async function POST(req: NextRequest) {
  try {
    const { resume, jobDescription, userId, idempotencyKey } = await req.json();
    if (!resume || !jobDescription)
      return NextResponse.json({ error: 'Missing resume or job description' }, { status: 400 });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'API key not configured' }, { status: 500 });

    const actionType = 'resume_optimizer' as const;
    const cost = creditCostForAction(actionType);
    const chargeKey = String(idempotencyKey || `${userId || 'anonymous'}:optimizer:${Date.now()}:${Math.random().toString(36).slice(2)}`);
    if (userId) {
      await assertCanRunPaidAction({ userId, actionType, cost, idempotencyKey: chargeKey });
    }

    const prompt = `You are an expert resume coach and ATS specialist. Analyze the resume against the job description and respond ONLY with valid JSON (no markdown, no backticks, no extra text).

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Respond with this exact JSON structure:
{
  "score": <integer 0-100>,
  "strengths": [<3-5 specific strengths>],
  "gaps": [<3-5 specific gaps>],
  "suggestions": [<4-6 concrete suggestions>],
  "optimized_summary": "<3-4 sentence rewritten summary tailored to this job>"
}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Save to Supabase if userId provided
    if (userId) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseUrl && serviceKey) {
        const saveResponse = await fetch(`${supabaseUrl}/rest/v1/optimizations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            user_id: userId,
            job_description: jobDescription,
            score: parsed.score,
            strengths: parsed.strengths,
            gaps: parsed.gaps,
            suggestions: parsed.suggestions,
            optimized_summary: parsed.optimized_summary,
          }),
        });

        if (!saveResponse.ok) throw new Error('Failed to save optimization');
        await recordPaidActionSuccess({ userId, actionType, cost, idempotencyKey: chargeKey });
      }
    }

    return NextResponse.json(parsed);
  } catch (e) {
    console.error(e);
    if (e instanceof PaymentRequiredError) {
      return NextResponse.json({ error: e.message, paymentRequired: true, ...e.details }, { status: 402 });
    }
    return NextResponse.json({ error: 'Failed to analyze resume' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { resume, jobDescription } = await req.json();

    if (!resume || !jobDescription) {
      return NextResponse.json({ error: 'Missing resume or job description' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'API key not configured' }, { status: 500 });
    }

    const prompt = `You are an expert resume coach and ATS specialist. Analyze the resume against the job description and respond ONLY with valid JSON (no markdown, no backticks).

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Respond with this exact JSON structure:
{
  "score": <integer 0-100 representing how well the resume matches the job>,
  "strengths": [<3-5 specific things the resume already does well for this role>],
  "gaps": [<3-5 specific missing skills, keywords, or experiences>],
  "suggestions": [<4-6 concrete, actionable rewrites or additions>],
  "optimized_summary": "<A rewritten 3-4 sentence professional summary tailored to this specific job>"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    return NextResponse.json(parsed);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to analyze resume' }, { status: 500 });
  }
}
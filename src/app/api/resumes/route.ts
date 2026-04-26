import { NextRequest, NextResponse } from 'next/server';

function headers(key: string) {
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: 'return=representation',
  };
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const userId = formData.get('userId')?.toString();
    const sessionId = formData.get('sessionId')?.toString();

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const parseForm = new FormData();
    parseForm.append('file', file);
    const parsedRes = await fetch(new URL('/api/parse-resume', req.url), { method: 'POST', body: parseForm });
    const parsedData = await parsedRes.json();
    if (!parsedRes.ok) return NextResponse.json(parsedData, { status: parsedRes.status });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 500 });

    const parsed = parsedData.parsed || {};
    const candidateName = parsedData.candidateName || parsed.candidateName || '';
    const title = candidateName ? `${candidateName}'s Resume` : file.name.replace(/\.(pdf|docx)$/i, '') || 'Uploaded Resume';
    const rawText = parsedData.text || parsed.resumeText || '';

    const resumeRes = await fetch(`${supabaseUrl}/rest/v1/resumes`, {
      method: 'POST',
      headers: headers(serviceKey),
      body: JSON.stringify({
        user_id: userId,
        title,
        file_name: file.name,
        content: rawText,
        raw_text: rawText,
        parsed_json: parsed,
        summary: parsedData.summary || parsed.summary || 'Resume parsed by Gemini.',
        candidate_name: candidateName || null,
        headline: parsedData.headline || parsed.headline || null,
      }),
    });
    if (!resumeRes.ok) throw new Error(await resumeRes.text());
    const resume = (await resumeRes.json())?.[0];
    if (!resume?.id) throw new Error('Failed to save resume');

    let session = null;
    if (sessionId) {
      const updateRes = await fetch(`${supabaseUrl}/rest/v1/chat_sessions?id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: headers(serviceKey),
        body: JSON.stringify({ resume_id: resume.id }),
      });
      if (updateRes.ok) session = (await updateRes.json())?.[0] ?? null;
    }
    if (!session) {
      const sessionRes = await fetch(`${supabaseUrl}/rest/v1/chat_sessions`, {
        method: 'POST',
        headers: headers(serviceKey),
        body: JSON.stringify({ user_id: userId, title, resume_id: resume.id }),
      });
      if (!sessionRes.ok) throw new Error(await sessionRes.text());
      session = (await sessionRes.json())?.[0];
    }

    return NextResponse.json({ resume, session, sessionId: session.id, message: `I received ${file.name} and saved it as resume context. ${resume.summary || ''}`.trim() });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save resume' }, { status: 500 });
  }
}

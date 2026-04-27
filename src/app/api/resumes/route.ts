import { NextRequest, NextResponse } from 'next/server';

const BUCKET = 'resume-files';

function restHeaders(key: string, contentType = 'application/json') {
  return {
    'Content-Type': contentType,
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: 'return=representation',
  };
}

function getExt(file: File) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  return 'bin';
}

async function createSignedUrl(baseUrl: string, key: string, path: string) {
  const res = await fetch(`${baseUrl}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: restHeaders(key),
    body: JSON.stringify({ expiresIn: 60 * 60 }),
  });
  if (!res.ok) return '';
  const data = await res.json();
  const signedURL = data.signedURL || data.signedUrl || '';
  return signedURL ? `${baseUrl}/storage/v1${signedURL}` : '';
}

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 500 });

    const res = await fetch(`${supabaseUrl}/rest/v1/resumes?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`, {
      method: 'GET',
      headers: restHeaders(serviceKey),
    });

    if (!res.ok) throw new Error(await res.text());
    const resumes = await res.json();
    return NextResponse.json({ resumes });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to fetch resumes' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const resumeId = req.nextUrl.searchParams.get('resumeId');
    const userId = req.nextUrl.searchParams.get('userId');
    if (!resumeId || !userId) return NextResponse.json({ error: 'Missing resumeId or userId' }, { status: 400 });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 500 });

    const res = await fetch(`${supabaseUrl}/rest/v1/resumes?id=eq.${encodeURIComponent(resumeId)}&user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: restHeaders(serviceKey),
    });

    if (!res.ok) throw new Error(await res.text());
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to delete resume' }, { status: 500 });
  }
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
    const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const storagePath = `${userId}/${crypto.randomUUID()}.${getExt(file)}`;

    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': mimeType,
        'x-upsert': 'true',
      },
      body: Buffer.from(await file.arrayBuffer()),
    });
    if (!uploadRes.ok) throw new Error(await uploadRes.text());

    const previewUrl = mimeType === 'application/pdf' ? await createSignedUrl(supabaseUrl, serviceKey, storagePath) : '';

    const resumeRes = await fetch(`${supabaseUrl}/rest/v1/resumes`, {
      method: 'POST',
      headers: restHeaders(serviceKey),
      body: JSON.stringify({
        user_id: userId,
        title,
        file_name: file.name,
        storage_path: storagePath,
        mime_type: mimeType,
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
    resume.preview_url = previewUrl;

    let session = null;
    if (sessionId) {
      const updateRes = await fetch(`${supabaseUrl}/rest/v1/chat_sessions?id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ resume_id: resume.id }),
      });
      if (updateRes.ok) session = (await updateRes.json())?.[0] ?? null;
    }
    if (!session) {
      const sessionRes = await fetch(`${supabaseUrl}/rest/v1/chat_sessions`, {
        method: 'POST',
        headers: restHeaders(serviceKey),
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

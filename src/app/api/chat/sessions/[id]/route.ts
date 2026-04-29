import { NextRequest, NextResponse } from 'next/server';

function getSupabaseConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

async function supabaseFetch(path: string, init: RequestInit = {}) {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase is not configured');

  return fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      ...(init.headers || {}),
    },
  });
}

type RouteContext = { params: { id: string } };

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const sessionResponse = await supabaseFetch(
      `chat_sessions?id=eq.${encodeURIComponent(params.id)}&user_id=eq.${encodeURIComponent(userId)}&select=*,resumes(id,title,file_name,summary,candidate_name,headline,parsed_json)`,
      { method: 'GET' }
    );
    if (!sessionResponse.ok) throw new Error(await sessionResponse.text());

    const sessions = await sessionResponse.json();
    const session = sessions?.[0];
    if (!session) return NextResponse.json({ error: 'Chat session not found' }, { status: 404 });

    let messagesResponse = await supabaseFetch(
      `chat_messages?session_id=eq.${encodeURIComponent(params.id)}&user_id=eq.${encodeURIComponent(userId)}&select=role,content,parts,created_at&order=created_at.asc`,
      { method: 'GET' }
    );
    if (!messagesResponse.ok) {
      messagesResponse = await supabaseFetch(
        `chat_messages?session_id=eq.${encodeURIComponent(params.id)}&user_id=eq.${encodeURIComponent(userId)}&select=role,content,created_at&order=created_at.asc`,
        { method: 'GET' }
      );
    }
    if (!messagesResponse.ok) throw new Error(await messagesResponse.text());

    const messages = await messagesResponse.json();
    return NextResponse.json({ session, messages });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to load chat' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const response = await supabaseFetch(
      `chat_sessions?id=eq.${encodeURIComponent(params.id)}&user_id=eq.${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );

    if (!response.ok) throw new Error(await response.text());
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to delete chat' }, { status: 500 });
  }
}

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
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
}

function makeChatTitle(content: string) {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 48 ? `${compact.slice(0, 48)}...` : compact || 'New chat';
}

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const response = await supabaseFetch(
      `chat_sessions?user_id=eq.${encodeURIComponent(userId)}&select=*,resumes(id,title,file_name,summary,candidate_name,headline)&order=updated_at.desc`,
      { method: 'GET' }
    );

    if (!response.ok) throw new Error(await response.text());
    const sessions = await response.json();
    return NextResponse.json({ sessions });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to load chat sessions' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId, title } = await req.json();
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const response = await supabaseFetch('chat_sessions', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, title: makeChatTitle(title || 'New chat') }),
    });

    if (!response.ok) throw new Error(await response.text());
    const rows = await response.json();
    return NextResponse.json({ session: rows?.[0] });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to create chat session' }, { status: 500 });
  }
}

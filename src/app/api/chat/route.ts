import { NextRequest, NextResponse } from 'next/server';

const GEMINI_MODEL = 'gemini-3-flash-preview';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

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

async function createSession(userId: string, firstMessage: string) {
  const response = await supabaseFetch('chat_sessions', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, title: makeChatTitle(firstMessage) }),
  });

  if (!response.ok) throw new Error('Failed to create chat session');
  const rows = await response.json();
  return rows?.[0];
}

async function getSession(sessionId: string, userId: string) {
  const response = await supabaseFetch(
    `chat_sessions?id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${encodeURIComponent(userId)}&select=*`,
    { method: 'GET' }
  );

  if (!response.ok) throw new Error('Failed to load chat session');
  const rows = await response.json();
  return rows?.[0] ?? null;
}

async function saveMessages(sessionId: string, userId: string, userMessage: ChatMessage, assistantMessage: ChatMessage) {
  const response = await supabaseFetch('chat_messages', {
    method: 'POST',
    body: JSON.stringify([
      { session_id: sessionId, user_id: userId, role: userMessage.role, content: userMessage.content },
      { session_id: sessionId, user_id: userId, role: assistantMessage.role, content: assistantMessage.content },
    ]),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to save chat messages: ${detail}`);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { messages, userId, sessionId } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Missing messages' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'API key not configured' }, { status: 500 });

    const contents = messages.map((m: ChatMessage) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: 'You are an expert resume coach and career advisor. Help users improve their resumes, prepare for interviews, find jobs, and advance their careers. Be concise, practical, and encouraging.' }],
          },
          contents,
        }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Sorry, no response generated.';
    let activeSessionId = sessionId as string | undefined;

    if (userId && getSupabaseConfig()) {
      const lastUser = messages[messages.length - 1] as ChatMessage;
      const existingSession = activeSessionId ? await getSession(activeSessionId, userId) : null;
      const session = existingSession ?? await createSession(userId, lastUser.content);
      activeSessionId = session.id;

      if (!activeSessionId) {
        throw new Error('Failed to create chat session');
      }

      await saveMessages(
        activeSessionId,
        userId,
        { role: 'user', content: lastUser.content },
        { role: 'assistant', content: reply }
      );
    }

    return NextResponse.json({ reply, sessionId: activeSessionId });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Chat failed' }, { status: 500 });
  }
}

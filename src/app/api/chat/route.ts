import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const GEMINI_MODEL = 'gemini-3-flash-preview';

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Database is not configured');
  return createClient(url, key);
}

const RESUME_EDITING_TOOLS = [
  {
    name: 'edit_resume',
    description: 'Edit, update, or add to any part of the resume. Pass a clear instruction detailing what should be added, changed, or deleted.',
    parameters: {
      type: 'object',
      properties: {
        resume_id: { type: 'string', description: 'The ID of the resume' },
        instruction: { type: 'string', description: 'A natural language instruction of what to do (e.g. "change job title to Manager", "add this text to the summary", "add a new experience entry with role X and company Y")' },
      },
      required: ['resume_id', 'instruction'],
    },
  }
];

export async function POST(req: NextRequest) {
  try {
    const { messages, resume_id, userId, sessionId } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'API key not configured' }, { status: 500 });

    const supabase = client();
    let sid = sessionId;

    if (userId) {
      if (!sid && messages.length > 0) {
        const firstUserMsg = messages.find((m: any) => m.role === 'user')?.content || 'New Chat';
        const title = firstUserMsg.length > 48 ? firstUserMsg.slice(0, 48) + '...' : firstUserMsg;
        const { data: newSession, error: sErr } = await supabase.from('chat_sessions').insert({ user_id: userId, title, resume_id: resume_id || null }).select().single();
        if (!sErr && newSession) sid = newSession.id;
      }

      if (sid && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'user') {
          await supabase.from('chat_messages').insert({ session_id: sid, user_id: userId, role: 'user', content: lastMsg.content });
        }
      }
    }

    const contents = messages.map((m: { role: string; content: string }) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    let systemPrompt = 'You are an expert resume coach and career advisor. Help users improve their resumes, prepare for interviews, and advance their careers. Be concise, practical, and encouraging. NEVER print or output raw JSON, HTML, or full resume text in your response; always speak conversationally.';
    
    if (resume_id) {
      try {
        const supabase = client();
        const { data: resume } = await supabase.from('resumes').select('parsed_json').eq('id', resume_id).single();
        if (resume?.parsed_json) {
          systemPrompt += `\n\nHere is the user's current resume in JSON format:\n${JSON.stringify(resume.parsed_json)}`;
        }
      } catch (err) {
        console.error('Failed to load active resume context:', err);
      }
      
      systemPrompt += `\n\nThe user has an active resume (ID: ${resume_id}). You have tools to edit it. When the user asks you to make changes (e.g., "change my job title to X", "add a bullet about Y"), use the editing tools to update the resume in real-time. Do not paste the full resume content back to the user. Respond with a short confirmation message only.`;
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools: resume_id ? [{ functionDeclarations: RESUME_EDITING_TOOLS }] : undefined,
        }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Check for function calls
    const functionCalls = parts.filter((p: any) => p.functionCall);
    if (functionCalls.length > 0) {
      // Execute function calls
      const results = await Promise.all(
        functionCalls.map(async (fc: any) => {
          const { name, args } = fc.functionCall;
          return await executeTool(name, args, userId);
        })
      );

      // Return success message
      const toolReply = `✅ Updated! ${results.map(r => r.message).join(' ')}`;
      if (userId && sid) {
        await supabase.from('chat_messages').insert({ session_id: sid, user_id: userId, role: 'assistant', content: toolReply });
      }
      return NextResponse.json({
        reply: toolReply,
        sessionId: sid,
        tool_calls: functionCalls.map((fc: any) => fc.functionCall.name),
      });
    }

    const reply = parts.find((p: any) => p.text)?.text ?? 'Sorry, no response generated.';
    
    if (userId && sid) {
      await supabase.from('chat_messages').insert({ session_id: sid, user_id: userId, role: 'assistant', content: reply });
    }

    return NextResponse.json({ reply, sessionId: sid });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: 'Chat failed: ' + e.message }, { status: 500 });
  }
}

async function executeTool(name: string, args: any, userId: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  if (name === 'edit_resume') {
    const res = await fetch(`${baseUrl}/api/resume-edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: args.resume_id, userId, message: args.instruction }),
    });
    const data = await res.json();
    return { success: res.ok, message: data.reply || 'Resume updated successfully' };
  }

  return { success: false, message: 'Unknown tool' };
}
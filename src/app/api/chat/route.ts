import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import { Composio } from '@composio/core';
import { VercelProvider } from '@composio/vercel';

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Database is not configured');
  return createClient(url, key);
}

const composio = new Composio({ provider: new VercelProvider() });

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

    let systemPrompt = 'You are an expert resume coach and career advisor. You also have access to 1000+ real-world tools via Composio. You can use these tools to help the user directly (e.g. "email my resume to X", "check my GitHub repos", "save a draft to Notion"). Always be helpful, concise, and professional.';
    
    if (resume_id) {
      try {
        const { data: resume } = await supabase.from('resumes').select('parsed_json').eq('id', resume_id).single();
        if (resume?.parsed_json) {
          systemPrompt += `\n\nHere is the user's current resume in JSON format:\n${JSON.stringify(resume.parsed_json)}`;
        }
      } catch (err) {
        console.error('Failed to load active resume context:', err);
      }
      
      systemPrompt += `\n\nThe user has an active resume (ID: ${resume_id}). When the user asks you to make changes to their resume, you MUST use the "edit_resume" tool provided. Provide clear instructions to the tool, such as "Change the job title to Manager" or "Add a new experience block for Software Engineer at Tech Corp".`;
    }

    // Set up Composio Session scoped to user (or 'anonymous')
    const session = await composio.create(userId || "anonymous");
    const composioTools = await session.tools();

    // Define custom local tools
    const customTools = {
      edit_resume: {
        description: 'Edit, update, or add to any part of the user\'s resume. Pass a clear natural language instruction detailing what should be added, changed, or deleted.',
        parameters: z.object({
          resume_id: z.string().describe('The ID of the resume'),
          instruction: z.string().describe('A natural language instruction of what to do (e.g. "change job title to Manager", "add this text to the summary")'),
        }),
        execute: async (args: { resume_id: string; instruction: string }) => {
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
          const res = await fetch(`${baseUrl}/api/resume-edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resumeId: args.resume_id, userId, message: args.instruction }),
          });
          const data = await res.json();
          return { success: res.ok, reply: data.reply || 'Resume updated successfully' };
        },
      },
    };

    const combinedTools = { ...composioTools, ...customTools } as any;

    // Use AI SDK
    const result = await generateText({
      model: google('gemini-3-flash-preview'),
      system: systemPrompt,
      messages: messages.map((m: any) => ({ role: m.role, content: m.content })),
      tools: combinedTools,
    });

    let toolReply = '';
    if (result.toolResults && result.toolResults.length > 0) {
      const resultsArray = result.toolResults.map(r => JSON.stringify(r));
      toolReply = `\n\n[Action Taken: ${resultsArray.join(', ')}]`;
    }

    const reply = result.text + toolReply;

    if (userId && sid) {
      await supabase.from('chat_messages').insert({ session_id: sid, user_id: userId, role: 'assistant', content: reply });
    }

    return NextResponse.json({ reply, sessionId: sid });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: 'Chat failed: ' + e.message }, { status: 500 });
  }
}

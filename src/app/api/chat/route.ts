import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  convertToModelMessages,
  generateId,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { Composio } from '@composio/core';
import { VercelProvider } from '@composio/vercel';

type ChatMessage = UIMessage<{ sessionId?: string }>;

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Database is not configured');
  return createClient(url, key);
}

function textFromMessage(message?: UIMessage) {
  if (!message?.parts) return '';
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('')
    .trim();
}

const composio = new Composio({ provider: new VercelProvider() });

export async function POST(req: NextRequest) {
  try {
    const {
      messages,
      userId,
      sessionId,
      resumeId,
    }: {
      messages?: ChatMessage[];
      userId?: string;
      sessionId?: string | null;
      resumeId?: string | null;
    } = await req.json();

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'API key not configured' }, { status: 500 });
    }
    if (!messages?.length) {
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
    }

    const supabase = client();
    let sid = sessionId || null;
    const lastMessage = messages[messages.length - 1];
    const lastUserText = lastMessage.role === 'user' ? textFromMessage(lastMessage) : '';

    if (userId) {
      if (!sid) {
        const firstUserText =
          textFromMessage(messages.find(message => message.role === 'user')) || 'New Chat';
        const title = firstUserText.length > 48 ? `${firstUserText.slice(0, 48)}...` : firstUserText;
        const { data: newSession, error: sessionError } = await supabase
          .from('chat_sessions')
          .insert({ user_id: userId, title, resume_id: resumeId || null })
          .select()
          .single();

        if (!sessionError && newSession) sid = newSession.id;
      }

      if (sid && lastUserText) {
        await supabase
          .from('chat_messages')
          .insert({ session_id: sid, user_id: userId, role: 'user', content: lastUserText });
      }
    }

    let systemPrompt =
      'You are an expert resume coach and career advisor. You also have access to 1000+ real-world tools via Composio. You can use these tools to help the user directly (e.g. "email my resume to X", "check my GitHub repos", "save a draft to Notion"). Always be helpful, concise, and professional.';

    if (resumeId) {
      try {
        const { data: resume } = await supabase
          .from('resumes')
          .select('parsed_json')
          .eq('id', resumeId)
          .single();
        if (resume?.parsed_json) {
          systemPrompt += `\n\nHere is the user's current resume in JSON format:\n${JSON.stringify(resume.parsed_json)}`;
        }
      } catch (err) {
        console.error('Failed to load active resume context:', err);
      }

      systemPrompt += `\n\nThe user has an active resume (ID: ${resumeId}). When the user asks you to make changes to their resume, you MUST use the "edit_resume" tool provided. Pass resume_id as "${resumeId}" and provide a clear natural-language instruction, such as "Change the job title to Manager" or "Add a new experience block for Software Engineer at Tech Corp".`;
    }

    const session = await composio.create(userId || 'anonymous');
    const composioTools = await session.tools();

    const customTools = {
      edit_resume: tool({
        description:
          "Edit, update, or add to any part of the user's resume. Pass a clear natural language instruction detailing what should be added, changed, or deleted.",
        inputSchema: z.object({
          resume_id: z.string().describe('The ID of the resume'),
          instruction: z
            .string()
            .describe(
              'A natural language instruction of what to do (e.g. "change job title to Manager", "add this text to the summary")',
            ),
        }),
        execute: async ({ resume_id, instruction }) => {
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
          const res = await fetch(`${baseUrl}/api/resume-edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resumeId: resume_id, userId, message: instruction }),
          });
          const data = await res.json();
          return { success: res.ok, reply: data.reply || 'Resume updated successfully' };
        },
      }),
    };

    const googleProvider = createGoogleGenerativeAI({ apiKey });
    const modelMessages = await convertToModelMessages(messages);

    const result = streamText({
      model: googleProvider('gemini-3-flash-preview'),
      system: systemPrompt,
      messages: modelMessages,
      tools: { ...composioTools, ...customTools },
      stopWhen: stepCountIs(8),
    });

    return result.toUIMessageStreamResponse<ChatMessage>({
      originalMessages: messages,
      generateMessageId: () => generateId(),
      messageMetadata: () => (sid ? { sessionId: sid } : undefined),
      onFinish: async ({ responseMessage }) => {
        const assistantText = textFromMessage(responseMessage);
        if (userId && sid && assistantText) {
          await supabase
            .from('chat_messages')
            .insert({ session_id: sid, user_id: userId, role: 'assistant', content: assistantText });
        }
      },
    });
  } catch (e: unknown) {
    console.error(e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: `Chat failed: ${message}` }, { status: 500 });
  }
}

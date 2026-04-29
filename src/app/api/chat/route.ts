import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  convertToModelMessages,
  generateId,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel,
  type UIMessage,
} from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { Composio } from '@composio/core';
import { VercelProvider } from '@composio/vercel';
import { searchJobs } from '@/lib/jobs';
import { inferResumeBillingAction } from '@/lib/billing';
import { createGeminiFallbackMiddleware, GEMINI_MODEL_FALLBACKS, geminiUserError } from '@/lib/gemini';

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

async function insertChatMessage({
  supabase,
  sessionId,
  userId,
  role,
  content,
  parts,
}: {
  supabase: ReturnType<typeof client>;
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  parts?: unknown;
}) {
  const row = {
    session_id: sessionId,
    user_id: userId,
    role,
    content,
    parts,
  };

  const { error } = await supabase.from('chat_messages').insert(row);
  if (!error) return;

  const missingPartsColumn = error.message?.includes('parts') || error.code === 'PGRST204';
  if (!missingPartsColumn) {
    console.error('Failed to persist chat message:', error);
    return;
  }

  const fallback = { session_id: sessionId, user_id: userId, role, content };
  const { error: fallbackError } = await supabase.from('chat_messages').insert(fallback);
  if (fallbackError) console.error('Failed to persist chat message:', fallbackError);
}

const composio = new Composio({ provider: new VercelProvider() });

export async function POST(req: NextRequest) {
  try {
    const {
      messages,
      userId,
      sessionId,
      resumeId,
      idempotencyKey,
    }: {
      messages?: ChatMessage[];
      userId?: string;
      sessionId?: string | null;
      resumeId?: string | null;
      idempotencyKey?: string | null;
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
        await insertChatMessage({
          supabase,
          sessionId: sid,
          userId,
          role: 'user',
          content: lastUserText,
          parts: lastMessage.parts,
        });
      }
    }

    let systemPrompt =
      'You are an expert resume coach and career advisor. You also have access to 1000+ real-world tools via Composio. You can use these tools to help the user directly when relevant. Always be helpful, concise, and professional. When the user asks to find or search for jobs, use the search_jobs tool and then briefly introduce the results.';

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

      systemPrompt += `\n\nThe user has an active resume (ID: ${resumeId}). When the user asks you to make changes to their resume, you MUST use the edit_resume tool. Pass resume_id as "${resumeId}" and provide a clear natural-language instruction. When tailoring the resume to a job, use the job title, company, and description to update the resume for ATS relevance without inventing experience.`;
    }

    const session = await composio.create(userId || 'anonymous');
    const composioTools = await session.tools();

    const customTools = {
      search_jobs: tool({
        description:
          'Search live Google Jobs results using SerpAPI. Use this whenever the user asks to find jobs, job openings, roles, internships, or hiring opportunities.',
        inputSchema: z.object({
          query: z.string().describe('The full job search query, including role, skills, seniority, and location if provided.'),
        }),
        execute: async ({ query }) => searchJobs(query),
      }),
      edit_resume: tool({
        description:
          "Edit, update, tailor, or add to any part of the user's active resume. Pass a clear natural language instruction detailing what should be added, changed, or deleted.",
        inputSchema: z.object({
          resume_id: z.string().describe('The ID of the resume'),
          instruction: z
            .string()
            .describe(
              'A natural language instruction of what to do (e.g. "change job title to Manager", "tailor this resume for the pasted frontend engineer job")',
            ),
        }),
        execute: async ({ resume_id, instruction }) => {
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
          const actionType = inferResumeBillingAction(instruction);
          const res = await fetch(`${baseUrl}/api/resume-edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              resumeId: resume_id,
              userId,
              message: instruction,
              billingAction: actionType,
              idempotencyKey: `${idempotencyKey || generateId()}:edit_resume:${resume_id}`,
            }),
          });
          const data = await res.json();
          if (res.status === 402) {
            return {
              success: false,
              paymentRequired: true,
              reply: data.error || 'You need credits to edit this resume with AI.',
              credits: data.credits,
              cost: data.cost,
              freeTailorAvailable: data.freeTailorAvailable,
            };
          }
          return { success: res.ok, reply: data.reply || 'Resume updated successfully', resume: data.resume, billing: data.billing };
        },
      }),
    };

    const googleProvider = createGoogleGenerativeAI({ apiKey });
    const modelMessages = await convertToModelMessages(messages);
    const model = wrapLanguageModel({
      model: googleProvider(GEMINI_MODEL_FALLBACKS[0]),
      middleware: createGeminiFallbackMiddleware(modelId => googleProvider(modelId)),
      modelId: GEMINI_MODEL_FALLBACKS.join(' -> '),
    });

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools: { ...composioTools, ...customTools },
      stopWhen: stepCountIs(8),
      maxRetries: 0,
    });

    return result.toUIMessageStreamResponse<ChatMessage>({
      originalMessages: messages,
      generateMessageId: () => generateId(),
      messageMetadata: () => (sid ? { sessionId: sid } : undefined),
      onFinish: async ({ responseMessage }) => {
        const assistantText = textFromMessage(responseMessage);
        if (userId && sid) {
          await insertChatMessage({
            supabase,
            sessionId: sid,
            userId,
            role: 'assistant',
            content: assistantText,
            parts: responseMessage.parts,
          });
        }
      },
    });
  } catch (e: unknown) {
    console.error(e);
    const message = geminiUserError(e) || 'Unknown error';
    return NextResponse.json({ error: `Chat failed: ${message}` }, { status: 500 });
  }
}

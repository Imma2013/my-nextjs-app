import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
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
import {
  assertCanRunPaidAction,
  creditCostForAction,
  inferResumeBillingAction,
  getBillingSummary,
  PaymentRequiredError,
  recordPaidActionSuccess,
} from '@/lib/billing';
import { createGeminiFallbackMiddleware, GEMINI_MODEL_FALLBACKS, geminiUserError } from '@/lib/gemini';
import { runResumeEdit } from '@/lib/resumeEdit';
import { RESUME_FACT_SAFETY_RULES } from '@/lib/resumeFacts';
import { ATS_RESUME_RULES } from '@/lib/resumeAts';

type BillingSummary = Awaited<ReturnType<typeof getBillingSummary>>;
type BillingDataPart = {
  billing?: BillingSummary;
  refresh?: boolean;
  error?: string;
};
type ChatDataParts = {
  billing: BillingDataPart;
};
type ChatMessage = UIMessage<{ sessionId?: string }, ChatDataParts>;

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

function looksLikeJobSearchRequest(text: string) {
  return /\b(find|search|show|look for|list|recommend|browse|get)\b.*\b(jobs?|roles?|openings?|internships?|hiring|positions?)\b|\b(jobs?|roles?|openings?|internships?|hiring|positions?)\b.*\b(near me|remote|hybrid|onsite|available|open|hiring|at\b|in\b)/i.test(text);
}

function looksLikeResumeMutationRequest(text: string) {
  return /\btailor\b|\btarget\b|\bats\b|\bcover letter\b|\bresume builder\b|\b(optimi[sz]e|rewrite|improve|edit|update)\b.*\bresume\b|\bresume\b.*\b(optimi[sz]e|rewrite|improve|edit|update)\b/i.test(text);
}

function toolNameFromPart(part: unknown) {
  const typed = part as { type?: unknown; toolName?: unknown };
  if (typeof typed.type === 'string' && typed.type.startsWith('tool-')) return typed.type.slice(5);
  return typeof typed.toolName === 'string' ? typed.toolName : '';
}

function appendBillingPart(
  stream: ReadableStream<unknown>,
  billingPartPromise: Promise<BillingDataPart | null>,
) {
  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }

        const billingPart = await billingPartPromise;
        if (billingPart) {
          controller.enqueue({
            type: 'data-billing',
            data: billingPart,
            transient: true,
          });
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
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
    const isFreeJobSearch = looksLikeJobSearchRequest(lastUserText);
    const shouldChargeChatReply = Boolean(lastUserText && !isFreeJobSearch && !looksLikeResumeMutationRequest(lastUserText));
    const chatActionType = 'ai_chat_reply' as const;
    const chatActionCost = creditCostForAction(chatActionType);

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

    const chatChargeKey = shouldChargeChatReply
      ? `${idempotencyKey || generateId()}:chat:${sid || 'new'}:${lastMessage.id || 'message'}`
      : '';

    if (shouldChargeChatReply) {
      if (!userId) {
        return NextResponse.json({ error: 'Sign in to use AI chat.', paymentRequired: true, cost: chatActionCost, remainingActions: 0 }, { status: 402 });
      }
      await assertCanRunPaidAction({
        userId,
        actionType: chatActionType,
        cost: chatActionCost,
        idempotencyKey: chatChargeKey,
      });
    }

    let mutatingToolActions = 0;
    const confirmationReply = 'I completed 3 mutating actions in this exchange. Please confirm before I continue making more changes.';
    let systemPrompt =
      'You are an expert resume coach and career advisor. You also have access to 1000+ real-world tools via Composio. You can use these tools to help the user directly when relevant. Always be helpful, concise, and professional. When the user asks to find or search for jobs, use the search_jobs tool and then briefly introduce the results. As a safety guardrail, after 3 mutating AI or tool actions in one exchange, stop and ask the user to confirm before continuing. The search_jobs tool does not count toward that limit.';

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

      systemPrompt += `\n\nThe user has an active resume (ID: ${resumeId}). When the user asks you to make changes to their resume, you MUST use the edit_resume tool. Pass resume_id as "${resumeId}" and provide a clear natural-language instruction. For broad requests like "make this ATS friendly", update structure and wording conservatively, then summarize what was fixed and what still needs confirmation. Safe ATS cleanup is automatic unless the user explicitly says not to. When tailoring the resume to a job, use the job title, company, and description to update the resume for ATS relevance while following these constraints:\n${RESUME_FACT_SAFETY_RULES}\n\n${ATS_RESUME_RULES}`;
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
          if (mutatingToolActions >= 3) {
            return {
              success: false,
              confirmationRequired: true,
              reply: confirmationReply,
            };
          }
          const actionType = inferResumeBillingAction(instruction);
          try {
            const result = await runResumeEdit({
              resumeId: resume_id,
              userId,
              message: instruction,
              billingAction: actionType,
              idempotencyKey: `${idempotencyKey || generateId()}:edit_resume:${resume_id}`,
            });
            if (result.resume) mutatingToolActions += 1;

            return {
              success: Boolean(result.resume),
              reply: result.reply || 'Resume updated successfully',
              resume: result.resume,
              atsReview: result.atsReview,
              billing: result.billing,
              processedBy: result.processedBy,
            };
          } catch (error) {
            if (error instanceof PaymentRequiredError) {
              return {
                success: false,
                paymentRequired: true,
                reply: error.message || `This AI action costs ${error.details.cost || 1}. You have ${error.details.remainingActions || 0} remaining.`,
                remainingActions: error.details.remainingActions,
                monthlyActionsRemaining: error.details.monthlyActionsRemaining,
                rolloverActionsRemaining: error.details.rolloverActionsRemaining,
                topUpActionsRemaining: error.details.topUpActionsRemaining,
                cost: error.details.cost,
              };
            }

            console.error('edit_resume tool failed:', error);
            return {
              success: false,
              reply: "I couldn't edit the resume. Please try again.",
            };
          }
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

    let resolveBillingPart: (part: BillingDataPart | null) => void = () => {};
    let billingPartResolved = false;
    const billingPartPromise = new Promise<BillingDataPart | null>(resolve => {
      resolveBillingPart = part => {
        if (billingPartResolved) return;
        billingPartResolved = true;
        resolve(part);
      };
    });

    const uiStream = result.toUIMessageStream<ChatMessage>({
      originalMessages: messages,
      generateMessageId: () => generateId(),
      messageMetadata: () => (sid ? { sessionId: sid } : undefined),
      onFinish: async ({ responseMessage }) => {
        try {
          const assistantText = textFromMessage(responseMessage);
          const toolNames = responseMessage.parts.map(toolNameFromPart).filter(Boolean);
          const usedFreeOrMutatingTool = toolNames.includes('search_jobs') || toolNames.includes('edit_resume');
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
          if (userId && shouldChargeChatReply && !usedFreeOrMutatingTool) {
            try {
              await recordPaidActionSuccess({
                userId,
                actionType: chatActionType,
                cost: chatActionCost,
                idempotencyKey: chatChargeKey,
                resumeId: resumeId || null,
              });
              resolveBillingPart({ billing: await getBillingSummary(userId) });
            } catch (error) {
              console.error('Failed to record chat AI action:', error);
              resolveBillingPart({ refresh: true, error: 'billing_record_failed' });
            }
          }
        } finally {
          resolveBillingPart(null);
        }
      },
    });

    const stream = createUIMessageStream<ChatMessage>({
      execute: ({ writer }) => {
        writer.merge(appendBillingPart(uiStream, billingPartPromise) as ReadableStream<any>);
      },
      onError: error => geminiUserError(error) || (error instanceof Error ? error.message : 'An error occurred.'),
    });

    return createUIMessageStreamResponse({ stream });
  } catch (e: unknown) {
    console.error(e);
    if (e instanceof PaymentRequiredError) {
      return NextResponse.json({ error: e.message, paymentRequired: true, ...e.details }, { status: 402 });
    }
    const message = geminiUserError(e) || 'Unknown error';
    return NextResponse.json({ error: `Chat failed: ${message}` }, { status: 500 });
  }
}

'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { auth, onAuthStateChanged, googleProvider } from '@/lib/firebase';
import { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from 'ai';
import ResumeDocument from '@/components/ResumeDocument';
import { JobResults } from '@/components/JobResults';
import { ToolCallDisplay } from '@/components/ToolCallDisplay';
import type { JobResult, JobSearchPayload } from '@/lib/jobs';

type ChatMessage = UIMessage<{ sessionId?: string }>;
type ResumeContext = { id: string; title?: string; file_name?: string; summary?: string; candidate_name?: string; headline?: string; preview_url?: string; parsed_json?: any };
type ChatSession = { id: string; title: string; resumes?: ResumeContext | null };
type EditPayload = { operation: 'replace' | 'add' | 'remove'; path: string; value?: unknown };
type BillingSummary = {
  credits: number;
  plan: string;
  planStatus: string;
  currentPeriodEnd?: string | null;
  freeTailorAvailable: boolean;
};
type BillingModalReason = 'out_of_credits' | 'upgrade' | 'topup' | 'billing';

function makeTextMessage(role: 'user' | 'assistant', text: string): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    parts: [{ type: 'text', text }],
  };
}

function parseSavedParts(parts: unknown) {
  if (!parts) return null;
  if (Array.isArray(parts)) return parts;
  if (typeof parts === 'string') {
    try {
      const parsed = JSON.parse(parts);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function savedMessageToUIMessage(message: any, index: number): ChatMessage {
  const parts = parseSavedParts(message.parts) || [{ type: 'text', text: message.content || '' }];
  return {
    id: `msg-${index}`,
    role: message.role,
    parts,
  };
}

function getPartToolName(part: any) {
  if (isToolUIPart(part)) return getToolName(part);
  if (part.type === 'tool') return part.toolName;
  return '';
}

function getPartInput(part: any) {
  return part.input ?? part.args;
}

function getPartOutput(part: any) {
  return part.output ?? part.result;
}

function getSearchJobsPayload(output: unknown): JobSearchPayload | null {
  if (!output || typeof output !== 'object') return null;
  const payload = output as { query?: unknown; jobs?: unknown };
  if (!Array.isArray(payload.jobs)) return null;
  return {
    query: typeof payload.query === 'string' ? payload.query : '',
    jobs: payload.jobs as JobResult[],
  };
}

function makeIdempotencyKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function looksLikePaidResumeRequest(text: string) {
  return /\btailor\b|\btarget\b|\bats\b|\bcover letter\b|\bresume builder\b|\b(optimi[sz]e|rewrite|improve|edit|update)\b.*\bresume\b|\bresume\b.*\b(optimi[sz]e|rewrite|improve|edit|update)\b/i.test(text);
}

function looksLikeTailorRequest(text: string) {
  return /\btailor\b|\btarget\b|\bats\b|\bjob description\b/i.test(text);
}

export default function Home() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeResume, setActiveResume] = useState<ResumeContext | null>(null);
  const [userId, setUserId] = useState('');
  const [input, setInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const resumedCheckoutRef = useRef(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [resumesList, setResumesList] = useState<any[]>([]);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [billingModalOpen, setBillingModalOpen] = useState(false);
  const [billingModalReason, setBillingModalReason] = useState<BillingModalReason>('upgrade');
  const [checkoutBusy, setCheckoutBusy] = useState('');
  const [checkoutError, setCheckoutError] = useState('');
  const [billingPortalBusy, setBillingPortalBusy] = useState(false);

  const {
    messages,
    setMessages,
    sendMessage: sendChatMessage,
    status: chatStatus,
    error: chatError,
  } = useChat<ChatMessage>({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
    onFinish: ({ message }) => {
      const sessionId = message.metadata?.sessionId;
      if (sessionId) setActiveSessionId(sessionId);
      const resumeFromTool = message.parts
        .filter((part: any) => getPartToolName(part) === 'edit_resume')
        .map(getPartOutput)
        .find((output: any) => output?.resume)?.resume;
      const paymentRequired = message.parts
        .filter((part: any) => getPartToolName(part) === 'edit_resume')
        .map(getPartOutput)
        .some((output: any) => output?.paymentRequired);
      if (resumeFromTool) setActiveResume(resumeFromTool);
      if (paymentRequired) openBillingModal('out_of_credits');
      if (userId) {
        loadSessions(userId);
        loadResumes(userId);
        loadBilling(userId);
      }
    },
  });
  const busy = chatStatus === 'submitted' || chatStatus === 'streaming';

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async user => {
      if (user) {
        setUserId(user.uid);
        setShowAuthModal(false);
      } else {
        setUserId('');
      }
    });
    return () => unsubscribe();
  }, []);
  useEffect(() => { if (userId) { loadSessions(userId); loadResumes(userId); loadBilling(userId); } else { setBilling(null); } }, [userId]);
  useEffect(() => {
    if (!userId || !billing || resumedCheckoutRef.current || typeof window === 'undefined') return;
    if (!window.location.search.includes('checkout=success')) return;
    const raw = window.localStorage.getItem('pendingTailorResume');
    if (!raw) return;
    try {
      const pending = JSON.parse(raw) as { instruction?: string; resume?: ResumeContext };
      if (!pending.instruction || !pending.resume || !hasCreditsForResumeAction(pending.instruction)) return;
      resumedCheckoutRef.current = true;
      window.localStorage.removeItem('pendingTailorResume');
      setActiveResume(pending.resume);
      setShowDashboard(false);
      setInput('');
      void sendChatMessage(
        { text: pending.instruction },
        { body: { userId, sessionId: activeSessionId, resumeId: pending.resume.id, idempotencyKey: makeIdempotencyKey() } },
      );
    } catch {
      window.localStorage.removeItem('pendingTailorResume');
    }
  }, [userId, billing?.credits, billing?.freeTailorAvailable]);
  useEffect(() => {
    if (!activeResume?.id) return;
    const channel = supabase
      .channel(`resume-${activeResume.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'resumes', filter: `id=eq.${activeResume.id}` }, payload => {
        setActiveResume(prev => prev?.id === payload.new.id ? { ...prev, ...payload.new } as ResumeContext : prev);
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeResume?.id]);

  async function loadSessions(uid = userId) {
    if (!uid) return;
    const res = await fetch(`/api/chat/sessions?userId=${encodeURIComponent(uid)}`);
    const data = await res.json();
    if (res.ok) setSessions(data.sessions || []);
  }

  async function loadResumes(uid = userId) {
    if (!uid) return;
    const res = await fetch(`/api/resumes?userId=${encodeURIComponent(uid)}`);
    const data = await res.json();
    if (res.ok) setResumesList(data.resumes || []);
  }

  async function loadBilling(uid = userId) {
    if (!uid) return;
    const res = await fetch(`/api/billing/credits?userId=${encodeURIComponent(uid)}`);
    const data = await res.json();
    if (res.ok) setBilling(data);
  }

  function hasCreditsForResumeAction(text: string) {
    if (!billing) return false;
    if (looksLikeTailorRequest(text) && billing.freeTailorAvailable) return true;
    return billing.credits >= 1;
  }

  function openBillingModal(reason: BillingModalReason) {
    setBillingModalReason(reason);
    setCheckoutError('');
    setBillingModalOpen(true);
  }

  async function startCheckout(checkoutType: 'subscription' | 'topup', value: string) {
    if (!userId) {
      setShowAuthModal(true);
      return;
    }
    setCheckoutBusy(value);
    setCheckoutError('');
    try {
      const body = checkoutType === 'subscription'
        ? { userId, checkoutType, plan: value, returnPath: window.location.pathname + window.location.search }
        : { userId, checkoutType, package: value, returnPath: window.location.pathname + window.location.search };
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Checkout failed');
      window.location.href = data.url;
    } catch (err) {
      setBillingModalOpen(true);
      setCheckoutError('Checkout failed. ' + (err instanceof Error ? err.message : 'Please try again.'));
    } finally {
      setCheckoutBusy('');
    }
  }

  async function openBillingPortal() {
    if (!userId) {
      setShowAuthModal(true);
      return;
    }
    setBillingPortalBusy(true);
    setCheckoutError('');
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, returnPath: window.location.pathname + window.location.search }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open billing portal');
      window.location.href = data.url;
    } catch (err) {
      setBillingModalOpen(true);
      setCheckoutError('Billing portal failed. ' + (err instanceof Error ? err.message : 'Please try again.'));
    } finally {
      setBillingPortalBusy(false);
    }
  }

  async function deleteResume(id: string) {
    if (!userId) return;
    if (!confirm('Are you sure you want to delete this resume?')) return;
    const res = await fetch(`/api/resumes?userId=${encodeURIComponent(userId)}&resumeId=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      if (activeResume?.id === id) setActiveResume(null);
      loadResumes(userId);
    }
  }

  async function loadChat(id: string) {
    const res = await fetch(`/api/chat/sessions/${id}?userId=${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (res.ok) {
      setActiveSessionId(id);
      setActiveResume(data.session?.resumes || null);
      setMessages((data.messages || []).map(savedMessageToUIMessage));
      setShowDashboard(false);
    }
  }

  function newChat() {
    setActiveSessionId(null);
    setActiveResume(null);
    setMessages([]);
    setInput('');
    setShowDashboard(false);
  }

  async function uploadFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!userId) {
      setShowAuthModal(true);
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('userId', userId);
      if (activeSessionId) fd.append('sessionId', activeSessionId);
      const res = await fetch('/api/resumes', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setActiveResume(data.resume);
      if (data.sessionId) setActiveSessionId(data.sessionId);
      await loadSessions();
      await loadResumes();
      setShowDashboard(false);
      setMessages(prev => [...prev, makeTextMessage('assistant', 'Resume uploaded and converted into editable structured data. Ask me to edit it, or click directly in the preview to edit manually.')]);
    } catch (err) {
      setMessages(prev => [...prev, makeTextMessage('assistant', 'Upload failed: ' + (err instanceof Error ? err.message : 'Unknown error'))]);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function saveResumeEdit(edit: EditPayload | { message: string }) {
    if (!activeResume || !userId) throw new Error('No active resume');
    const res = await fetch('/api/resume-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resumeId: activeResume.id,
        userId,
        edit: 'path' in edit ? edit : undefined,
        message: 'message' in edit ? edit.message : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Resume edit failed');
    if (!data.resume) throw new Error(data.reply || 'Could not map this to a saved resume field');
    setActiveResume(data.resume);
    if (data.billing) loadBilling(userId);
    return data.reply || 'Updated the resume preview.';
  }

  async function handleManualEdit(edit: EditPayload) {
    if (!userId) { setShowAuthModal(true); return; }
    try {
      await saveResumeEdit(edit);
    } catch (err) {
      setMessages(prev => [...prev, makeTextMessage('assistant', 'Manual edit failed: ' + (err instanceof Error ? err.message : 'Unknown error'))]);
    }
  }

  async function sendMessage(text?: string) {
    const msg = text ?? input;
    if (!msg.trim() || busy) return;
    if (!userId) {
      setShowAuthModal(true);
      return;
    }
    if (activeResume && billing && looksLikePaidResumeRequest(msg) && !hasCreditsForResumeAction(msg)) {
      openBillingModal('out_of_credits');
      return;
    }
    setInput('');
    setShowDashboard(false);
    try {
      await sendChatMessage(
        { text: msg },
        { body: { userId, sessionId: activeSessionId, resumeId: activeResume?.id, idempotencyKey: makeIdempotencyKey() } },
      );
      await loadSessions();
    } catch (err) {
      setMessages(prev => [
        ...prev,
        makeTextMessage('assistant', 'I understood this, but could not complete it: ' + (err instanceof Error ? err.message : 'Unknown error')),
      ]);
    }
  }

  function tailorResume(job: JobResult) {
    if (!activeResume) {
      if (!userId) {
        setShowAuthModal(true);
        return;
      }
      setShowDashboard(true);
      setMessages(prev => [
        ...prev,
        makeTextMessage('assistant', 'Select or upload a resume first, then I can tailor it to this job.'),
      ]);
      return;
    }

    const instruction = [
      `Tailor my active resume for this job: ${job.title || 'Role'} at ${job.company_name || 'Company'}.`,
      job.location ? `Location: ${job.location}.` : '',
      job.description ? `Job description:\n${job.description}` : '',
    ].filter(Boolean).join('\n\n');

    if (billing && !hasCreditsForResumeAction(instruction)) {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('pendingTailorResume', JSON.stringify({ instruction, resume: activeResume }));
      }
      openBillingModal('out_of_credits');
      return;
    }

    sendMessage(instruction);
  }

  const handleAuth = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  const handleGoogleAuth = async () => {
    setAuthError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  function renderMessageParts(m: ChatMessage) {
    return m.parts.map((part: any, j: number) => {
      if (part.type === 'text') return <span key={j}>{part.text}</span>;

      const toolName = getPartToolName(part);
      if (toolName) {
        const isLoading = part.state !== 'output-available' && part.state !== 'output-error';
        const output = part.state === 'output-available'
          ? getPartOutput(part)
          : part.state === 'output-error'
            ? part.errorText
            : undefined;

        if (toolName === 'search_jobs') {
          const payload = getSearchJobsPayload(output);
          if (payload) {
            return <JobResults key={part.toolCallId || j} query={payload.query} jobs={payload.jobs} onTailorResume={tailorResume} tailorButtonLabel={billing?.freeTailorAvailable ? 'Tailor resume - Free' : 'Tailor resume - 1 credit'} />;
          }
        }

        return (
          <ToolCallDisplay
            key={part.toolCallId || j}
            toolName={toolName}
            input={getPartInput(part)}
            output={output}
            isLoading={isLoading}
          />
        );
      }

      return null;
    });
  }

  function renderMessages(compact = false) {
    return (
      <>
        {messages.map((m: ChatMessage, i: number) => (
          <div key={m.id || i} className={m.role === 'user' ? 'rounded-xl bg-slate-100 p-3' : 'leading-7'}>
            <div className={`whitespace-pre-wrap break-words ${compact ? '' : 'max-w-3xl mx-auto'}`}>
              {renderMessageParts(m)}
            </div>
          </div>
        ))}
        {busy && <div className={`text-sm text-slate-500 ${compact ? '' : 'max-w-3xl mx-auto'}`}>Working...</div>}
        {chatError && <div className={`text-sm text-red-500 ${compact ? '' : 'max-w-3xl mx-auto'}`}>{chatError.message}</div>}
        <div ref={bottomRef} />
      </>
    );
  }

  const authModal = showAuthModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-xl bg-white p-8 shadow-2xl">
        <button onClick={() => setShowAuthModal(false)} className="absolute right-4 top-4 text-slate-400 hover:text-slate-600">x</button>
        <h1 className="mb-6 text-center text-2xl font-bold text-slate-900">Sign in to Continue</h1>
        <form onSubmit={handleAuth} className="flex flex-col gap-4">
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} className="rounded-md border p-3 text-slate-900 outline-none focus:border-blue-500" required />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="rounded-md border p-3 text-slate-900 outline-none focus:border-blue-500" required />
          {authError && <p className="text-sm text-red-500">{authError}</p>}
          <button type="submit" className="rounded-md bg-blue-600 p-3 font-bold text-white hover:bg-blue-700">{isLogin ? 'Sign In' : 'Sign Up'}</button>
        </form>
        <div className="my-6 flex items-center gap-2 text-slate-400">
          <div className="h-px flex-1 bg-slate-200"></div><span>or</span><div className="h-px flex-1 bg-slate-200"></div>
        </div>
        <button onClick={handleGoogleAuth} className="w-full rounded-md border border-slate-200 bg-white p-3 font-bold text-slate-700 hover:bg-slate-50">Sign In with Google</button>
        <p className="mt-6 text-center text-sm text-slate-500">
          {isLogin ? "Don't have an account?" : 'Already have an account?'}{' '}
          <button onClick={() => setIsLogin(!isLogin)} className="font-bold text-blue-600 hover:underline">{isLogin ? 'Sign Up' : 'Sign In'}</button>
        </p>
      </div>
    </div>
  );

  const planLabel = billing?.plan === 'pro_plus' ? 'Pro Plus' : billing?.plan === 'pro' ? 'Pro' : 'Free';
  const planStatusLabel = billing?.planStatus ? billing.planStatus.replace(/_/g, ' ') : 'inactive';
  const billingModalTitle = billingModalReason === 'out_of_credits'
    ? "You're out of credits"
    : billingModalReason === 'billing'
      ? 'Manage billing'
      : billingModalReason === 'topup'
        ? 'Add credits'
        : 'Upgrade Resume AI';
  const paidPlan = billing?.plan === 'pro' || billing?.plan === 'pro_plus';
  const billingModal = billingModalOpen && (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="relative my-auto w-full max-w-3xl rounded-xl bg-white shadow-2xl">
        <button onClick={() => setBillingModalOpen(false)} className="absolute right-4 top-4 z-10 text-slate-400 hover:text-slate-600">x</button>
        <div className="max-h-[calc(100vh-2rem)] overflow-y-auto p-5 sm:p-7">
          <div className="pr-8">
            <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">{billingModalTitle}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              AI resume edits use credits. Job search, uploads, and manual preview edits stay free.
            </p>
          </div>

          <div className="mt-5 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 sm:grid-cols-3">
            <div>
              <span className="block text-xs font-bold uppercase text-slate-500">Credits</span>
              <b className="mt-1 block text-lg text-slate-900">{billing?.credits ?? 0}</b>
            </div>
            <div>
              <span className="block text-xs font-bold uppercase text-slate-500">Current plan</span>
              <b className="mt-1 block text-lg text-slate-900">{planLabel}</b>
              <span className="capitalize text-xs text-slate-500">{planStatusLabel}</span>
            </div>
            <div>
              <span className="block text-xs font-bold uppercase text-slate-500">Free tailor</span>
              <b className={`mt-1 block text-lg ${billing?.freeTailorAvailable ? 'text-blue-700' : 'text-slate-900'}`}>
                {billing?.freeTailorAvailable ? 'Available' : 'Used'}
              </b>
            </div>
          </div>

          {paidPlan && (
            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-blue-100 bg-blue-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <b className="block text-sm text-slate-900">Subscription controls</b>
                <span className="text-sm text-slate-600">Update payment details, invoices, or plan status in Stripe.</span>
              </div>
              <button onClick={openBillingPortal} disabled={billingPortalBusy || !!checkoutBusy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60">
                {billingPortalBusy ? 'Opening...' : 'Manage subscription'}
              </button>
            </div>
          )}

          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold uppercase text-slate-500">Monthly plans</h3>
              <span className="text-xs text-slate-500">Credits refresh each month</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { key: 'pro', name: 'Pro', price: '$19/mo', credits: '30 credits/month' },
                { key: 'pro_plus', name: 'Pro Plus', price: '$29/mo', credits: '75 credits/month' },
              ].map(plan => (
                <button
                  key={plan.key}
                  onClick={() => startCheckout('subscription', plan.key)}
                  disabled={!!checkoutBusy || billingPortalBusy}
                  className={`rounded-lg border p-4 text-left hover:bg-slate-50 disabled:opacity-60 ${billing?.plan === plan.key ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white'}`}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span>
                      <b className="block text-base text-slate-900">{plan.name}</b>
                      <span className="mt-1 block text-sm text-slate-600">{plan.credits}</span>
                    </span>
                    <span className="text-right">
                      <b className="block text-base text-slate-900">{plan.price}</b>
                      <span className="mt-1 block text-sm font-bold text-blue-700">{checkoutBusy === plan.key ? 'Opening...' : billing?.plan === plan.key ? 'Current' : 'Choose'}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold uppercase text-slate-500">Top up credits</h3>
              <span className="text-xs text-slate-500">One-time purchase</span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                { key: 'credits_5', price: '$5', label: '5 credits' },
                { key: 'credits_20', price: '$15', label: '20 credits' },
                { key: 'credits_50', price: '$29', label: '50 credits' },
              ].map(pkg => (
                <button key={pkg.key} onClick={() => startCheckout('topup', pkg.key)} disabled={!!checkoutBusy || billingPortalBusy} className="rounded-lg border border-slate-200 p-4 text-left hover:bg-slate-50 disabled:opacity-60">
                  <span className="flex items-center justify-between gap-3 sm:block">
                    <b className="block text-base text-slate-900">{pkg.price}</b>
                    <span className="block text-sm text-slate-600">{checkoutBusy === pkg.key ? 'Opening...' : pkg.label}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {checkoutError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {checkoutError}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const composer = (
    <div className="relative z-10 shrink-0 rounded-xl border-2 border-blue-500 bg-white p-4 shadow-sm">
      {userId && billing && (
        <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
          <span>{billing.credits} credits - {planLabel}</span>
          <span className="font-semibold text-blue-700">{billing.freeTailorAvailable ? 'Free tailor available' : 'AI resume edits cost 1 credit'}</span>
        </div>
      )}
      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
        rows={activeResume ? 3 : 5}
        placeholder="Ask for resume edits, career advice, or job searches..."
        className="block w-full resize-none bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
        disabled={uploading || busy}
      />
      <div className="mt-3 flex items-center justify-between">
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="rounded-full bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200 disabled:opacity-50">+ Attach a Resume</button>
        <button onClick={() => sendMessage()} disabled={!input.trim() || busy || uploading} className="flex h-9 w-12 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white disabled:bg-slate-200 disabled:text-slate-400">SEND</button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-[#f7f8fb] text-slate-900">
      {authModal}
      {billingModal}
      <input ref={fileRef} type="file" accept=".pdf,.docx" onChange={uploadFile} className="hidden" />
      <aside className="relative z-0 flex h-full w-64 shrink-0 flex-col gap-5 overflow-hidden bg-[#332071] px-4 py-6 text-white">
        <div className="flex items-center gap-3 px-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500 font-bold">R</div>
          <span className="text-lg font-bold">Resume AI</span>
        </div>
        <div className="flex flex-col gap-2">
          <button onClick={newChat} className="flex items-center gap-3 rounded-lg bg-white/15 p-3 text-sm font-bold hover:bg-white/25"><span>+</span> New Chat</button>
          <button onClick={() => { if (!userId) { setShowAuthModal(true); return; } setShowDashboard(true); setActiveResume(null); loadResumes(); }} className={`flex items-center gap-3 rounded-lg p-3 text-sm hover:bg-white/10 ${showDashboard ? 'bg-white/20 font-bold' : ''}`}><span>[]</span> Resumes / CVs</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="mb-2 px-2 text-xs font-bold text-white/50">CHAT HISTORY</div>
          <div className="custom-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto pb-2">
            {userId && sessions.map(s => (
              <button key={s.id} title={s.title} onClick={() => loadChat(s.id)} className={`flex w-full items-center gap-3 rounded-lg p-3 text-left text-sm hover:bg-white/10 ${activeSessionId === s.id ? 'bg-white/20 font-bold' : ''}`}>
                <span>-</span>
                <span className="truncate">{s.title}</span>
              </button>
            ))}
            {userId && sessions.length === 0 && <div className="px-2 text-sm italic text-white/50">No past chats</div>}
            {!userId && <div className="px-2 text-sm italic text-white/50">Sign in to view history</div>}
          </div>
        </div>
        {userId && (
          <div className="mt-auto border-t border-white/10 pt-4">
            <button onClick={() => signOut(auth)} className="flex w-full items-center gap-3 rounded-lg p-3 text-sm font-bold hover:bg-red-500/20" title="Sign Out">
              <span>&gt;</span> Sign Out
            </button>
          </div>
        )}
      </aside>
      <main className="relative z-0 flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-6">
        <div className="flex shrink-0 items-center justify-between">
          <div className="flex items-center gap-2">
            {userId && <button onClick={() => loadSessions()} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-xs font-bold shadow-sm">RECENT CHATS</button>}
          </div>
          <div className="flex items-center gap-3">
            {userId && billing && (
              <button onClick={() => openBillingModal(paidPlan ? 'billing' : 'upgrade')} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50">
                {billing.credits} CREDITS - {planLabel.toUpperCase()}
              </button>
            )}
            <button onClick={newChat} className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-bold text-blue-700 hover:bg-blue-100">+ NEW CHAT</button>
            {!userId ? (
              <button onClick={() => setShowAuthModal(true)} className="rounded-md bg-blue-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-blue-700">SIGN IN</button>
            ) : (
              <button onClick={() => signOut(auth)} className="rounded-md bg-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-300">SIGN OUT</button>
            )}
          </div>
        </div>

        {!activeResume ? (
          showDashboard ? (
            <section className="mx-auto my-4 flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="mb-8 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-slate-900">My Resumes / CVs</h2>
                  {billing && <p className="mt-1 text-sm text-slate-500">{planLabel} plan - {billing.credits} credits available</p>}
                </div>
                <div className="flex items-center gap-2">
                  {billing && <button onClick={() => openBillingModal(paidPlan ? 'billing' : 'upgrade')} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">Billing</button>}
                  <button onClick={() => fileRef.current?.click()} disabled={uploading} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">+ Upload New PDF/DOCX</button>
                </div>
              </div>
              {uploading && <p className="mb-4 text-sm text-slate-500">Uploading and parsing with Gemini...</p>}
              <div className="grid grid-cols-1 gap-4 overflow-y-auto pb-4">
                {resumesList.length === 0 && !uploading && (
                  <div className="rounded-xl border-2 border-dashed border-slate-200 p-12 text-center text-slate-500">No resumes uploaded yet. Click the button above to upload one.</div>
                )}
                {resumesList.map(r => (
                  <div key={r.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-4 hover:bg-slate-50">
                    <div>
                      <h3 className="font-bold text-slate-900">{r.title || r.file_name}</h3>
                      <p className="text-xs text-slate-500">Uploaded on {new Date(r.created_at).toLocaleDateString()}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => { setActiveResume(r); setShowDashboard(false); setMessages(prev => [...prev, makeTextMessage('assistant', 'Resume loaded. Ask me to edit it, search jobs, or click directly in the preview to edit manually.')]); }} className="rounded-md bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200">Select for Chat</button>
                      <button onClick={() => deleteResume(r.id)} className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : messages.length === 0 ? (
            <section className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
              <div className="w-full max-w-3xl">
                <h1 className="mb-5 text-center text-xl font-bold">How can AI Resume Agent help with your resume and job search?</h1>
                <div className="mb-8 flex justify-center gap-3">
                  <button onClick={() => setInput('Find frontend jobs in Atlanta.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">FIND JOBS</button>
                  <button onClick={() => setInput('Help me target my resume for a role.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">TARGET MY RESUME</button>
                  <button onClick={() => setInput('Improve my resume score.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">IMPROVE MY SCORE</button>
                </div>
                {composer}
                {uploading && <p className="mt-3 text-center text-xs text-slate-500">Parsing and saving resume context with Gemini...</p>}
              </div>
            </section>
          ) : (
            <section className="mx-auto my-4 flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-5">
                <b className="text-sm">AI Chat</b>
              </div>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5">
                {renderMessages(false)}
              </div>
              <div className="shrink-0 border-t border-slate-200 p-5">
                <div className="mx-auto max-w-3xl">
                  {uploading && <p className="mb-2 text-xs text-slate-500">Parsing with Gemini...</p>}
                  {composer}
                </div>
              </div>
            </section>
          )
        ) : (
          <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_430px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-slate-200">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-5">
                <b>Resume</b><span className="text-xs text-slate-500">Click text to edit manually</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-100 p-7 overscroll-contain">
                <ResumeDocument resume={activeResume} onEdit={handleManualEdit} />
              </div>
            </div>
            <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
              <div className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 px-5">
                <button className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold">CHAT</button>
                <button onClick={() => { setActiveResume(null); setShowDashboard(true); loadResumes(); }} className="rounded-lg px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-50">RESUMES</button>
              </div>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden overscroll-contain p-5">
                <div className="w-40 rounded-lg border p-2 shadow-sm">
                  <div className="flex h-20 items-center justify-center rounded bg-slate-100 text-xs font-bold text-blue-600">AI AGENT</div>
                  <div className="mt-2 flex justify-between"><div><b className="text-sm">Resume</b><p className="text-xs text-slate-500">Editable</p></div><span className="text-blue-600">OK</span></div>
                </div>
                {renderMessages(true)}
              </div>
              <div className="shrink-0 border-t border-slate-200 p-5">
                {uploading && <p className="mb-2 text-xs text-slate-500">Parsing with Gemini...</p>}
                {composer}
              </div>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}

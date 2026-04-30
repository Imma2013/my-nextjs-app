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
type AppView = 'chat' | 'resumes' | 'apps';
type BillingSummary = {
  credits: number;
  plan: string;
  planStatus: string;
  currentPeriodEnd?: string | null;
  freeTailorAvailable: boolean;
  starterCredits?: number;
  pdfDownloadsUsed?: number;
  pdfDownloadsLimit?: number | null;
};
type BillingModalReason = 'out_of_credits' | 'upgrade' | 'topup' | 'billing';
type ToolkitConnection = {
  slug: string;
  name: string;
  logo?: string;
  isConnected: boolean;
  connectedAccountId?: string;
};
type TailorQuestion = {
  id: string;
  question: string;
  reason: string;
};
type TailorAnswer = {
  questionId: string;
  question?: string;
  answer: string;
};
type TailorQuestionsPayload = {
  clarificationId: string;
  questions: TailorQuestion[];
  job: JobResult;
  resume: ResumeContext;
  jobIndex?: number;
};
type TailorResult = {
  needsClarification?: boolean;
  resume: ResumeContext;
  score: number;
  summary: string;
  improvements: string[];
  matchedKeywords?: string[];
  missingKeywords?: string[];
  downloadUrl: string;
  billing?: unknown;
  processedBy?: string;
};
type PendingTailorSelection = {
  job: JobResult;
  jobIndex: number;
};

function makeTextMessage(role: 'user' | 'assistant', text: string): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    parts: [{ type: 'text', text }],
  };
}

function makeTailorResultMessage(result: TailorResult): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    parts: [{ type: 'tailor_result', result } as any],
  };
}

function makeTailorQuestionsMessage(payload: TailorQuestionsPayload): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    parts: [{ type: 'tailor_questions', payload } as any],
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

async function readJsonResponse(res: Response, fallbackMessage: string) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(res.ok ? fallbackMessage : `${fallbackMessage}. The server returned a non-JSON error response.`);
  }
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
  const [activeView, setActiveView] = useState<AppView>('chat');
  const [resumesList, setResumesList] = useState<any[]>([]);
  const [toolkits, setToolkits] = useState<ToolkitConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState('');
  const [connectionBusy, setConnectionBusy] = useState('');
  const [tailoringJobKey, setTailoringJobKey] = useState('');
  const [pendingTailorSelection, setPendingTailorSelection] = useState<PendingTailorSelection | null>(null);
  const [tailorPickerLoading, setTailorPickerLoading] = useState(false);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [billingModalOpen, setBillingModalOpen] = useState(false);
  const [billingModalReason, setBillingModalReason] = useState<BillingModalReason>('upgrade');
  const [checkoutBusy, setCheckoutBusy] = useState('');
  const [checkoutError, setCheckoutError] = useState('');
  const [billingPortalBusy, setBillingPortalBusy] = useState(false);
  const [resumePreviewOpen, setResumePreviewOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [downloadBusy, setDownloadBusy] = useState('');
  const [tailorQuestionAnswers, setTailorQuestionAnswers] = useState<Record<string, string>>({});
  const [tailorQuestionBusy, setTailorQuestionBusy] = useState('');

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
      if (resumeFromTool) {
        if (resumeFromTool.id !== activeResume?.id) setResumePreviewOpen(false);
        setActiveResume(resumeFromTool);
      }
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
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false);
  }, []);
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
    if (!userId || typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('view') !== 'apps') return;
    setActiveView('apps');
    setActiveResume(null);
    setResumePreviewOpen(false);
    void loadConnections(userId);
  }, [userId]);
  useEffect(() => {
    if (userId && activeView === 'apps') void loadConnections(userId);
  }, [userId, activeView]);
  useEffect(() => {
    if (!userId || !billing || resumedCheckoutRef.current || typeof window === 'undefined') return;
    if (!window.location.search.includes('checkout=success')) return;
    const raw = window.localStorage.getItem('pendingTailorResume');
    if (!raw) return;
    try {
      const pending = JSON.parse(raw) as {
        instruction?: string;
        resume?: ResumeContext;
        job?: JobResult;
        jobIndex?: number;
        answers?: TailorAnswer[];
        clarificationId?: string;
      };
      if (!pending.instruction || !pending.resume || !hasCreditsForResumeAction(pending.instruction)) return;
      resumedCheckoutRef.current = true;
      window.localStorage.removeItem('pendingTailorResume');
      setActiveResume(pending.resume);
      setResumePreviewOpen(false);
      setActiveView('chat');
      setInput('');
      if (pending.job) {
        void runTailorJob(pending.job, pending.resume, pending.jobIndex || 0, {
          answers: pending.answers,
          clarificationId: pending.clarificationId,
          appendUserMessage: false,
        });
        return;
      }
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

  async function loadConnections(uid = userId) {
    if (!uid) return;
    setConnectionsLoading(true);
    setConnectionsError('');
    try {
      const res = await fetch(`/api/connections?userId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load app connections');
      setToolkits(data.toolkits || []);
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : 'Could not load app connections');
    } finally {
      setConnectionsLoading(false);
    }
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

  function closeSidebarOnMobile() {
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false);
  }

  function openResumesDashboard() {
    if (!userId) {
      setShowAuthModal(true);
      closeSidebarOnMobile();
      return;
    }
    setActiveView('resumes');
    setActiveResume(null);
    setResumePreviewOpen(false);
    loadResumes();
    closeSidebarOnMobile();
  }

  function openAppsDashboard() {
    if (!userId) {
      setShowAuthModal(true);
      closeSidebarOnMobile();
      return;
    }
    setActiveView('apps');
    setActiveResume(null);
    setResumePreviewOpen(false);
    void loadConnections();
    closeSidebarOnMobile();
  }

  async function connectToolkit(slug: string) {
    if (!userId) {
      setShowAuthModal(true);
      return;
    }
    setConnectionBusy(slug);
    setConnectionsError('');
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, toolkit: slug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start app connection');
      if (!data.redirectUrl) throw new Error('Composio did not return a connection URL');
      window.location.href = data.redirectUrl;
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : 'Could not start app connection');
      setConnectionBusy('');
    }
  }

  async function disconnectToolkit(connectedAccountId: string) {
    setConnectionBusy(connectedAccountId);
    setConnectionsError('');
    try {
      const res = await fetch('/api/connections/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectedAccountId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not disconnect app');
      await loadConnections();
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : 'Could not disconnect app');
    } finally {
      setConnectionBusy('');
    }
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
      if (activeResume?.id === id) {
        setActiveResume(null);
        setResumePreviewOpen(false);
      }
      loadResumes(userId);
    }
  }

  async function loadChat(id: string) {
    const res = await fetch(`/api/chat/sessions/${id}?userId=${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (res.ok) {
      setActiveSessionId(id);
      setActiveResume(data.session?.resumes || null);
      setResumePreviewOpen(false);
      setMessages((data.messages || []).map(savedMessageToUIMessage));
      setActiveView('chat');
      closeSidebarOnMobile();
    }
  }

  function newChat() {
    setActiveSessionId(null);
    setActiveResume(null);
    setResumePreviewOpen(false);
    setMessages([]);
    setInput('');
    setActiveView('chat');
    closeSidebarOnMobile();
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
      if (!res.ok) {
        if (data.upgradeRequired) openBillingModal('upgrade');
        throw new Error(data.error || 'Upload failed');
      }
      setActiveResume(data.resume);
      setResumePreviewOpen(false);
      if (data.sessionId) setActiveSessionId(data.sessionId);
      await loadSessions();
      await loadResumes();
      await loadBilling();
      setActiveView('chat');
      if (pendingTailorSelection) {
        const pending = pendingTailorSelection;
        setPendingTailorSelection(null);
        setMessages(prev => [...prev, makeTextMessage('assistant', 'Resume uploaded and converted into editable structured data.')]);
        void runTailorJob(pending.job, data.resume, pending.jobIndex);
        return;
      }
      setMessages(prev => [...prev, makeTextMessage('assistant', 'Resume uploaded and converted into editable structured data. Ask me to edit it, or click directly in the preview to edit manually.')]);
    } catch (err) {
      setMessages(prev => [...prev, makeTextMessage('assistant', 'Upload failed: ' + (err instanceof Error ? err.message : 'Unknown error'))]);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  function resumeDownloadUrl(resume: ResumeContext) {
    return `/api/resumes/${encodeURIComponent(resume.id)}/download?userId=${encodeURIComponent(userId)}`;
  }

  function resumeDownloadName(resume: ResumeContext, fallback = 'resume') {
    return `${(resume.title || resume.file_name || fallback).replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').slice(0, 80) || fallback}.pdf`;
  }

  async function downloadResumePdf(url: string, fallbackName = 'resume.pdf', busyKey = '') {
    if (busyKey) setDownloadBusy(busyKey);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const data = await readJsonResponse(res, 'Download failed');
        if (data.upgradeRequired) openBillingModal('upgrade');
        throw new Error(data.error || 'Download failed');
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fallbackName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      await loadBilling();
    } catch (err) {
      setMessages(prev => [...prev, makeTextMessage('assistant', 'Download failed: ' + (err instanceof Error ? err.message : 'Unknown error'))]);
    } finally {
      if (busyKey) setDownloadBusy(current => current === busyKey ? '' : current);
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
    const data = await readJsonResponse(res, 'Resume edit failed');
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
    setActiveView('chat');
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

  function jobTailorKey(job: JobResult, index = 0) {
    return `${job.title || 'role'}-${job.company_name || 'company'}-${index}`;
  }

  function tailorAnswerKey(clarificationId: string, questionId: string) {
    return `${clarificationId}:${questionId}`;
  }

  function setTailorAnswer(clarificationId: string, questionId: string, answer: string) {
    setTailorQuestionAnswers(prev => ({
      ...prev,
      [tailorAnswerKey(clarificationId, questionId)]: answer,
    }));
  }

  async function submitTailorAnswers(payload: TailorQuestionsPayload) {
    const answers = payload.questions.map(question => ({
      questionId: question.id,
      question: question.question,
      answer: tailorQuestionAnswers[tailorAnswerKey(payload.clarificationId, question.id)] || '',
    }));

    setTailorQuestionBusy(payload.clarificationId);
    await runTailorJob(payload.job, payload.resume, payload.jobIndex || 0, {
      answers,
      clarificationId: payload.clarificationId,
      appendUserMessage: false,
    });
    setTailorQuestionBusy(current => current === payload.clarificationId ? '' : current);
  }

  async function runTailorJob(
    job: JobResult,
    resume: ResumeContext,
    index = 0,
    options: { answers?: TailorAnswer[]; clarificationId?: string; appendUserMessage?: boolean } = {},
  ) {
    const key = jobTailorKey(job, index);
    setTailoringJobKey(key);
    setActiveView('chat');
    if (options.appendUserMessage !== false) {
      setMessages(prev => [...prev, makeTextMessage('user', `Tailor my resume for ${job.title || 'this role'}${job.company_name ? ` at ${job.company_name}` : ''}.`)]);
    }
    try {
      const res = await fetch('/api/resume/tailor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          resumeId: resume.id,
          job,
          answers: options.answers,
          clarificationId: options.clarificationId,
          idempotencyKey: makeIdempotencyKey(),
        }),
      });
      const data = await res.json();
      if (data.paymentRequired) {
        if (typeof window !== 'undefined') {
          const instruction = [
            `Tailor my active resume for this job: ${job.title || 'Role'} at ${job.company_name || 'Company'}.`,
            job.location ? `Location: ${job.location}.` : '',
            job.description ? `Job description:\n${job.description}` : '',
          ].filter(Boolean).join('\n\n');
          window.localStorage.setItem('pendingTailorResume', JSON.stringify({
            instruction,
            resume,
            job,
            jobIndex: index,
            answers: options.answers,
            clarificationId: options.clarificationId,
          }));
        }
        openBillingModal('out_of_credits');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed to tailor resume');

      if (data.needsClarification) {
        setMessages(prev => [...prev, makeTailorQuestionsMessage({
          clarificationId: data.clarificationId || makeIdempotencyKey(),
          questions: Array.isArray(data.questions) ? data.questions.slice(0, 3) : [],
          job,
          resume,
          jobIndex: index,
        })]);
        return;
      }

      setActiveResume(data.resume);
      setResumePreviewOpen(true);
      await loadResumes();
      if (data.billing) await loadBilling(userId);
      setMessages(prev => [...prev, makeTailorResultMessage(data as TailorResult)]);
    } catch (err) {
      setMessages(prev => [...prev, makeTextMessage('assistant', 'Tailoring failed: ' + (err instanceof Error ? err.message : 'Unknown error'))]);
    } finally {
      setTailoringJobKey('');
    }
  }

  async function tailorResume(job: JobResult, index = 0) {
    if (!userId) {
      setShowAuthModal(true);
      return;
    }

    setPendingTailorSelection({ job, jobIndex: index });
    setActiveView('chat');
    setResumePreviewOpen(false);
    setTailorPickerLoading(true);
    try {
      await loadResumes(userId);
    } finally {
      setTailorPickerLoading(false);
    }
  }

  function selectResumeForTailoring(resume: ResumeContext) {
    if (!pendingTailorSelection) return;
    const pending = pendingTailorSelection;
    setPendingTailorSelection(null);
    setActiveResume(resume);
    setResumePreviewOpen(false);
    void runTailorJob(pending.job, resume, pending.jobIndex);
  }

  function uploadResumeForTailoring() {
    if (!userId) {
      setShowAuthModal(true);
      return;
    }
    fileRef.current?.click();
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
      if (part.type === 'tailor_questions' && part.payload) {
        const payload = part.payload as TailorQuestionsPayload;
        const isSubmitting = tailorQuestionBusy === payload.clarificationId;
        return (
          <div key={j} className="my-3 rounded-xl border border-amber-100 bg-white p-5 shadow-sm">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-amber-600">A few details first</div>
              <h3 className="mt-1 text-lg font-bold text-slate-900">
                {payload.job.title || 'This role'}{payload.job.company_name ? ` at ${payload.job.company_name}` : ''}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Answer what you know. Blank or uncertain answers will be left out of the tailored copy.
              </p>
            </div>
            <div className="mt-4 space-y-4">
              {payload.questions.slice(0, 3).map((question, index) => (
                <label key={question.id} className="block">
                  <span className="block text-sm font-bold text-slate-900">{index + 1}. {question.question}</span>
                  {question.reason && <span className="mt-1 block text-xs leading-5 text-slate-500">{question.reason}</span>}
                  <textarea
                    value={tailorQuestionAnswers[tailorAnswerKey(payload.clarificationId, question.id)] || ''}
                    onChange={e => setTailorAnswer(payload.clarificationId, question.id, e.target.value)}
                    rows={2}
                    disabled={isSubmitting}
                    className="mt-2 block w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-900 outline-none focus:border-blue-500 disabled:bg-slate-50"
                    placeholder="Short answer"
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => submitTailorAnswers(payload)}
                disabled={isSubmitting}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {isSubmitting ? 'Creating...' : 'Create tailored copy'}
              </button>
            </div>
          </div>
        );
      }
      if (part.type === 'tailor_result' && part.result) {
        const result = part.result as TailorResult;
        return (
          <div key={j} className="my-3 rounded-xl border border-blue-100 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-blue-600">Tailored resume ready</div>
                <h3 className="mt-1 text-lg font-bold text-slate-900">{result.resume.title || 'Tailored resume'}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{result.summary}</p>
              </div>
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-blue-50 text-lg font-black text-blue-700 ring-1 ring-blue-100">
                {Math.round(result.score || 0)}
              </div>
            </div>
            {!!result.improvements?.length && (
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
                {result.improvements.slice(0, 4).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
              </ul>
            )}
            {!!result.matchedKeywords?.length && (
              <div className="mt-4">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Matched keywords</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {result.matchedKeywords.slice(0, 8).map((keyword, index) => (
                    <span key={`${keyword}-${index}`} className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700">
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {!!result.missingKeywords?.length && (
              <div className="mt-4">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Left out unless confirmed</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {result.missingKeywords.slice(0, 8).map((keyword, index) => (
                    <span key={`${keyword}-${index}`} className="rounded-md bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700">
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => { setActiveResume(result.resume); setResumePreviewOpen(true); }}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800"
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => downloadResumePdf(result.downloadUrl, resumeDownloadName(result.resume, 'tailored-resume'), `tailor-${result.resume.id}`)}
                disabled={downloadBusy === `tailor-${result.resume.id}`}
                className="min-w-28 rounded-lg bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 hover:bg-blue-100 disabled:opacity-60"
              >
                {downloadBusy === `tailor-${result.resume.id}` ? 'Downloading...' : 'Download PDF'}
              </button>
            </div>
          </div>
        );
      }

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
            return <JobResults key={part.toolCallId || j} query={payload.query} jobs={payload.jobs} onTailorResume={tailorResume} tailorButtonLabel={billing?.freeTailorAvailable ? 'Tailor resume - Free' : 'Tailor resume - 1 credit'} tailoringJobKey={tailoringJobKey} />;
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
          <div key={m.id || i} className={m.role === 'user' ? 'mx-auto flex w-full max-w-3xl justify-end' : 'mx-auto w-full max-w-3xl leading-7'}>
            <div className={`whitespace-pre-wrap break-words ${m.role === 'user' ? 'max-w-[82%] rounded-2xl bg-slate-100 px-4 py-2.5' : ''} ${compact ? '' : ''}`}>
              {renderMessageParts(m)}
            </div>
          </div>
        ))}
        {busy && <div className={`text-sm text-slate-500 ${compact ? '' : 'mx-auto max-w-3xl'}`}>Working...</div>}
        {chatError && <div className={`text-sm text-red-500 ${compact ? '' : 'mx-auto max-w-3xl'}`}>{chatError.message}</div>}
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
              Free includes unlimited job search, one uploaded resume, one tailored resume, 2 starter credits, and 3 PDF downloads. AI resume actions use credits.
            </p>
          </div>

          <div className="mt-5 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 sm:grid-cols-4">
            <div>
              <span className="block text-xs font-bold uppercase text-slate-500">Credits</span>
              <b className="mt-1 block text-lg text-slate-900">{billing?.credits ?? 0}</b>
              <span className="text-xs text-slate-500">{billing?.plan === 'free' ? `${billing.starterCredits ?? 2} starter` : 'Available'}</span>
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
            <div>
              <span className="block text-xs font-bold uppercase text-slate-500">PDF downloads</span>
              <b className="mt-1 block text-lg text-slate-900">
                {billing?.pdfDownloadsLimit ? `${billing.pdfDownloadsUsed ?? 0}/${billing.pdfDownloadsLimit}` : 'Unlimited'}
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

  const connectionsDashboard = (
    <section className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">App Connections</h2>
          <p className="mt-1 text-sm text-slate-500">Connect apps so your agent can use them when you ask.</p>
        </div>
        <button onClick={() => loadConnections()} disabled={connectionsLoading} className="w-fit rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60">
          {connectionsLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {connectionsError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {connectionsError}
        </div>
      )}

      <div className="app-scroll-region grid flex-1 grid-cols-1 gap-3 pb-4 sm:grid-cols-2 xl:grid-cols-3">
        {connectionsLoading && toolkits.length === 0 && (
          <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading app connections...</div>
        )}
        {!connectionsLoading && toolkits.length === 0 && !connectionsError && (
          <div className="rounded-xl border-2 border-dashed border-slate-200 bg-white p-10 text-center text-slate-500 sm:col-span-2 xl:col-span-3">No app connections are available right now.</div>
        )}
        {toolkits.map(toolkit => {
          const busyKey = toolkit.isConnected ? toolkit.connectedAccountId : toolkit.slug;
          const busy = Boolean(busyKey && connectionBusy === busyKey);
          return (
            <div key={toolkit.slug} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex min-w-0 items-center gap-3">
                {toolkit.logo ? (
                  <img src={toolkit.logo} alt={toolkit.name} className="h-9 w-9 shrink-0 rounded-md border border-slate-100 object-contain" />
                ) : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100 text-sm font-bold text-slate-500">
                    {toolkit.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate font-bold text-slate-900">{toolkit.name}</p>
                  <p className={`text-xs font-semibold ${toolkit.isConnected ? 'text-green-600' : 'text-slate-400'}`}>
                    {toolkit.isConnected ? 'Connected' : 'Not connected'}
                  </p>
                </div>
              </div>
              {toolkit.isConnected ? (
                <button
                  onClick={() => toolkit.connectedAccountId && disconnectToolkit(toolkit.connectedAccountId)}
                  disabled={!toolkit.connectedAccountId || busy}
                  className="shrink-0 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  {busy ? 'Removing...' : 'Disconnect'}
                </button>
              ) : (
                <button
                  onClick={() => connectToolkit(toolkit.slug)}
                  disabled={busy}
                  className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {busy ? 'Opening...' : 'Connect'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );

  const composer = (
    <div className="relative z-10 mx-auto w-full max-w-3xl rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
        rows={1}
        placeholder="Ask for resume edits, career advice, or job searches..."
        className="block max-h-32 min-h-8 w-full resize-none bg-transparent px-1 py-1.5 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400"
        disabled={uploading || busy}
      />
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200 disabled:opacity-50">Attach</button>
        <button onClick={() => sendMessage()} disabled={!input.trim() || busy || uploading} className="flex h-8 min-w-14 items-center justify-center rounded-full bg-blue-600 px-3 text-xs font-bold text-white disabled:bg-slate-200 disabled:text-slate-400">Send</button>
      </div>
    </div>
  );

  const previewSheet = resumePreviewOpen && activeResume && (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-3 sm:p-5">
      <button aria-label="Close resume preview" onClick={() => setResumePreviewOpen(false)} className="absolute inset-0 cursor-default" />
      <aside className="relative z-10 flex h-[calc(100dvh-1.5rem)] w-full max-w-[760px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl sm:h-[92dvh] sm:max-h-[900px]">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4">
          <div className="min-w-0">
            <b className="block truncate text-sm text-slate-900">Resume Preview</b>
            <span className="text-xs text-slate-500">Click text to edit manually</span>
          </div>
          <div className="ml-3 flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => downloadResumePdf(resumeDownloadUrl(activeResume), resumeDownloadName(activeResume), `preview-${activeResume.id}`)}
              disabled={downloadBusy === `preview-${activeResume.id}`}
              className="min-w-28 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {downloadBusy === `preview-${activeResume.id}` ? 'Downloading...' : 'Download PDF'}
            </button>
            <button onClick={() => setResumePreviewOpen(false)} className="rounded-md px-3 py-1.5 text-sm font-bold text-slate-500 hover:bg-slate-100">x</button>
          </div>
        </div>
        <div className="app-scroll-region flex-1 bg-slate-100 p-3 sm:p-5">
          <ResumeDocument resume={activeResume} onEdit={handleManualEdit} />
        </div>
      </aside>
    </div>
  );

  const tailorResumePicker = pendingTailorSelection && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <button aria-label="Close resume picker" onClick={() => setPendingTailorSelection(null)} className="absolute inset-0 cursor-default" />
      <aside className="relative z-10 flex max-h-[92dvh] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-wide text-blue-600">Choose resume to tailor</div>
            <h2 className="mt-1 truncate text-lg font-bold text-slate-900">
              {pendingTailorSelection.job.title || 'Selected role'}{pendingTailorSelection.job.company_name ? ` at ${pendingTailorSelection.job.company_name}` : ''}
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">Select the saved resume to use as the source. A new tailored copy will be created.</p>
          </div>
          <button onClick={() => setPendingTailorSelection(null)} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-bold text-slate-500 hover:bg-slate-100">x</button>
        </div>

        <div className="app-scroll-region min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {tailorPickerLoading && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">Loading saved resumes...</div>
          )}
          {!tailorPickerLoading && resumesList.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
              <p className="text-sm text-slate-600">Upload a resume before tailoring this job.</p>
              <button
                type="button"
                onClick={uploadResumeForTailoring}
                disabled={uploading}
                className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {uploading ? 'Uploading...' : 'Upload PDF/DOCX'}
              </button>
            </div>
          )}
          {!tailorPickerLoading && resumesList.map(resume => (
            <button
              key={resume.id}
              type="button"
              onClick={() => selectResumeForTailoring(resume)}
              className="block w-full rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-blue-200 hover:bg-blue-50"
            >
              <span className="block truncate font-bold text-slate-900">{resume.title || resume.file_name || 'Untitled resume'}</span>
              <span className="mt-1 block text-xs text-slate-500">
                {resume.created_at ? `Uploaded on ${new Date(resume.created_at).toLocaleDateString()}` : 'Saved resume'}
              </span>
              {resume.summary && <span className="mt-2 block line-clamp-2 text-sm leading-6 text-slate-600">{resume.summary}</span>}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-[#f7f8fb] text-slate-900">
      {authModal}
      {billingModal}
      {previewSheet}
      {tailorResumePicker}
      <input ref={fileRef} type="file" accept=".pdf,.docx" onChange={uploadFile} className="hidden" />
      {sidebarOpen && <button aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-30 bg-slate-900/30 md:hidden" />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col gap-4 overflow-hidden bg-[#332071] px-4 py-4 text-white shadow-2xl transition-transform duration-200 md:static md:w-64 md:shadow-none ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:hidden'}`}>
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500 font-bold">R</div>
            <span className="truncate text-base font-bold">Resume AI</span>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="rounded-md px-2 py-1 text-sm font-bold text-white/70 hover:bg-white/10 hover:text-white">x</button>
        </div>
        <div className="flex flex-col gap-2">
          <button onClick={newChat} className="flex items-center gap-3 rounded-lg bg-white/15 p-3 text-sm font-bold hover:bg-white/25"><span>+</span> New Chat</button>
          <button onClick={openResumesDashboard} className={`flex items-center gap-3 rounded-lg p-3 text-sm hover:bg-white/10 ${activeView === 'resumes' ? 'bg-white/20 font-bold' : ''}`}><span>[]</span> Resumes / CVs</button>
          <button onClick={openAppsDashboard} className={`flex items-center gap-3 rounded-lg p-3 text-sm hover:bg-white/10 ${activeView === 'apps' ? 'bg-white/20 font-bold' : ''}`}><span>*</span> Apps</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="mb-2 px-2 text-xs font-bold text-white/50">CHAT HISTORY</div>
          <div className="app-scroll-region custom-scrollbar flex-1 space-y-1 pb-2">
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
      <main className="relative z-0 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-[#f7f8fb]/95 px-3 sm:px-5">
          <button onClick={() => setSidebarOpen(open => !open)} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50">
            {sidebarOpen ? 'Close' : 'Menu'}
          </button>
          {!userId ? (
            <button onClick={() => setShowAuthModal(true)} className="rounded-md bg-blue-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-blue-700">SIGN IN</button>
          ) : (
            <button onClick={() => signOut(auth)} className="rounded-md bg-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-300">SIGN OUT</button>
          )}
        </header>

        {!activeResume ? (
          activeView === 'apps' ? (
            connectionsDashboard
          ) : activeView === 'resumes' ? (
            <section className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden px-4 py-6 sm:px-6">
              <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-slate-900">My Resumes / CVs</h2>
                  {billing && (
                    <p className="mt-1 text-sm text-slate-500">
                      {planLabel} plan - {billing.credits} credits available
                      {billing.pdfDownloadsLimit ? ` - ${billing.pdfDownloadsUsed ?? 0}/${billing.pdfDownloadsLimit} PDF downloads used` : ' - unlimited PDF downloads'}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {billing && <button onClick={() => openBillingModal(paidPlan ? 'billing' : 'upgrade')} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">Billing</button>}
                  <button onClick={() => fileRef.current?.click()} disabled={uploading} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">Upload PDF/DOCX</button>
                </div>
              </div>
              {uploading && <p className="mb-4 text-sm text-slate-500">Uploading and parsing with Gemini...</p>}
              <div className="app-scroll-region grid flex-1 grid-cols-1 gap-3 pb-4">
                {resumesList.length === 0 && !uploading && (
                  <div className="rounded-xl border-2 border-dashed border-slate-200 bg-white p-10 text-center text-slate-500">No resumes uploaded yet. Click the button above to upload one.</div>
                )}
                {resumesList.map(r => (
                  <div key={r.id} className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="truncate font-bold text-slate-900">{r.title || r.file_name}</h3>
                      <p className="text-xs text-slate-500">Uploaded on {new Date(r.created_at).toLocaleDateString()}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button onClick={() => { setActiveResume(r); setResumePreviewOpen(false); setActiveView('chat'); setMessages(prev => [...prev, makeTextMessage('assistant', 'Resume loaded. Ask me to edit it, search jobs, or open the preview to edit manually.')]); }} className="rounded-md bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200">Select</button>
                      <button onClick={() => deleteResume(r.id)} className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : messages.length === 0 ? (
            <section className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4">
              <div className="w-full max-w-3xl">
                <h1 className="mb-5 text-center text-xl font-bold">How can AI Resume Agent help?</h1>
                <div className="mb-5 flex flex-wrap justify-center gap-2">
                  <button onClick={() => setInput('Find frontend jobs in Atlanta.')} className="rounded-md border bg-white px-3 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">Find jobs</button>
                  <button onClick={() => setInput('Help me target my resume for a role.')} className="rounded-md border bg-white px-3 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">Target resume</button>
                  <button onClick={() => setInput('Improve my resume score.')} className="rounded-md border bg-white px-3 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">Improve score</button>
                </div>
                {composer}
                {uploading && <p className="mt-3 text-center text-xs text-slate-500">Parsing and saving resume context with Gemini...</p>}
              </div>
            </section>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col">
              <div className="app-scroll-region flex-1 space-y-5 px-4 py-6">
                {renderMessages(false)}
              </div>
              <div className="shrink-0 border-t border-slate-200 bg-[#f7f8fb]/95 px-3 py-3 sm:px-5">
                {uploading && <p className="mx-auto mb-2 max-w-3xl text-xs text-slate-500">Parsing with Gemini...</p>}
                {composer}
              </div>
            </section>
          )
        ) : (
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-col gap-3 border-b border-slate-200 bg-[#f7f8fb]/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="min-w-0">
                <b className="block truncate text-sm text-slate-900">{activeResume.title || activeResume.file_name || 'Active resume'}</b>
                <span className="text-xs text-slate-500">Chat, tailor, or open the preview to edit manually</span>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  onClick={() => setResumePreviewOpen(open => !open)}
                  className={`rounded-lg px-4 py-2 text-xs font-bold ${resumePreviewOpen ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'}`}
                >
                  {resumePreviewOpen ? 'Hide Preview' : 'Resume Preview'}
                </button>
                <button
                  type="button"
                  onClick={() => downloadResumePdf(resumeDownloadUrl(activeResume), resumeDownloadName(activeResume), `header-${activeResume.id}`)}
                  disabled={downloadBusy === `header-${activeResume.id}`}
                  className="min-w-28 rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {downloadBusy === `header-${activeResume.id}` ? 'Downloading...' : 'Download PDF'}
                </button>
                <button onClick={openResumesDashboard} className="rounded-lg px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-100">RESUMES</button>
              </div>
            </div>
            <div className="app-scroll-region flex-1 space-y-5 px-4 py-6">
              {renderMessages(false)}
            </div>
            <div className="shrink-0 border-t border-slate-200 bg-[#f7f8fb]/95 px-3 py-3 sm:px-5">
              {uploading && <p className="mx-auto mb-2 max-w-3xl text-xs text-slate-500">Parsing with Gemini...</p>}
              {composer}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

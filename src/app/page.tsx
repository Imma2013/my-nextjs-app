'use client';

import { useEffect, useRef, useState } from 'react';
import ResumeDocument from '@/components/ResumeDocument';
import { supabase } from '@/lib/supabase';

type Message = { role: 'user' | 'assistant'; content: string };
type ResumeContext = { id: string; title?: string; file_name?: string; summary?: string; candidate_name?: string; headline?: string; preview_url?: string; parsed_json?: any };
type ChatSession = { id: string; title: string; resumes?: ResumeContext | null };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeResume, setActiveResume] = useState<ResumeContext | null>(null);
  const [userId, setUserId] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    const key = 'resume-agent-user-id';
    const id = localStorage.getItem(key) || `guest-${crypto.randomUUID()}`;
    localStorage.setItem(key, id);
    setUserId(id);
  }, []);
  useEffect(() => { if (userId) loadSessions(userId); }, [userId]);
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

  async function loadChat(id: string) {
    const res = await fetch(`/api/chat/sessions/${id}?userId=${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (!res.ok) return;
    setActiveSessionId(id);
    setActiveResume(data.session?.resumes || null);
    setMessages(data.messages || []);
  }

  function newChat() {
    setActiveSessionId(null);
    setActiveResume(null);
    setMessages([]);
    setInput('');
  }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
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
      setMessages([{ role: 'assistant', content: `✅ ${data.message}\n\nYour resume is now attached. The left pane is the stable preview; the right pane is for AI edits and questions.` }]);
    } catch (err) {
      setMessages([{ role: 'assistant', content: '❌ ' + (err instanceof Error ? err.message : 'Upload failed') }]);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function sendMessage(text?: string) {
    const msg = text ?? input;
    if (!msg.trim()) return;
    setInput('');
    const next: Message[] = [...messages, { role: 'user', content: msg }];
    setMessages(next);
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, userId, sessionId: activeSessionId, resumeId: activeResume?.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Chat failed');
      setMessages([...next, { role: 'assistant', content: data.reply }]);
      if (data.sessionId) setActiveSessionId(data.sessionId);
      if (data.resume) setActiveResume(data.resume);
      await loadSessions();
    } catch (err) {
      setMessages([...next, { role: 'assistant', content: '❌ ' + (err instanceof Error ? err.message : 'Chat failed') }]);
    } finally {
      setBusy(false);
    }
  }

  const prompt = <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <textarea
      value={input}
      onChange={e => setInput(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
      rows={activeResume ? 3 : 5}
      placeholder="Describe your task or question, or attach a resume..."
      className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-slate-400"
      disabled={uploading}
    />
    <div className="flex items-center justify-between">
      <button onClick={() => fileRef.current?.click()} disabled={uploading} className="rounded-full bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200">+ Attach a Resume</button>
      <button onClick={() => sendMessage()} disabled={!input.trim() || busy || uploading} className="h-9 w-9 rounded-full bg-blue-600 text-white disabled:bg-slate-200 disabled:text-slate-400">↑</button>
    </div>
  </div>;

  return <div className="flex h-screen overflow-hidden bg-[#f7f8fb] text-slate-900">
    <input ref={fileRef} type="file" accept=".pdf,.docx" onChange={uploadFile} className="hidden" />
    <aside className="flex w-20 shrink-0 flex-col items-center gap-5 bg-[#332071] py-6 text-white">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-fuchsia-500 font-bold">R</div>
      <button onClick={newChat} className="h-10 w-10 rounded-lg bg-white/15 text-xl hover:bg-white/25">+</button>
      <button onClick={() => fileRef.current?.click()} className="h-10 w-10 rounded-lg hover:bg-white/10">📄</button>
      <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto px-2">
        {sessions.map(s => <button key={s.id} title={s.title} onClick={() => loadChat(s.id)} className="block h-10 w-10 rounded-lg hover:bg-white/10">💬</button>)}
      </div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <button onClick={() => loadSessions()} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-xs font-bold shadow-sm">↺ RECENT CHATS</button>
        <button onClick={newChat} className="rounded-md bg-blue-600 px-4 py-2 text-xs font-bold text-white">+ NEW CHAT</button>
      </div>

      {!activeResume ? <section className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-full max-w-3xl">
          <h1 className="mb-5 text-center text-xl font-bold">How can AI Resume Agent help with your resume and job search?</h1>
          <div className="mb-8 flex justify-center gap-3">
            <button onClick={() => setInput('Improve my resume score.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm">✦ IMPROVE MY REZI SCORE</button>
            <button onClick={() => setInput('Help me target my resume for a role.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm">🎯 TARGET MY RESUME</button>
            <button onClick={() => setInput('Help me find jobs for this resume.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm">📄 FIND JOBS</button>
          </div>
          {prompt}
          {uploading && <p className="mt-3 text-center text-xs text-slate-500">Parsing and saving resume context with Gemini...</p>}
        </div>
      </section> : <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_430px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex min-w-0 flex-col border-r border-slate-200">
          <div className="flex h-14 items-center justify-center border-b border-slate-200"><div className="rounded-lg border bg-slate-50 p-1"><button className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-bold text-white">RESUME</button><button onClick={() => sendMessage('Help me tailor this resume to a specific job search.')} className="rounded-md px-3 py-1.5 text-xs font-bold">JOB SEARCH</button></div></div>
          <div className="flex h-12 items-center justify-between border-b border-slate-200 px-5"><b>Resume</b><span className="text-xs text-slate-500">Live preview</span></div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 p-7"><ResumeDocument resume={activeResume} /></div>
        </div>
        <aside className="flex min-w-0 flex-col">
          <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-5"><button className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold">💬 CHAT</button><button className="rounded-lg px-4 py-2 text-xs font-bold">▤ CONTEXT</button></div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            <div className="w-40 rounded-lg border p-2 shadow-sm"><div className="flex h-20 items-center justify-center rounded bg-slate-100 text-xs font-bold text-blue-600">AI AGENT</div><div className="mt-2 flex justify-between"><div><b className="text-sm">Resume</b><p className="text-xs text-slate-500">Resume Uploaded</p></div><span className="text-blue-600">✓</span></div></div>
            {messages.map((m, i) => <div key={i} className={m.role === 'user' ? 'rounded-xl bg-slate-100 p-3' : 'leading-7'}><div className="whitespace-pre-wrap">{m.content}</div></div>)}
            {busy && <div className="text-sm text-slate-500">Thinking...</div>}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-slate-200 p-5">{uploading && <p className="mb-2 text-xs text-slate-500">Parsing with Gemini...</p>}{prompt}</div>
        </aside>
      </section>}
    </main>
  </div>;
}

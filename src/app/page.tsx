'use client';
import { useEffect, useRef, useState } from 'react';
import ResumeDocument from '@/components/ResumeDocument';
import { supabase } from '@/lib/supabase';

type Message = { role: 'user' | 'assistant'; content: string };
type ResumeContext = { id: string; title: string; file_name?: string; summary?: string; candidate_name?: string; headline?: string; preview_url?: string; parsed_json?: any };
type ChatSession = { id: string; title: string; resumes?: ResumeContext | null };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeResume, setActiveResume] = useState<ResumeContext | null>(null);
  const [userId, setUserId] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    const id = localStorage.getItem('resume-agent-user-id') ?? `guest-${crypto.randomUUID()}`;
    localStorage.setItem('resume-agent-user-id', id);
    setUserId(id);
  }, []);
  useEffect(() => { if (userId) loadSessions(userId); }, [userId]);
  useEffect(() => {
    if (!activeResume?.id) return;
    const channel = supabase.channel(`resume-${activeResume.id}`).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'resumes', filter: `id=eq.${activeResume.id}` }, payload => {
      setActiveResume(prev => prev?.id === payload.new.id ? { ...prev, ...payload.new } as ResumeContext : prev);
    }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeResume?.id]);

  async function loadSessions(uid = userId) {
    if (!uid) return;
    const res = await fetch(`/api/chat/sessions?userId=${encodeURIComponent(uid)}`);
    const data = await res.json();
    if (res.ok) setSessions(data.sessions ?? []);
  }
  async function loadChat(id: string) {
    const res = await fetch(`/api/chat/sessions/${id}?userId=${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (res.ok) { setActiveSessionId(id); setActiveResume(data.session?.resumes ?? null); setMessages(data.messages ?? []); }
  }
  function newChat() { setActiveSessionId(null); setActiveResume(null); setMessages([]); setInput(''); }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('userId', userId); if (activeSessionId) fd.append('sessionId', activeSessionId);
      const res = await fetch('/api/resumes', { method: 'POST', body: fd });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Upload failed');
      setActiveResume(data.resume); if (data.sessionId) setActiveSessionId(data.sessionId); await loadSessions();
      setMessages(prev => [...prev, { role: 'assistant', content: `✅ ${data.message}\n\nI rendered it as a live JSON resume preview on the left. Ask me to edit any section.` }]);
    } catch (err) { setMessages(prev => [...prev, { role: 'assistant', content: '❌ ' + (err instanceof Error ? err.message : 'Upload failed') }]); }
    finally { setUploading(false); e.target.value = ''; }
  }

  async function sendMessage(text?: string) {
    const msg = text ?? input; if (!msg.trim()) return;
    setInput(''); const next = [...messages, { role: 'user' as const, content: msg }]; setMessages(next); setLoading(true);
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: next, userId, sessionId: activeSessionId, resumeId: activeResume?.id }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Chat failed');
      setMessages([...next, { role: 'assistant', content: data.reply }]); if (data.sessionId) setActiveSessionId(data.sessionId); if (data.resume) setActiveResume(data.resume); await loadSessions();
    } catch (err) { setMessages([...next, { role: 'assistant', content: '❌ ' + (err instanceof Error ? err.message : 'Chat failed') }]); }
    finally { setLoading(false); }
  }

  return <div className="flex h-screen overflow-hidden bg-[#f7f8fb] text-slate-900">
    <input ref={fileRef} type="file" accept=".pdf,.docx" onChange={uploadFile} className="hidden" />
    <aside className="w-20 shrink-0 bg-[#332071] text-white flex flex-col items-center py-6 gap-5"><div className="h-10 w-10 rounded-lg bg-fuchsia-500 flex items-center justify-center font-bold">R</div><button onClick={newChat} className="h-10 w-10 rounded-lg bg-white/15">+</button><button onClick={() => fileRef.current?.click()} className="h-10 w-10 rounded-lg hover:bg-white/10">📄</button><div className="mt-4 space-y-2 overflow-y-auto">{sessions.map(s => <button key={s.id} onClick={() => loadChat(s.id)} title={s.title} className="block h-10 w-10 rounded-lg hover:bg-white/10">💬</button>)}</div></aside>
    <main className="flex-1 p-6 min-w-0 flex flex-col gap-4"><div className="flex justify-between"><button onClick={() => loadSessions()} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm">↺ RECENT CHATS</button><button onClick={newChat} className="rounded-md bg-blue-600 px-4 py-2 text-xs font-bold text-white">+ NEW CHAT</button></div><div className="min-h-0 flex-1 grid grid-cols-[minmax(0,1fr)_430px] rounded-xl border bg-white shadow-sm overflow-hidden">
      <section className="min-w-0 flex flex-col border-r"><div className="h-14 border-b flex items-center justify-between px-5"><b>Resume</b><span className="text-xs text-slate-500">Live JSON preview</span></div><div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-7"><ResumeDocument resume={activeResume} />{activeResume?.preview_url && <div className="mx-auto mt-4 max-w-[850px] rounded-lg border bg-white p-3 text-xs text-slate-500">Original PDF saved for reference. AI edits update the JSON preview above.</div>}</div></section>
      <aside className="min-w-0 flex flex-col"><div className="h-14 border-b px-5 flex items-center gap-2"><button className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold">💬 CHAT</button><button className="rounded-lg px-4 py-2 text-xs font-bold">▤ CONTEXT</button></div><div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-5">{activeResume && <div className="w-40 rounded-lg border p-2 shadow-sm"><div className="h-20 rounded bg-slate-100 flex items-center justify-center text-blue-600 text-xs font-bold">AI AGENT</div><div className="mt-2 flex justify-between"><div><b className="text-sm">Resume</b><p className="text-xs text-slate-500">Resume Uploaded</p></div><span className="text-blue-600">✓</span></div></div>}{messages.length === 0 ? <p className="leading-7">{activeResume ? 'I received your resume. Ask me to analyze, tailor, or rewrite it.' : 'Upload a resume or ask me a resume question to get started.'}</p> : messages.map((m,i) => <div key={i} className={m.role === 'user' ? 'rounded-xl bg-slate-100 p-3' : 'leading-7'}><div className="whitespace-pre-wrap">{m.content}</div></div>)}{loading && <div className="text-sm text-slate-500">Thinking...</div>}<div ref={bottomRef}/></div><div className="border-t p-5">{uploading && <p className="mb-2 text-xs text-slate-500">Parsing with Gemini...</p>}<div className="rounded-md border-2 border-blue-500 p-3"><textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}}} placeholder="Write a reply..." rows={3} className="w-full resize-none outline-none text-sm"/><div className="flex justify-between"><button onClick={() => fileRef.current?.click()} className="h-8 w-8 rounded-full bg-slate-100">+</button><button disabled={!input.trim() || loading} onClick={() => sendMessage()} className="h-9 w-9 rounded-full bg-slate-200 disabled:opacity-40">↑</button></div></div></div></aside>
    </div></main>
  </div>;
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { auth, onAuthStateChanged, googleProvider } from '@/lib/firebase';
import { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import ResumeDocument from '@/components/ResumeDocument';
import JobSearch from '@/components/JobSearch';

type Message = { role: 'user' | 'assistant'; content: string };
type ResumeContext = { id: string; title?: string; file_name?: string; summary?: string; candidate_name?: string; headline?: string; preview_url?: string; parsed_json?: any };
type ChatSession = { id: string; title: string; resumes?: ResumeContext | null };
type EditPayload = { operation: 'replace' | 'add' | 'remove'; path: string; value?: unknown };
const EDIT_RE = /\b(edit|change|update|replace|rename|set|make|rewrite|add|remove|delete)\b/i;

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeResume, setActiveResume] = useState<ResumeContext | null>(null);
  const [activeTab, setActiveTab] = useState<'resume' | 'jobs'>('resume');
  const [userId, setUserId] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  
  // Auth state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [resumesList, setResumesList] = useState<any[]>([]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { 
    const unsubscribe = onAuthStateChanged(auth, async (user) => { 
      if (user) {
        setUserId(user.uid);
        setShowAuthModal(false);
      } else {
        setUserId(''); 
      }
    }); 
    return () => unsubscribe(); 
  }, []);
  useEffect(() => { if (userId) { loadSessions(userId); loadResumes(userId); } }, [userId]);
  useEffect(() => { 
    if (!activeResume?.id) return; 
    const c = supabase.channel(`resume-${activeResume.id}`).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'resumes', filter: `id=eq.${activeResume.id}` }, payload => setActiveResume(prev => prev?.id === payload.new.id ? { ...prev, ...payload.new } as ResumeContext : prev)).subscribe(); 
    return () => { supabase.removeChannel(c); }; 
  }, [activeResume?.id]);

  async function loadSessions(uid = userId) { if (!uid) return; const res = await fetch(`/api/chat/sessions?userId=${encodeURIComponent(uid)}`); const data = await res.json(); if (res.ok) setSessions(data.sessions || []); }
  async function loadResumes(uid = userId) { if (!uid) return; const res = await fetch(`/api/resumes?userId=${encodeURIComponent(uid)}`); const data = await res.json(); if (res.ok) setResumesList(data.resumes || []); }
  async function deleteResume(id: string) {
    if (!userId) return;
    if (!confirm('Are you sure you want to delete this resume?')) return;
    const res = await fetch(`/api/resumes?userId=${encodeURIComponent(userId)}&resumeId=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      if (activeResume?.id === id) setActiveResume(null);
      loadResumes(userId);
    }
  }
  async function loadChat(id: string) { const res = await fetch(`/api/chat/sessions/${id}?userId=${encodeURIComponent(userId)}`); const data = await res.json(); if (res.ok) { setActiveSessionId(id); setActiveResume(data.session?.resumes || null); setMessages(data.messages || []); setShowDashboard(false); } }
  function newChat() { setActiveSessionId(null); setActiveResume(null); setMessages([]); setInput(''); setShowDashboard(false); }
  
  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) { 
    const file = e.target.files?.[0]; 
    if (!file) return; 
    if (!userId) {
      setShowAuthModal(true);
      return;
    }
    setUploading(true); 
    try { 
      const fd = new FormData(); fd.append('file', file); fd.append('userId', userId); 
      if (activeSessionId) fd.append('sessionId', activeSessionId); 
      const res = await fetch('/api/resumes', { method: 'POST', body: fd }); 
      const data = await res.json(); 
      if (!res.ok) throw new Error(data.error || 'Upload failed'); 
      setActiveResume(data.resume); 
      if (data.sessionId) setActiveSessionId(data.sessionId); 
      await loadSessions(); 
      setMessages([{ role: 'assistant', content: 'Resume uploaded and converted into editable structured data. Ask me to edit it, or click directly in the preview to edit manually.' }]); 
    } catch (err) { 
      setMessages([{ role: 'assistant', content: 'Upload failed: ' + (err instanceof Error ? err.message : 'Unknown error') }]); 
    } finally { 
      setUploading(false); e.target.value = ''; 
    } 
  }
  
  async function saveResumeEdit(edit: EditPayload | { message: string }) { if (!activeResume || !userId) throw new Error('No active resume'); const res = await fetch('/api/resume-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resumeId: activeResume.id, userId, edit: 'path' in edit ? edit : undefined, message: 'message' in edit ? edit.message : undefined }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Resume edit failed'); if (!data.resume) throw new Error(data.reply || 'Could not map this to a saved resume field'); setActiveResume(data.resume); return data.reply || 'Updated the resume preview.'; }
  async function handleManualEdit(edit: EditPayload) { 
    if (!userId) { setShowAuthModal(true); return; }
    try { await saveResumeEdit(edit); } catch (err) { setMessages(prev => [...prev, { role: 'assistant', content: 'Manual edit failed: ' + (err instanceof Error ? err.message : 'Unknown error') }]); } 
  }
  
  async function sendMessage(text?: string) { 
    const msg = text ?? input; 
    if (!msg.trim()) return; 
    if (!userId) {
      setShowAuthModal(true);
      return;
    }
    setInput(''); 
    const next: Message[] = [...messages, { role: 'user', content: msg }]; 
    setMessages(next); 
    setBusy(true); 
    try { 
      if (activeResume && EDIT_RE.test(msg)) { 
        const reply = await saveResumeEdit({ message: msg }); 
        setMessages([...next, { role: 'assistant', content: reply }]); 
        await loadSessions(); 
        return; 
      } 
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: next, userId, sessionId: activeSessionId, resumeId: activeResume?.id }) }); 
      const data = await res.json(); 
      if (!res.ok) throw new Error(data.error || 'Chat failed'); 
      setMessages([...next, { role: 'assistant', content: data.reply }]); 
      if (data.sessionId) setActiveSessionId(data.sessionId); 
      if (data.resume) setActiveResume(data.resume); 
      await loadSessions(); 
    } catch (err) { 
      setMessages([...next, { role: 'assistant', content: 'I understood this, but could not complete it: ' + (err instanceof Error ? err.message : 'Unknown error') }]); 
    } finally { 
      setBusy(false); 
    } 
  }
  
  const handleAuth = async (e: React.FormEvent) => {
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

  const authModal = showAuthModal && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-xl bg-white p-8 shadow-2xl">
        <button onClick={() => setShowAuthModal(false)} className="absolute right-4 top-4 text-slate-400 hover:text-slate-600">✕</button>
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
          {isLogin ? "Don't have an account?" : "Already have an account?"}{' '}
          <button onClick={() => setIsLogin(!isLogin)} className="font-bold text-blue-600 hover:underline">{isLogin ? 'Sign Up' : 'Sign In'}</button>
        </p>
      </div>
    </div>
  );

  const composer = (
    <div className="shrink-0 rounded-xl border-2 border-blue-500 bg-white p-4 shadow-sm relative z-10">
      <textarea 
        value={input} 
        onChange={e => setInput(e.target.value)} 
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} 
        rows={activeResume ? 3 : 5} 
        placeholder="Ask for a resume edit, career advice, or attach a PDF/DOCX..." 
        className="block w-full resize-none bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400" 
        disabled={uploading || busy} 
      />
      <div className="mt-3 flex items-center justify-between">
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="rounded-full bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200 disabled:opacity-50">+ Attach a Resume</button>
        <button onClick={() => sendMessage()} disabled={!input.trim() || busy || uploading} className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-white disabled:bg-slate-200 disabled:text-slate-400">↑</button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-[#f7f8fb] text-slate-900">
      {authModal}
      <input ref={fileRef} type="file" accept=".pdf,.docx" onChange={uploadFile} className="hidden" />
      <aside className="flex h-full w-64 shrink-0 flex-col gap-5 overflow-hidden bg-[#332071] py-6 px-4 text-white relative z-0">
        <div className="flex items-center gap-3 px-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500 font-bold">R</div>
          <span className="font-bold text-lg">Resume AI</span>
        </div>
        <div className="flex flex-col gap-2">
          <button onClick={newChat} className="flex items-center gap-3 rounded-lg bg-white/15 p-3 text-sm font-bold hover:bg-white/25"><span>+</span> New Chat</button>
          <button onClick={() => { if (!userId) { setShowAuthModal(true); return; } setShowDashboard(true); setActiveResume(null); loadResumes(); }} className={`flex items-center gap-3 rounded-lg p-3 text-sm hover:bg-white/10 ${showDashboard ? 'bg-white/20 font-bold' : ''}`}><span>📄</span> Resumes / CVs</button>
        </div>
        <div className="min-h-0 flex-1 flex flex-col overflow-hidden">
          <div className="text-xs font-bold text-white/50 px-2 mb-2">CHAT HISTORY</div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-2 custom-scrollbar">
            {userId && sessions.map(s => (
              <button key={s.id} title={s.title} onClick={() => loadChat(s.id)} className={`flex w-full items-center gap-3 rounded-lg p-3 text-sm text-left hover:bg-white/10 ${activeSessionId === s.id ? 'bg-white/20 font-bold' : ''}`}>
                <span>💬</span>
                <span className="truncate">{s.title}</span>
              </button>
            ))}
            {userId && sessions.length === 0 && (
              <div className="text-sm text-white/50 px-2 italic">No past chats</div>
            )}
            {!userId && (
              <div className="text-sm text-white/50 px-2 italic">Sign in to view history</div>
            )}
          </div>
        </div>
        {userId && (
          <div className="mt-auto pt-4 border-t border-white/10">
            <button onClick={() => signOut(auth)} className="flex w-full items-center gap-3 rounded-lg hover:bg-red-500/20 p-3 text-sm font-bold" title="Sign Out">
              <span>🚪</span> Sign Out
            </button>
          </div>
        )}
      </aside>
      <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-6 relative z-0">
        <div className="flex shrink-0 items-center justify-between">
          <div className="flex items-center gap-2">
            {userId && <button onClick={() => loadSessions()} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-xs font-bold shadow-sm">↺ RECENT CHATS</button>}
          </div>
          <div className="flex items-center gap-3">
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
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white rounded-xl border border-slate-200 shadow-sm w-full max-w-5xl mx-auto my-4 p-8">
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-2xl font-bold text-slate-900">My Resumes / CVs</h2>
                <button onClick={() => fileRef.current?.click()} disabled={uploading} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">+ Upload New PDF/DOCX</button>
              </div>
              {uploading && <p className="mb-4 text-sm text-slate-500">Uploading and parsing with Gemini...</p>}
              <div className="grid grid-cols-1 gap-4 overflow-y-auto pb-4">
                {resumesList.length === 0 && !uploading && (
                  <div className="text-center p-12 border-2 border-dashed border-slate-200 rounded-xl text-slate-500">No resumes uploaded yet. Click the button above to upload one!</div>
                )}
                {resumesList.map(r => (
                  <div key={r.id} className="flex items-center justify-between p-4 border border-slate-200 rounded-xl hover:bg-slate-50">
                    <div>
                      <h3 className="font-bold text-slate-900">{r.title || r.file_name}</h3>
                      <p className="text-xs text-slate-500">Uploaded on {new Date(r.created_at).toLocaleDateString()}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => { setActiveResume(r); setShowDashboard(false); setMessages([{ role: 'assistant', content: 'Resume loaded. Ask me to edit it, or click directly in the preview to edit manually.' }]); }} className="rounded-md bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200">Select for Chat</button>
                      <button onClick={() => deleteResume(r.id)} className="rounded-md bg-red-50 text-red-600 px-3 py-1.5 text-xs font-bold hover:bg-red-100">Delete</button>
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
                  <button onClick={() => setInput('Improve my resume score.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">IMPROVE MY SCORE</button>
                  <button onClick={() => setInput('Help me target my resume for a role.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">TARGET MY RESUME</button>
                  <button onClick={() => setInput('Add React to my skills.')} className="rounded-md border bg-white px-4 py-2 text-xs font-bold shadow-sm hover:bg-slate-50">ADD SKILL</button>
                </div>
                {composer}
                {uploading && <p className="mt-3 text-center text-xs text-slate-500">Parsing and saving resume context with Gemini...</p>}
              </div>
            </section>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white rounded-xl border border-slate-200 shadow-sm w-full max-w-5xl mx-auto my-4">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-5">
                <b className="text-sm">AI Chat</b>
              </div>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 overscroll-contain">
                {messages.map((m, i) => (
                  <div key={i} className={m.role === 'user' ? 'rounded-xl bg-slate-100 p-3 max-w-3xl mx-auto' : 'leading-7 max-w-3xl mx-auto'}>
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  </div>
                ))}
                {busy && <div className="text-sm text-slate-500 max-w-3xl mx-auto">Working...</div>}
                <div ref={bottomRef} />
              </div>
              <div className="shrink-0 border-t border-slate-200 p-5">
                <div className="max-w-3xl mx-auto">
                  {uploading && <p className="mb-2 text-xs text-slate-500">Parsing with Gemini...</p>}
                  {composer}
                </div>
              </div>
            </section>
          )
        ) : (
          <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_430px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-slate-200">
              <div className="flex h-14 shrink-0 items-center justify-center border-b border-slate-200">
                <div className="rounded-lg border bg-slate-50 p-1 flex gap-1">
                  <button onClick={() => setActiveTab('resume')} className={`rounded-md px-3 py-1.5 text-xs font-bold ${activeTab === 'resume' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-200'}`}>RESUME</button>
                  <button onClick={() => setActiveTab('jobs')} className={`rounded-md px-3 py-1.5 text-xs font-bold ${activeTab === 'jobs' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-200'}`}>JOB SEARCH</button>
                </div>
              </div>
              {activeTab === 'resume' ? (
                <>
                  <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-5">
                    <b>Resume</b><span className="text-xs text-slate-500">Click text to edit manually</span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-100 p-7 overscroll-contain">
                    <ResumeDocument resume={activeResume} onEdit={handleManualEdit} />
                  </div>
                </>
              ) : (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <JobSearch />
                </div>
              )}
            </div>
            <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
              <div className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 px-5">
                <button className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold">CHAT</button>
                <button className="rounded-lg px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-50">CONTEXT</button>
              </div>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden p-5 overscroll-contain">
                <div className="w-40 rounded-lg border p-2 shadow-sm">
                  <div className="flex h-20 items-center justify-center rounded bg-slate-100 text-xs font-bold text-blue-600">AI AGENT</div>
                  <div className="mt-2 flex justify-between"><div><b className="text-sm">Resume</b><p className="text-xs text-slate-500">Editable</p></div><span className="text-blue-600">✓</span></div>
                </div>
                {messages.map((m, i) => (
                  <div key={i} className={m.role === 'user' ? 'rounded-xl bg-slate-100 p-3' : 'leading-7'}>
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  </div>
                ))}
                {busy && <div className="text-sm text-slate-500">Working...</div>}
                <div ref={bottomRef} />
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

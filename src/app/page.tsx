'use client';
import { useState, useRef, useEffect } from 'react';

type Message = { role: 'user' | 'assistant'; content: string; created_at?: string };
type ResumeContext = { id: string; title: string; file_name?: string; summary?: string; candidate_name?: string; headline?: string };
type ChatSession = { id: string; user_id: string; title: string; resume_id?: string | null; resumes?: ResumeContext | null; created_at: string; updated_at: string };
type OptimizeResult = {
  score: number;
  strengths: string[];
  gaps: string[];
  suggestions: string[];
  optimized_summary: string;
};
type View = 'chat' | 'optimizer';

const QUICK_ACTIONS = [
  { label: 'Improve My Score', icon: '⚡', prompt: 'How can I improve my resume score and make it more ATS-friendly?' },
  { label: 'Target My Resume', icon: '🎯', prompt: 'Help me tailor my resume to a specific job description.' },
  { label: 'Find Gaps', icon: '🔍', prompt: 'What are the most common skill gaps in resumes for tech roles?' },
];

const ATTACH_OPTIONS = [
  { label: 'Upload PDF or DOCX', icon: '📄' },
  { label: 'Paste Resume Text', icon: '📋' },
  { label: 'Add from LinkedIn', icon: '🔗' },
];

export default function Home() {
  const [view, setView] = useState<View>('chat');
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeResume, setActiveResume] = useState<ResumeContext | null>(null);
  const [userId, setUserId] = useState('');
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [pastedResume, setPastedResume] = useState('');
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Optimizer
  const [resume, setResume] = useState('');
  const [jobDesc, setJobDesc] = useState('');
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [optimizeLoading, setOptimizeLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    const existing = localStorage.getItem('resume-agent-user-id');
    const id = existing ?? `guest-${crypto.randomUUID()}`;
    if (!existing) localStorage.setItem('resume-agent-user-id', id);
    setUserId(id);
  }, []);

  useEffect(() => {
    if (!userId) return;
    loadSessions(userId);
  }, [userId]);

  async function loadSessions(currentUserId = userId) {
    if (!currentUserId) return;
    setLoadingSessions(true);
    try {
      const res = await fetch(`/api/chat/sessions?userId=${encodeURIComponent(currentUserId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load chats');
      setSessions(data.sessions ?? []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingSessions(false);
    }
  }

  async function loadChat(sessionId: string) {
    if (!userId) return;
    setChatLoading(true);
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}?userId=${encodeURIComponent(userId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load chat');
      setActiveSessionId(sessionId);
      setActiveResume(data.session?.resumes ?? null);
      setMessages(data.messages ?? []);
      setView('chat');
    } catch (e: unknown) {
      setMessages([{ role: 'assistant', content: '❌ ' + (e instanceof Error ? e.message : 'Failed to load chat') }]);
    } finally {
      setChatLoading(false);
    }
  }

  function startNewChat() {
    setActiveSessionId(null);
    setActiveResume(null);
    setMessages([]);
    setInput('');
    setView('chat');
  }


  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function sendMessage(text?: string) {
    const msg = text ?? input;
    if (!msg.trim()) return;
    setInput('');
    const newMessages: Message[] = [...messages, { role: 'user', content: msg }];
    setMessages(newMessages);
    setChatLoading(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, userId, sessionId: activeSessionId, resumeId: activeResume?.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      setMessages([...newMessages, { role: 'assistant', content: data.reply }]);
      if (data.sessionId) setActiveSessionId(data.sessionId);
      if (data.resume) setActiveResume(data.resume);
      await loadSessions();
    } catch (e: unknown) {
      setMessages([...newMessages, { role: 'assistant', content: '❌ ' + (e instanceof Error ? e.message : 'Something went wrong') }]);
    } finally {
      setChatLoading(false);
    }
  }

  async function handleOptimize() {
    if (!resume.trim() || !jobDesc.trim()) { setError('Please fill in both fields.'); return; }
    setError('');
    setOptimizeLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume, jobDescription: jobDesc }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unexpected error');
    } finally {
      setOptimizeLoading(false);
    }
  }

  function handleAttachOption(label: string) {
    setShowAttachMenu(false);
    if (label === 'Upload PDF or DOCX') {
      fileInputRef.current?.click();
    } else if (label === 'Paste Resume Text') {
      setShowPasteModal(true);
    } else if (label === 'Add from LinkedIn') {
      setInput(prev => prev + ' [LinkedIn profile attached] ');
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingFile(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('userId', userId);
      if (activeSessionId) formData.append('sessionId', activeSessionId);

      const res = await fetch('/api/resumes', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to parse file');

      setActiveResume(data.resume);
      if (data.sessionId) setActiveSessionId(data.sessionId);
      await loadSessions();
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `✅ ${data.message}

I can now use this resume as context. Tell me the job/company you want to target, or ask for a quick resume analysis.`
      }]);

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Failed to parse file';
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${errMsg}` }]);
    } finally {
      setUploadingFile(false);
      e.target.value = '';
    }
  }

  function confirmPaste() {
    if (pastedResume.trim()) {
      setResume(pastedResume);
      setView('optimizer');
    }
    setShowPasteModal(false);
    setPastedResume('');
  }

  const scoreColor = result
    ? result.score >= 75 ? 'text-green-400' : result.score >= 50 ? 'text-yellow-400' : 'text-red-400'
    : '';

  return (
    <div className="flex h-screen bg-[#f7f8fb] text-slate-900 overflow-hidden">
      <input ref={fileInputRef} type="file" accept=".pdf,.docx" className="hidden" onChange={handleFileUpload} />

      {/* Sidebar */}
      <aside className="w-[76px] flex flex-col items-center py-6 bg-[#332071] text-white flex-shrink-0 overflow-hidden">
        <div className="flex flex-col items-center gap-2 mb-10">
          <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-fuchsia-500 rounded-lg flex items-center justify-center font-bold text-sm select-none">R</div>
          <div className="hidden">Resume Agent</div>
        </div>

        <div className="px-3 space-y-2">
          <button onClick={startNewChat}
            className="h-10 w-10 rounded-lg bg-white/15 hover:bg-white/25 flex items-center justify-center text-lg overflow-hidden">
            +
          </button>
          <button onClick={() => setView('optimizer')}
            className={`h-10 w-10 rounded-lg flex items-center justify-center transition-all ${view === 'optimizer' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5 hover:text-white'}`}>
            📄
          </button>
        </div>

        <div className="hidden">Saved chats</div>
        <div className="mt-6 flex-1 overflow-y-auto px-2 space-y-2 w-full">
          {loadingSessions ? (
            <div className="px-2 py-2 text-[10px] text-white/45 text-center">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-2 text-[10px] text-white/45 text-center">No saved chats yet</div>
          ) : sessions.map(session => (
            <button key={session.id} onClick={() => loadChat(session.id)}
              className={`mx-auto h-10 w-10 rounded-lg text-center text-sm truncate transition-all flex items-center justify-center ${
                activeSessionId === session.id ? 'bg-white/12 text-white' : 'text-slate-600 hover:bg-white/6 hover:text-white/85'
              }`}
              title={session.title}
            >
              💬
            </button>
          ))}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden bg-[#f7f8fb] p-6">
        {view === 'chat' ? (
          <>
            <div className="mb-4 flex items-center justify-between"><button onClick={loadSessions} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-sm">↺ RECENT CHATS</button><button onClick={startNewChat} className="rounded-md bg-blue-600 px-4 py-2 text-xs font-bold text-white shadow-sm">+ NEW CHAT</button></div>
            <div className="flex-1 overflow-y-auto px-6 py-6 rounded-xl border border-slate-200 bg-white shadow-sm">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
                  <h1 className="text-2xl font-semibold text-slate-900">How can AI Resume Agent help with your resume and job search?</h1>
                  <div className="flex flex-wrap gap-3 justify-center">
                    {QUICK_ACTIONS.map(a => (
                      <button key={a.label} onClick={() => sendMessage(a.prompt)}
                        className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2.5 rounded-full text-sm font-medium transition-all">
                        <span>{a.icon}</span>{a.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="max-w-5xl mx-auto space-y-6">
                  {messages.map((m, i) => (
                    <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {m.role === 'assistant' && (
                        <div className="w-7 h-7 rounded-full bg-[#332071] flex items-center justify-center text-xs font-bold flex-shrink-0 mt-1">R</div>
                      )}
                      <div className={`max-w-[75%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                        m.role === 'user' ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-white text-slate-800 rounded-tl-sm border border-slate-200 shadow-sm'
                      }`}>{m.content}</div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex gap-3">
                      <div className="w-7 h-7 rounded-full bg-[#332071] flex items-center justify-center text-xs font-bold flex-shrink-0">R</div>
                      <div className="bg-white border border-slate-200 px-4 py-3 rounded-2xl rounded-tl-sm shadow-sm">
                        <span className="flex gap-1 items-center">
                          <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{animationDelay:'0ms'}} />
                          <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{animationDelay:'150ms'}} />
                          <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{animationDelay:'300ms'}} />
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>


                {activeResume && (
                  <div className="max-w-3xl mx-auto mb-3 rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs uppercase tracking-wide text-blue-600 mb-1">Resume Uploaded</div>
                        <div className="font-semibold text-slate-900">{activeResume.candidate_name || activeResume.title || 'Uploaded Resume'}</div>
                        <div className="text-sm text-slate-600 mt-1">{activeResume.summary || activeResume.file_name || 'Gemini parsed this resume and saved it for this chat.'}</div>
                      </div>
                      <div className="text-blue-600 text-xl">✓</div>
                    </div>
                  </div>
                )}

            {/* Input bar */}
            <div className="px-4 pb-6 flex-shrink-0">
              <div className="max-w-3xl mx-auto">
                {uploadingFile && (
                  <div className="mb-2 text-xs text-slate-500 text-center">Parsing and saving resume context with Gemini...</div>
                )}
                <div className="bg-white border-2 border-blue-500 rounded-md p-3 flex flex-col gap-2 shadow-sm">
                  <textarea rows={2}
                    className="w-full bg-transparent text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none px-1"
                    placeholder="Write a reply..."
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                    disabled={uploadingFile}
                  />
                  <div className="flex items-center justify-between">
                    <div className="relative" ref={attachMenuRef}>
                      <button
                        onClick={() => setShowAttachMenu(v => !v)}
                        disabled={uploadingFile}
                        className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-all disabled:opacity-40 ${
                          showAttachMenu
                            ? 'bg-slate-200 border-slate-300 text-slate-900'
                            : 'bg-slate-100 border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
                        }`}
                      >
                        <span className={`text-sm transition-transform duration-200 ${showAttachMenu ? 'rotate-45' : ''}`}>+</span>
                        Attach a Resume
                      </button>

                      {showAttachMenu && (
                        <div className="absolute bottom-full mb-2 left-0 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden z-50 w-52">
                          {ATTACH_OPTIONS.map(opt => (
                            <button key={opt.label}
                              onClick={() => handleAttachOption(opt.label)}
                              className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition-all text-left"
                            >
                              <span>{opt.icon}</span>{opt.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <button onClick={() => sendMessage()}
                      disabled={!input.trim() || chatLoading || uploadingFile}
                      className="w-8 h-8 rounded-full bg-slate-200 hover:bg-blue-600 hover:text-white disabled:opacity-30 text-slate-500 flex items-center justify-center transition-all">
                      <span className="text-sm font-bold">↑</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-8">
            <div className="max-w-4xl mx-auto">
              <button onClick={() => setView('chat')} className="text-white/40 hover:text-white/70 text-sm mb-6 flex items-center gap-1 transition-all">← Back to Chat</button>
              <h2 className="text-2xl font-bold mb-1">Resume Optimizer</h2>
              <p className="text-white/40 text-sm mb-8">Paste your resume and a job description for an instant ATS score + rewrite.</p>
              <div className="grid md:grid-cols-2 gap-4 mb-4">
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                  <label className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2 block">Your Resume</label>
                  <textarea className="w-full h-56 bg-transparent text-sm text-white/80 resize-none focus:outline-none placeholder-white/20"
                    placeholder="Paste your resume text here..."
                    value={resume} onChange={e => setResume(e.target.value)} />
                </div>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                  <label className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2 block">Job Description</label>
                  <textarea className="w-full h-56 bg-transparent text-sm text-white/80 resize-none focus:outline-none placeholder-white/20"
                    placeholder="Paste the job description here..."
                    value={jobDesc} onChange={e => setJobDesc(e.target.value)} />
                </div>
              </div>
              {error && <p className="text-red-400 text-sm text-center mb-4">{error}</p>}
              <div className="text-center mb-8">
                <button onClick={handleOptimize} disabled={optimizeLoading}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-semibold px-8 py-3 rounded-xl transition-all">
                  {optimizeLoading ? 'Analyzing...' : 'Optimize My Resume →'}
                </button>
              </div>
              {result && (
                <div className="space-y-4">
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-8 text-center">
                    <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Match Score</p>
                    <p className={`text-6xl font-bold ${scoreColor}`}>{result.score}<span className="text-2xl">%</span></p>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                      <h3 className="text-sm font-semibold mb-3">✅ Strengths</h3>
                      <ul className="space-y-1.5">{result.strengths.map((s, i) => <li key={i} className="text-xs text-white/60">• {s}</li>)}</ul>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                      <h3 className="text-sm font-semibold mb-3">⚠️ Gaps</h3>
                      <ul className="space-y-1.5">{result.gaps.map((g, i) => <li key={i} className="text-xs text-white/60">• {g}</li>)}</ul>
                    </div>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                    <h3 className="text-sm font-semibold mb-3">💡 Suggestions</h3>
                    <ol className="space-y-2">{result.suggestions.map((s, i) => <li key={i} className="text-xs text-white/60"><span className="text-blue-400 font-bold mr-2">{i+1}.</span>{s}</li>)}</ol>
                  </div>
                  <div className="bg-blue-500/10 border border-blue-400/20 rounded-2xl p-5">
                    <h3 className="text-sm font-semibold mb-3 text-blue-600">✨ AI-Optimized Summary</h3>
                    <p className="text-xs text-blue-100/70 leading-relaxed">{result.optimized_summary}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Paste Resume Modal */}
      {showPasteModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a1d27] border border-white/10 rounded-2xl p-6 w-full max-w-lg">
            <h3 className="font-semibold mb-3">Paste Your Resume</h3>
            <textarea
              className="w-full h-48 bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white/80 resize-none focus:outline-none placeholder-white/25"
              placeholder="Paste your resume text here..."
              value={pastedResume}
              onChange={e => setPastedResume(e.target.value)}
              autoFocus
            />
            <div className="flex gap-3 mt-4 justify-end">
              <button onClick={() => { setShowPasteModal(false); setPastedResume(''); }}
                className="px-4 py-2 text-sm text-white/40 hover:text-white/70 transition-all">Cancel</button>
              <button onClick={confirmPaste}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-all">Use This Resume →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

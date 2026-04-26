'use client';
import { useState, useRef, useEffect } from 'react';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

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

export default function Home() {
  const [view, setView] = useState<View>('chat');

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Optimizer state
  const [resume, setResume] = useState('');
  const [jobDesc, setJobDesc] = useState('');
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [optimizeLoading, setOptimizeLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
        body: JSON.stringify({ messages: newMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      setMessages([...newMessages, { role: 'assistant', content: data.reply }]);
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

  const scoreColor = result
    ? result.score >= 75 ? 'text-green-400' : result.score >= 50 ? 'text-yellow-400' : 'text-red-400'
    : '';

  return (
    <div className="flex h-screen bg-[#0f1117] text-white">
      {/* Sidebar */}
      <aside className="w-14 flex flex-col items-center py-4 gap-4 bg-[#0a0c10] border-r border-white/5">
        <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center font-bold text-sm">R</div>
        <div className="mt-4 flex flex-col gap-3">
          <button onClick={() => setView('chat')} title="Chat"
            className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg transition-all ${
              view === 'chat' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
            }`}>💬</button>
          <button onClick={() => setView('optimizer')} title="Optimize Resume"
            className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg transition-all ${
              view === 'optimizer' ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
            }`}>📄</button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {view === 'chat' ? (
          <>
            {/* Chat messages */}
            <div className="flex-1 overflow-y-auto px-4 py-6">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-6">
                  <h1 className="text-2xl font-semibold text-white/90">How can AI Resume Agent help with your resume and job search?</h1>
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
                <div className="max-w-3xl mx-auto space-y-6">
                  {messages.map((m, i) => (
                    <div key={i} className={`flex gap-3 ${
                      m.role === 'user' ? 'justify-end' : 'justify-start'
                    }`}>
                      {m.role === 'assistant' && (
                        <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-1">R</div>
                      )}
                      <div className={`max-w-[75%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                        m.role === 'user'
                          ? 'bg-blue-600 text-white rounded-tr-sm'
                          : 'bg-white/8 text-white/90 rounded-tl-sm border border-white/10'
                      }`}>
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex gap-3">
                      <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center text-xs font-bold flex-shrink-0">R</div>
                      <div className="bg-white/8 border border-white/10 px-4 py-3 rounded-2xl rounded-tl-sm">
                        <span className="flex gap-1">
                          <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{animationDelay:"0ms"}} />
                          <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{animationDelay:"150ms"}} />
                          <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{animationDelay:"300ms"}} />
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Chat input bar */}
            <div className="px-4 pb-6">
              <div className="max-w-3xl mx-auto">
                <div className="bg-white/5 border border-white/10 rounded-2xl p-3 flex flex-col gap-2">
                  <textarea
                    rows={2}
                    className="w-full bg-transparent text-sm text-white/90 placeholder-white/25 resize-none focus:outline-none px-1"
                    placeholder="Describe your task or question, or attach a resume..."
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
                    }}
                  />
                  <div className="flex items-center justify-between">
                    <button onClick={() => setView('optimizer')}
                      className="text-xs text-white/30 hover:text-white/60 flex items-center gap-1.5 transition-all">
                      <span>📎</span> Attach a Resume
                    </button>
                    <button onClick={() => sendMessage()}
                      disabled={!input.trim() || chatLoading}
                      className="w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-30 flex items-center justify-center transition-all">
                      <span className="text-sm">↑</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          /* Optimizer View */
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
                      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">✅ Strengths</h3>
                      <ul className="space-y-1.5">{result.strengths.map((s, i) => <li key={i} className="text-xs text-white/60">• {s}</li>)}</ul>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">⚠️ Gaps</h3>
                      <ul className="space-y-1.5">{result.gaps.map((g, i) => <li key={i} className="text-xs text-white/60">• {g}</li>)}</ul>
                    </div>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                    <h3 className="text-sm font-semibold mb-3">💡 Suggestions</h3>
                    <ol className="space-y-2">{result.suggestions.map((s, i) => <li key={i} className="text-xs text-white/60"><span className="text-blue-400 font-bold mr-2">{i+1}.</span>{s}</li>)}</ol>
                  </div>
                  <div className="bg-blue-500/10 border border-blue-400/20 rounded-2xl p-5">
                    <h3 className="text-sm font-semibold mb-3 text-blue-300">✨ AI-Optimized Summary</h3>
                    <p className="text-xs text-blue-100/70 leading-relaxed">{result.optimized_summary}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
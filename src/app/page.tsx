'use client';
import { useState } from 'react';

type Result = {
  score: number;
  strengths: string[];
  gaps: string[];
  suggestions: string[];
  optimized_summary: string;
};

export default function Home() {
  const [resume, setResume] = useState('');
  const [jobDesc, setJobDesc] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleOptimize() {
    if (!resume.trim() || !jobDesc.trim()) {
      setError('Please fill in both fields.');
      return;
    }
    setError('');
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume, jobDescription: jobDesc }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unexpected error');
    } finally {
      setLoading(false);
    }
  }

  const scoreColor = result
    ? result.score >= 75 ? 'text-green-600' : result.score >= 50 ? 'text-yellow-600' : 'text-red-600'
    : '';

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      <div className="max-w-5xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 text-sm font-medium px-4 py-1.5 rounded-full mb-4">
            <span>⚡</span> AI-Powered
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-3">Resume Optimizer</h1>
          <p className="text-slate-500 text-lg max-w-xl mx-auto">Paste your resume and a job description. Get an instant match score, gap analysis, and rewrite suggestions.</p>
        </div>

        {/* Input Grid */}
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
            <label className="block text-sm font-semibold text-slate-700 mb-2">📄 Your Resume</label>
            <textarea
              className="w-full h-64 text-sm text-slate-700 resize-none focus:outline-none placeholder-slate-300"
              placeholder="Paste your resume text here..."
              value={resume}
              onChange={e => setResume(e.target.value)}
            />
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
            <label className="block text-sm font-semibold text-slate-700 mb-2">💼 Job Description</label>
            <textarea
              className="w-full h-64 text-sm text-slate-700 resize-none focus:outline-none placeholder-slate-300"
              placeholder="Paste the job description here..."
              value={jobDesc}
              onChange={e => setJobDesc(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="text-red-500 text-sm text-center mb-4">{error}</p>}

        <div className="text-center mb-10">
          <button
            onClick={handleOptimize}
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-10 py-3.5 rounded-xl text-base transition-all shadow-md hover:shadow-lg"
          >
            {loading ? 'Analyzing...' : 'Optimize My Resume →'}
          </button>
        </div>

        {/* Results */}
        {result && (
          <div className="space-y-6 animate-fadeIn">
            {/* Score */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
              <p className="text-slate-500 text-sm font-medium mb-1">Match Score</p>
              <p className={`text-7xl font-bold ${scoreColor}`}>{result.score}<span className="text-3xl">%</span></p>
              <p className="text-slate-400 text-sm mt-2">
                {result.score >= 75 ? 'Strong match — great job!' : result.score >= 50 ? 'Decent match — room to improve' : 'Weak match — needs work'}
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Strengths */}
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2"><span>✅</span> Strengths</h3>
                <ul className="space-y-2">
                  {result.strengths.map((s, i) => (
                    <li key={i} className="text-sm text-slate-600 flex gap-2"><span className="text-green-500 mt-0.5">•</span>{s}</li>
                  ))}
                </ul>
              </div>
              {/* Gaps */}
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2"><span>⚠️</span> Gaps</h3>
                <ul className="space-y-2">
                  {result.gaps.map((g, i) => (
                    <li key={i} className="text-sm text-slate-600 flex gap-2"><span className="text-orange-400 mt-0.5">•</span>{g}</li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Suggestions */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2"><span>💡</span> Optimization Suggestions</h3>
              <ol className="space-y-2">
                {result.suggestions.map((s, i) => (
                  <li key={i} className="text-sm text-slate-600 flex gap-3"><span className="font-bold text-blue-500">{i + 1}.</span>{s}</li>
                ))}
              </ol>
            </div>

            {/* Optimized Summary */}
            <div className="bg-blue-50 rounded-2xl border border-blue-100 p-6">
              <h3 className="font-semibold text-blue-800 mb-3 flex items-center gap-2"><span>✨</span> AI-Optimized Professional Summary</h3>
              <p className="text-sm text-blue-900 leading-relaxed">{result.optimized_summary}</p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
'use client';

import React, { useState } from 'react';

export default function JobSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedJobIndex, setExpandedJobIndex] = useState<number | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setError('');
    setResults([]);
    setExpandedJobIndex(null);

    try {
      const res = await fetch(`/api/jobs?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to search jobs');
      }

      setResults(data.jobs_results || []);
    } catch (err: any) {
      setError(err.message || 'An error occurred during search.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      <div className="p-6 border-b border-slate-200 bg-white">
        <h2 className="text-2xl font-bold text-slate-800 mb-4">Job Search</h2>
        <form onSubmit={handleSearch} className="flex gap-2 w-full max-w-2xl">
          <input
            type="text"
            placeholder="e.g. Software Engineer in New York"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 rounded-full border border-slate-300 px-5 py-3 text-slate-900 outline-none focus:border-blue-500 shadow-sm"
          />
          <button
            type="submit"
            disabled={isLoading || !query.trim()}
            className="rounded-full bg-blue-600 px-6 py-3 font-bold text-white shadow-sm hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500"
          >
            {isLoading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </div>

      <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
        {error && (
          <div className="p-4 mb-4 text-red-700 bg-red-100 rounded-lg border border-red-200">
            {error}
          </div>
        )}

        {!isLoading && results.length === 0 && !error && query && (
          <div className="text-center py-12 text-slate-500">
            No jobs found for &quot;{query}&quot;. Try a different search.
          </div>
        )}

        <div className="grid gap-4 max-w-4xl">
          {results.map((job, index) => (
            <div 
              key={index} 
              onClick={() => setExpandedJobIndex(expandedJobIndex === index ? null : index)}
              className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
            >
              <div className="flex justify-between items-start gap-4">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">{job.title}</h3>
                  <div className="text-sm font-semibold text-slate-700 mt-1">{job.company_name}</div>
                  <div className="text-sm text-slate-500 mt-1">{job.location}</div>
                  
                  {job.extensions && job.extensions.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {job.extensions.map((ext: string, i: number) => (
                        <span key={i} className="inline-flex items-center rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                          {ext}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                
                {job.thumbnail && (
                  <div className="shrink-0">
                    <img src={job.thumbnail} alt={`${job.company_name} logo`} className="w-12 h-12 object-contain bg-white rounded border border-slate-100" />
                  </div>
                )}
              </div>
              
              <div className="mt-4 flex gap-2">
                {job.apply_options && job.apply_options.length > 0 ? (
                  job.apply_options.slice(0, 2).map((opt: any, i: number) => (
                    <a
                      key={i}
                      href={opt.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center rounded-lg bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 hover:bg-blue-100"
                    >
                      Apply on {opt.title}
                    </a>
                  ))
                ) : job.share_link ? (
                   <a
                    href={job.share_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center rounded-lg bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 hover:bg-blue-100"
                  >
                    View on Google
                  </a>
                ) : null}
              </div>

              {expandedJobIndex === index && job.description && (
                <div className="mt-5 border-t border-slate-100 pt-4">
                  <h4 className="text-sm font-bold text-slate-900 mb-2">Job Description</h4>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                    {job.description}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

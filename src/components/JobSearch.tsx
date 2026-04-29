'use client';

import React, { useState } from 'react';
import { JobResults } from './JobResults';
import type { JobResult } from '@/lib/jobs';

export default function JobSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<JobResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setError('');
    setResults([]);

    try {
      const res = await fetch(`/api/jobs?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to search jobs');
      }

      setResults(data.jobs || data.jobs_results || []);
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

        {!!results.length && (
          <div className="max-w-4xl">
            <JobResults query={query} jobs={results} />
          </div>
        )}
      </div>
    </div>
  );
}

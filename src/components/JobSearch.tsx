'use client';

import React, { useState } from 'react';
import { JobResults } from './JobResults';
import type { JobResult } from '@/lib/jobs';

export default function JobSearch({
  onTailorResume,
  tailorButtonLabel,
  tailoringJobKey,
}: {
  onTailorResume?: (job: JobResult, index: number) => void;
  tailorButtonLabel?: string;
  tailoringJobKey?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<JobResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setError('');
    setResults([]);
    setHasSearched(true);

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
    <div className="flex h-full flex-col bg-slate-50">
      <div className={`${hasSearched ? 'border-b border-slate-200 bg-white px-4 py-5 sm:px-6' : 'flex flex-1 items-center justify-center px-4 py-10 sm:px-6'}`}>
        <div className="mx-auto w-full max-w-3xl">
          <h2 className={`text-center font-bold text-slate-900 ${hasSearched ? 'mb-4 text-xl' : 'mb-6 text-3xl sm:text-4xl'}`}>Job Search</h2>
          <form onSubmit={handleSearch} className="flex w-full flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm sm:flex-row sm:items-center">
            <input
              type="text"
              placeholder="e.g. Software Engineer in New York"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-transparent px-4 py-3 text-slate-900 outline-none focus:border-blue-200 focus:bg-blue-50/40"
            />
            <button
              type="submit"
              disabled={isLoading || !query.trim()}
              className="rounded-xl bg-blue-600 px-6 py-3 font-bold text-white shadow-sm hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500"
            >
              {isLoading ? 'Searching...' : 'Search'}
            </button>
          </form>
        </div>
      </div>

      {hasSearched && (
        <div className="custom-scrollbar flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto w-full max-w-4xl">
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
              <JobResults
                query={query}
                jobs={results}
                onTailorResume={onTailorResume}
                tailorButtonLabel={tailorButtonLabel}
                tailoringJobKey={tailoringJobKey}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

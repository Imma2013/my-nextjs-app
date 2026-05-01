'use client';

import { useState } from 'react';
import type { JobResult } from '@/lib/jobs';

export function JobResults({
  query,
  jobs,
  onTailorResume,
  tailorButtonLabel = 'Tailor resume - 1.2 credits',
  tailoringJobKey = '',
}: {
  query?: string;
  jobs: JobResult[];
  onTailorResume?: (job: JobResult, index: number) => void;
  tailorButtonLabel?: string;
  tailoringJobKey?: string;
}) {
  const [expandedJobIndex, setExpandedJobIndex] = useState<number | null>(null);

  if (!jobs.length) {
    return (
      <div className="my-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        No jobs found{query ? ` for "${query}"` : ''}.
      </div>
    );
  }

  return (
    <div className="my-3 grid gap-4">
      {query && <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Jobs for {query}</div>}
      {jobs.map((job, index) => {
        const isExpanded = expandedJobIndex === index;
        const jobKey = `${job.title || 'role'}-${job.company_name || 'company'}-${index}`;
        const isTailoring = tailoringJobKey === jobKey;

        return (
          <article
            key={`${job.title}-${job.company_name}-${index}`}
            className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
          >
            <button
              type="button"
              onClick={() => setExpandedJobIndex(isExpanded ? null : index)}
              className="block w-full text-left"
            >
              <div className="flex justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-base font-bold leading-6 text-slate-900">{job.title || 'Untitled role'}</h3>
                  <div className="mt-1 text-sm font-semibold text-slate-700">{job.company_name || 'Unknown company'}</div>
                  {job.location && <div className="mt-1 text-sm text-slate-500">{job.location}</div>}
                  {!!job.extensions?.length && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {job.extensions.map((ext, i) => (
                        <span key={`${ext}-${i}`} className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                          {ext}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {job.thumbnail && (
                  <img
                    src={job.thumbnail}
                    alt={`${job.company_name || 'Company'} logo`}
                    className="h-12 w-12 shrink-0 rounded border border-slate-100 bg-white object-contain"
                  />
                )}
              </div>
            </button>

            <div className="mt-4 flex flex-wrap gap-2">
              {onTailorResume && (
                <button
                  type="button"
                  onClick={() => onTailorResume(job, index)}
                  disabled={isTailoring}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  {isTailoring ? 'Tailoring...' : tailorButtonLabel}
                </button>
              )}

              {!!job.apply_options?.length ? (
                job.apply_options.slice(0, 2).map((option, i) => (
                  option.link ? (
                    <a
                      key={`${option.link}-${i}`}
                      href={option.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 hover:bg-blue-100"
                    >
                      Apply on {option.title || 'site'}
                    </a>
                  ) : null
                ))
              ) : job.share_link ? (
                <a
                  href={job.share_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 hover:bg-blue-100"
                >
                  View on Google
                </a>
              ) : null}

              {job.description && (
                <button
                  type="button"
                  onClick={() => setExpandedJobIndex(isExpanded ? null : index)}
                  className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-200"
                >
                  {isExpanded ? 'Hide details' : 'Details'}
                </button>
              )}
            </div>

            {isExpanded && job.description && (
              <div className="mt-5 border-t border-slate-100 pt-4">
                <h4 className="mb-2 text-sm font-bold text-slate-900">Job Description</h4>
                <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{job.description}</p>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

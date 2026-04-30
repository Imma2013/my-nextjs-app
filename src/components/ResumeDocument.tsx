'use client';

import ResumeDocumentLayout from './ResumeDocumentLayout';

type ResumeLike = { id?: string; title?: string; candidate_name?: string; headline?: string; summary?: string; parsed_json?: any } | null;
type EditPayload = { operation: 'replace' | 'add' | 'remove'; path: string; value?: unknown };

export default function ResumeDocument({ resume, onEdit }: { resume: ResumeLike; onEdit?: (edit: EditPayload) => void }) {
  return <ResumeDocumentLayout resume={resume} onEdit={onEdit} />;
}

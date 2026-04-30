import ResumeDocumentLayout from '@/components/ResumeDocumentLayout';
import { adminClient } from '@/lib/billing';

export const dynamic = 'force-dynamic';

export default async function ResumePrintPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { userId?: string };
}) {
  const userId = searchParams.userId;
  let resume: any = null;
  let errorMessage = '';

  if (!userId) {
    errorMessage = 'Missing userId';
  } else {
    const supabase = adminClient();
    const { data, error } = await supabase
      .from('resumes')
      .select('*')
      .eq('id', params.id)
      .eq('user_id', userId)
      .single();
    if (error) errorMessage = 'Resume not found';
    else resume = data;
  }

  return (
    <main className="print-root min-h-screen bg-slate-100 py-8">
      <style>{`
        html,
        body,
        body > div,
        main {
          height: auto !important;
          min-height: 100%;
          overflow: visible !important;
        }

        * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        @page {
          size: Letter;
          margin: 0;
        }

        @media print {
          .print-root {
            background: #fff !important;
            padding: 0 !important;
          }

          .resume-document {
            box-shadow: none !important;
            margin: 0 auto !important;
            min-height: 100vh;
            width: 100%;
          }
        }
      `}</style>
      {resume ? (
        <ResumeDocumentLayout resume={resume} />
      ) : (
        <div className="mx-auto max-w-xl rounded bg-white p-6 text-sm text-slate-700 shadow">{errorMessage || 'Resume not found'}</div>
      )}
    </main>
  );
}

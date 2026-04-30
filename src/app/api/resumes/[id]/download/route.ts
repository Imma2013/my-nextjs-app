import { NextRequest, NextResponse } from 'next/server';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { adminClient, FREE_PDF_DOWNLOAD_LIMIT, getBillingSummary } from '@/lib/billing';

export const runtime = 'nodejs';
export const maxDuration = 60;

function filename(value: string) {
  return `${value.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').slice(0, 80) || 'resume'}.pdf`;
}

async function executablePath() {
  return process.env.PUPPETEER_EXECUTABLE_PATH
    || process.env.CHROME_EXECUTABLE_PATH
    || await chromium.executablePath();
}

async function renderResumePdf(url: string) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 850, height: 1100, deviceScaleFactor: 1 },
    executablePath: await executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
    await page.emulateMediaType('screen');
    return await page.pdf({
      format: 'letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
  }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const supabase = adminClient();
    const { data: resume, error } = await supabase
      .from('resumes')
      .select('id, title, file_name')
      .eq('id', params.id)
      .eq('user_id', userId)
      .single();
    if (error) throw error;

    const billing = await getBillingSummary(userId);
    if (billing.plan === 'free' && billing.pdfDownloadsUsed >= FREE_PDF_DOWNLOAD_LIMIT) {
      return NextResponse.json({
        error: 'Free includes 3 PDF downloads. Upgrade for unlimited downloads.',
        upgradeRequired: true,
      }, { status: 402 });
    }

    const printUrl = new URL(`/resumes/${encodeURIComponent(params.id)}/print`, req.nextUrl.origin);
    printUrl.searchParams.set('userId', userId);
    const pdf = await renderResumePdf(printUrl.toString());

    if (billing.plan === 'free') {
      const { error: usageError } = await supabase.from('usage_events').insert({
        user_id: userId,
        action_type: 'pdf_download',
        idempotency_key: `${params.id}:${Date.now()}:${crypto.randomUUID()}`,
        resume_id: params.id,
        credits_charged: 0,
        free_tailor_used: false,
        status: 'completed',
        completed_at: new Date().toISOString(),
      });
      if (usageError) throw usageError;
    }

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename(resume.title || resume.file_name || 'resume')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Failed to generate resume PDF:', error);
    return NextResponse.json({ error: 'Failed to generate resume PDF' }, { status: 500 });
  }
}

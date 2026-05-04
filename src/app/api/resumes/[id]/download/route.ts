import { NextRequest, NextResponse } from 'next/server';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { adminClient } from '@/lib/billing';

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

function sanitizedPath(value: string) {
  let sanitized = value.replace(process.cwd(), '<app>');
  if (process.env.HOME) sanitized = sanitized.replace(process.env.HOME, '<home>');
  return sanitized;
}

function logPdfPhase(phase: string, details?: Record<string, unknown>) {
  console.info('[resume-pdf]', { phase, ...details });
}

function logPdfError(phase: string, error: unknown) {
  console.error('[resume-pdf]', { phase, error });
}

async function renderResumePdf(url: string) {
  let phase = 'resolve-executable';
  let browser;

  try {
    const browserExecutablePath = await executablePath();
    logPdfPhase(phase, {
      executablePath: sanitizedPath(browserExecutablePath),
    });

    phase = 'launch-browser';
    browser = await puppeteer.launch({
      args: puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      defaultViewport: { width: 850, height: 1100, deviceScaleFactor: 1 },
      executablePath: browserExecutablePath,
      headless: 'shell',
    });

    phase = 'new-page';
    const page = await browser.newPage();

    phase = 'navigate';
    logPdfPhase(phase, { url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.resume-document', { timeout: 15000 });

    phase = 'pdf';
    await page.emulateMediaType('screen');
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    logPdfPhase('complete', { bytes: pdf.length });
    return pdf;
  } catch (error) {
    logPdfError(phase, error);
    throw error;
  } finally {
    if (browser) await browser.close();
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

    const printUrl = new URL(`/resumes/${encodeURIComponent(params.id)}/print`, req.nextUrl.origin);
    printUrl.searchParams.set('userId', userId);
    const pdf = await renderResumePdf(printUrl.toString());

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

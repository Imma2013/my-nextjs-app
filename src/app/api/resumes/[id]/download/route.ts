import { NextRequest, NextResponse } from 'next/server';
import { adminClient, FREE_PDF_DOWNLOAD_LIMIT, getBillingSummary } from '@/lib/billing';

function arr(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split('\n').filter(Boolean);
  return [];
}

function section(parsed: any, key: string) {
  return arr(parsed?.sections?.[key] ?? parsed?.[key]);
}

function label(item: any, fallback = '') {
  if (!item) return fallback;
  if (typeof item === 'string') return item;
  return item.role || item.title || item.name || item.degree || item.school || item.company || fallback;
}

function useful(value: any) {
  const text = String(value || '').trim();
  return ['company', 'organization', 'employer', 'school', 'institution', 'project'].includes(text.toLowerCase()) ? '' : text;
}

function org(item: any) {
  return useful(item?.company) || useful(item?.organization) || useful(item?.employer) || useful(item?.school) || useful(item?.institution) || '';
}

function dates(item: any) {
  return item?.dates || item?.date || item?.duration || '';
}

function projectTitle(item: any) {
  if (!item || typeof item === 'string') return label(item, 'Project');
  return useful(item.title) || useful(item.name) || useful(item.description)?.split('\n')[0]?.slice(0, 90) || 'Project';
}

function bullets(item: any): string[] {
  if (!item) return [];
  if (typeof item === 'string') return [item];
  const value = item.bullets || item.highlights || item.description || item.details || [];
  if (Array.isArray(value)) return value.map((entry: any) => typeof entry === 'string' ? entry : JSON.stringify(entry));
  return typeof value === 'string' ? [value] : [];
}

function resumeLines(resume: any) {
  const parsed = resume?.parsed_json || {};
  const contact = parsed.contact || {};
  const lines: string[] = [];
  const name = resume?.candidate_name || parsed.candidateName || parsed.name || 'Resume';
  const headline = resume?.headline || parsed.headline || parsed.title || '';
  const summary = parsed.profile || parsed.professionalSummary || parsed.summary || resume?.summary || '';
  lines.push(name);
  if (headline) lines.push(headline);
  const contactLine = [contact.location, contact.email, contact.phone].filter(Boolean).join(' | ');
  if (contactLine) lines.push(contactLine);
  lines.push('');

  const addSection = (title: string, values: any[], mapper: (item: any, index: number) => string[]) => {
    if (!values.length) return;
    lines.push(title.toUpperCase());
    values.forEach((item, index) => mapper(item, index).forEach(line => lines.push(line)));
    lines.push('');
  };

  if (summary) addSection('Profile', [summary], item => [String(item)]);
  addSection('Experience', section(parsed, 'experience'), item => [
    [label(item, 'Role'), org(item), item.location, dates(item)].filter(Boolean).join(' - '),
    ...bullets(item).map(bullet => `- ${bullet}`),
  ]);
  addSection('Projects', section(parsed, 'projects'), item => [
    projectTitle(item),
    ...bullets(item).map(bullet => `- ${bullet}`),
  ]);
  addSection('Education', section(parsed, 'education'), item => [
    typeof item === 'string' ? item : [item.degree, item.school || item.institution, item.location, item.dates].filter(Boolean).join(' - '),
  ]);
  addSection('Skills', section(parsed, 'skills'), item => [
    typeof item === 'string' ? item : label(item, ''),
  ]);
  addSection('Community Service', [
    ...section(parsed, 'communityService'),
    ...section(parsed, 'volunteer'),
    ...section(parsed, 'volunteering'),
  ], item => [
    [org(item) || label(item, 'Organization'), item.role || item.title, dates(item)].filter(Boolean).join(' - '),
    ...bullets(item).map(bullet => `- ${bullet}`),
  ]);
  addSection('Awards', section(parsed, 'awards'), item => [label(item, '')]);

  return lines.flatMap(line => wrapLine(String(line || ''), 92));
}

function wrapLine(line: string, max: number) {
  if (!line) return [''];
  const words = line.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  words.forEach(word => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });
  if (current) lines.push(current);
  return lines;
}

function escapePdf(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function makePdf(lines: string[]) {
  const objects: string[] = [];
  const pageKids: string[] = [];
  const pageCount = Math.max(1, Math.ceil(lines.length / 48));
  const fontObject = 3;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (let page = 0; page < pageCount; page += 1) {
    const pageLines = lines.slice(page * 48, page * 48 + 48);
    const content = [
      'BT',
      '/F1 10 Tf',
      '50 750 Td',
      '14 TL',
      ...pageLines.map((line, index) => `${index === 0 ? '' : 'T* '}(${escapePdf(line)}) Tj`),
      'ET',
    ].join('\n');
    const contentObject = objects.length;
    objects[contentObject] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
    const pageObject = objects.length;
    objects[pageObject] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`;
    pageKids.push(`${pageObject} 0 R`);
  }

  objects[2] = `<< /Type /Pages /Kids [${pageKids.join(' ')}] /Count ${pageCount} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function filename(value: string) {
  return `${value.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').slice(0, 80) || 'resume'}.pdf`;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const supabase = adminClient();
    const { data: resume, error } = await supabase
      .from('resumes')
      .select('*')
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

    const pdf = makePdf(resumeLines(resume));
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

    return new NextResponse(pdf, {
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

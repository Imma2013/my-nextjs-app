import { NextRequest, NextResponse } from 'next/server';
import { PDFExtract } from 'pdf.js-extract';
import mammoth from 'mammoth';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    let text = '';

    if (file.name.endsWith('.pdf')) {
      const pdfExtract = new PDFExtract();
      const data = await pdfExtract.extractBuffer(buffer);
      text = data.pages.map(page => page.content.map(item => item.str).join(' ')).join('\n');
    } else if (file.name.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      return NextResponse.json({ error: 'Unsupported file type. Use PDF or DOCX.' }, { status: 400 });
    }

    return NextResponse.json({ text: text.trim() });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to parse file' }, { status: 500 });
  }
}

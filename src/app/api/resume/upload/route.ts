import { NextRequest, NextResponse } from 'next/server';
import { PDFExtract } from 'pdf.js-extract';
import mammoth from 'mammoth';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder';
const supabase = createClient(supabaseUrl, serviceKey);

const GEMINI_MODEL = 'gemini-2.5-flash';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const user_id = formData.get('user_id') as string;

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
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 });
    }

    // Use Gemini to parse resume into structured data
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'API key not configured' }, { status: 500 });

    const prompt = `Parse this resume text into structured JSON. Extract all sections. Respond ONLY with valid JSON (no markdown).

Resume text:
${text}

Return this exact structure:
{
  "contact": {"full_name": "", "email": "", "phone": "", "location": "", "linkedin": "", "portfolio": ""},
  "summary": {"content": ""},
  "skills": {"skills": []},
  "experience": [{"title": "", "company": "", "location": "", "start_date": "", "end_date": "", "is_current": false, "bullets": []}],
  "education": [{"degree": "", "school": "", "location": "", "start_date": "", "end_date": "", "gpa": "", "bullets": []}],
  "projects": [{"title": "", "description": "", "technologies": [], "link": "", "bullets": []}]
}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const parsedText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(parsedText.replace(/```json|```/g, '').trim());

    // Create resume in DB
    const { data: resume, error: resumeError } = await supabase
      .from('resume_documents')
      .insert({ user_id, title: parsed.contact?.full_name || 'Imported Resume' })
      .select()
      .single();

    if (resumeError) throw resumeError;

    // Insert all sections
    await Promise.all([
      supabase.from('resume_contact').insert({ resume_id: resume.id, ...parsed.contact }),
      supabase.from('resume_summary').insert({ resume_id: resume.id, content: parsed.summary?.content }),
      supabase.from('resume_skills').insert({ resume_id: resume.id, skills: parsed.skills?.skills || [] }),
      ...parsed.experience.map((exp: any, i: number) =>
        supabase.from('resume_experience').insert({ resume_id: resume.id, position: i, ...exp })
      ),
      ...parsed.education.map((edu: any, i: number) =>
        supabase.from('resume_education').insert({ resume_id: resume.id, position: i, ...edu })
      ),
      ...parsed.projects.map((proj: any, i: number) =>
        supabase.from('resume_projects').insert({ resume_id: resume.id, position: i, ...proj })
      ),
    ]);

    return NextResponse.json({ success: true, resume_id: resume.id });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message || 'Failed to parse and save resume' }, { status: 500 });
  }
}

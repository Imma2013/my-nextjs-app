import { NextRequest, NextResponse } from 'next/server';
import { generateGeminiContent, geminiUserError } from '@/lib/gemini';

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function getMimeType(file: File) {
  const name = file.name.toLowerCase();

  if (file.type && SUPPORTED_MIME_TYPES.has(file.type)) return file.type;
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  return file.type || 'application/octet-stream';
}

function cleanGeminiJson(text: string) {
  return text.replace(/```json|```/g, '').trim();
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const mimeType = getMimeType(file);

    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      return NextResponse.json({ error: 'Unsupported file type. Use PDF or DOCX.' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: 'File is too large. Please upload a file under 20MB.' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 500 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const base64File = Buffer.from(arrayBuffer).toString('base64');

    const prompt = `Extract the resume text from the attached ${file.name} file.

Return ONLY valid JSON with this exact shape:
{
  "resumeText": "clean plain text resume content with readable sections and line breaks",
  "candidateName": "candidate name if visible, otherwise empty string",
  "headline": "current title or short professional headline if visible, otherwise empty string",
  "summary": "candidate profile or resume summary if present, otherwise one short sentence describing what was extracted",
  "issues": [],
  "sections": {
    "experience": [{ "role": "", "company": "", "location": "", "dates": "", "bullets": [] }],
    "education": [{ "degree": "", "school": "", "location": "", "dates": "" }],
    "skills": [],
    "projects": [{ "title": "", "description": "", "bullets": [] }],
    "awards": [],
    "communityService": [{ "organization": "", "role": "", "dates": "", "bullets": [] }]
  }
}

Rules:
- Preserve names, roles, employers, locations, dates, education, skills, projects, community service, and metrics.
- For experience, split combined lines like "HEB Mansfield,Texas - Customer Service Assistant" into company "HEB", location "Mansfield, Texas", and role "Customer Service Assistant".
- Put volunteer/community service under sections.communityService unless it is clearly paid work.
- If an employer, project title, location, or date is not visible, use an empty string. Do not output placeholders like "Company" or "Project".
- Remove decorative headers/footers, page numbers, and duplicated artifacts.
- Do not invent missing details.
- If the document is not a resume, still extract the readable text.`;

    const { data, model } = await generateGeminiContent({
      apiKey,
      body: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType,
                  data: base64File,
                },
              },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json' },
      },
    });

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(cleanGeminiJson(rawText));
    const text = typeof parsed.resumeText === 'string' ? parsed.resumeText.trim() : typeof parsed.text === 'string' ? parsed.text.trim() : '';

    if (!text) {
      return NextResponse.json({ error: 'Gemini could not extract readable text from this file.' }, { status: 422 });
    }

    return NextResponse.json({
      text,
      parsed,
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'Attachment processed by Gemini.',
      candidateName: typeof parsed.candidateName === 'string' ? parsed.candidateName : '',
      headline: typeof parsed.headline === 'string' ? parsed.headline : '',
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      fileName: file.name,
      mimeType,
      processedBy: model,
    });
  } catch (e) {
    console.error(e);
    const message = geminiUserError(e) || 'Failed to parse file';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

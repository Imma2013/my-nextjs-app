import { NextRequest, NextResponse } from 'next/server';

const GEMINI_MODEL = 'gemini-3-flash-preview';

const RESUME_EDITING_TOOLS = [
  {
    name: 'edit_contact_info',
    description: 'Update contact information (name, email, phone, location, etc.)',
    parameters: {
      type: 'object',
      properties: {
        resume_id: { type: 'string', description: 'Resume ID' },
        full_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        location: { type: 'string' },
        linkedin: { type: 'string' },
        portfolio: { type: 'string' },
      },
      required: ['resume_id'],
    },
  },
  {
    name: 'edit_summary',
    description: 'Update the professional summary section',
    parameters: {
      type: 'object',
      properties: {
        resume_id: { type: 'string', description: 'Resume ID' },
        content: { type: 'string', description: 'New summary text' },
      },
      required: ['resume_id', 'content'],
    },
  },
  {
    name: 'edit_experience_field',
    description: 'Edit a single field in an experience entry (title, company, dates, etc.)',
    parameters: {
      type: 'object',
      properties: {
        resume_id: { type: 'string' },
        entry_id: { type: 'string', description: 'Experience entry ID' },
        field: { type: 'string', enum: ['title', 'company', 'location', 'start_date', 'end_date', 'is_current'] },
        value: { type: 'string', description: 'New value for the field' },
      },
      required: ['resume_id', 'entry_id', 'field', 'value'],
    },
  },
  {
    name: 'add_experience_bullet',
    description: 'Add a bullet point to an experience entry',
    parameters: {
      type: 'object',
      properties: {
        resume_id: { type: 'string' },
        entry_id: { type: 'string', description: 'Experience entry ID' },
        bullet_text: { type: 'string', description: 'The bullet point text to add' },
      },
      required: ['resume_id', 'entry_id', 'bullet_text'],
    },
  },
];

export async function POST(req: NextRequest) {
  try {
    const { messages, resume_id } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'API key not configured' }, { status: 500 });

    const contents = messages.map((m: { role: string; content: string }) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    let systemPrompt = 'You are an expert resume coach and career advisor. Help users improve their resumes, prepare for interviews, and advance their careers. Be concise, practical, and encouraging.';
    
    if (resume_id) {
      systemPrompt += `\n\nThe user has an active resume (ID: ${resume_id}). You have tools to edit it. When the user asks you to make changes (e.g., "change my job title to X", "add a bullet about Y"), use the editing tools to update the resume in real-time.`;
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools: resume_id ? [{ functionDeclarations: RESUME_EDITING_TOOLS }] : undefined,
        }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Check for function calls
    const functionCalls = parts.filter((p: any) => p.functionCall);
    if (functionCalls.length > 0) {
      // Execute function calls
      const results = await Promise.all(
        functionCalls.map(async (fc: any) => {
          const { name, args } = fc.functionCall;
          return await executeTool(name, args);
        })
      );

      // Return success message
      return NextResponse.json({
        reply: `✅ Updated! ${results.map(r => r.message).join(' ')}`,
        tool_calls: functionCalls.map((fc: any) => fc.functionCall.name),
      });
    }

    const reply = parts.find((p: any) => p.text)?.text ?? 'Sorry, no response generated.';
    return NextResponse.json({ reply });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: 'Chat failed: ' + e.message }, { status: 500 });
  }
}

async function executeTool(name: string, args: any) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  if (name === 'edit_contact_info') {
    const res = await fetch(`${baseUrl}/api/resume/edit-section`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume_id: args.resume_id, section: 'contact', data: args }),
    });
    return { success: res.ok, message: 'Contact info updated' };
  }

  if (name === 'edit_summary') {
    const res = await fetch(`${baseUrl}/api/resume/edit-section`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume_id: args.resume_id, section: 'summary', data: { content: args.content } }),
    });
    return { success: res.ok, message: 'Summary updated' };
  }

  if (name === 'edit_experience_field') {
    const res = await fetch(`${baseUrl}/api/resume/edit-entry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, section: 'experience' }),
    });
    return { success: res.ok, message: `${args.field} updated` };
  }

  if (name === 'add_experience_bullet') {
    const res = await fetch(`${baseUrl}/api/resume/add-bullet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, section: 'experience' }),
    });
    return { success: res.ok, message: 'Bullet added' };
  }

  return { success: false, message: 'Unknown tool' };
}
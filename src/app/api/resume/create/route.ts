import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, serviceKey);

export async function POST(req: NextRequest) {
  try {
    const { user_id, title } = await req.json();

    // Create resume document
    const { data: resume, error } = await supabase
      .from('resume_documents')
      .insert({ user_id, title: title || 'Untitled Resume' })
      .select()
      .single();

    if (error) throw error;

    // Initialize empty sections
    await Promise.all([
      supabase.from('resume_contact').insert({ resume_id: resume.id }),
      supabase.from('resume_summary').insert({ resume_id: resume.id }),
      supabase.from('resume_skills').insert({ resume_id: resume.id }),
    ]);

    return NextResponse.json({ success: true, resume_id: resume.id });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message || 'Failed to create resume' }, { status: 500 });
  }
}
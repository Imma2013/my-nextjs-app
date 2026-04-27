import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, serviceKey);

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const resume_id = searchParams.get('resume_id');
    if (!resume_id) {
      return NextResponse.json({ error: 'Missing resume_id' }, { status: 400 });
    }

    const [contact, summary, skills, experience, education, projects] = await Promise.all([
      supabase.from('resume_contact').select('*').eq('resume_id', resume_id).maybeSingle(),
      supabase.from('resume_summary').select('*').eq('resume_id', resume_id).maybeSingle(),
      supabase.from('resume_skills').select('*').eq('resume_id', resume_id).maybeSingle(),
      supabase.from('resume_experience').select('*').eq('resume_id', resume_id).order('position'),
      supabase.from('resume_education').select('*').eq('resume_id', resume_id).order('position'),
      supabase.from('resume_projects').select('*').eq('resume_id', resume_id).order('position'),
    ]);

    return NextResponse.json({
      contact: contact.data,
      summary: summary.data,
      skills: skills.data,
      experience: experience.data || [],
      education: education.data || [],
      projects: projects.data || [],
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message || 'Failed to fetch resume' }, { status: 500 });
  }
}
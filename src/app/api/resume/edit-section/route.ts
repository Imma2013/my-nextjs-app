import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder';
const supabase = createClient(supabaseUrl, serviceKey);

export async function POST(req: NextRequest) {
  try {
    const { resume_id, section, data } = await req.json();
    if (!resume_id || !section || !data) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    let result;
    switch (section) {
      case 'contact':
        result = await supabase.from('resume_contact').upsert({
          resume_id,
          ...data,
          updated_at: new Date().toISOString(),
        }).select();
        break;
      case 'summary':
        result = await supabase.from('resume_summary').upsert({
          resume_id,
          content: data.content,
          updated_at: new Date().toISOString(),
        }).select();
        break;
      case 'skills':
        result = await supabase.from('resume_skills').upsert({
          resume_id,
          skills: data.skills,
          updated_at: new Date().toISOString(),
        }).select();
        break;
      default:
        return NextResponse.json({ error: 'Invalid section' }, { status: 400 });
    }

    if (result.error) throw result.error;
    return NextResponse.json({ success: true, data: result.data });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message || 'Failed to update section' }, { status: 500 });
  }
}
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder';
const supabase = createClient(supabaseUrl, serviceKey);

export async function POST(req: NextRequest) {
  try {
    const { resume_id, section, entry_id, bullet_text } = await req.json();
    if (!resume_id || !section || !entry_id || !bullet_text) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const table = section === 'experience' ? 'resume_experience' : section === 'education' ? 'resume_education' : 'resume_projects';
    
    // Get current bullets
    const { data: entry, error: fetchError } = await supabase
      .from(table)
      .select('bullets')
      .eq('id', entry_id)
      .single();

    if (fetchError) throw fetchError;

    const bullets = (entry?.bullets as string[]) || [];
    bullets.push(bullet_text);

    const result = await supabase.from(table).update({
      bullets,
      updated_at: new Date().toISOString(),
    }).eq('id', entry_id).eq('resume_id', resume_id).select();

    if (result.error) throw result.error;
    return NextResponse.json({ success: true, data: result.data });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message || 'Failed to add bullet' }, { status: 500 });
  }
}
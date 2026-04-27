import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, serviceKey);

export async function POST(req: NextRequest) {
  try {
    const { resume_id, section, entry_id, field, value } = await req.json();
    if (!resume_id || !section || !entry_id || !field) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const table = section === 'experience' ? 'resume_experience' : 'resume_education';
    const result = await supabase.from(table).update({
      [field]: value,
      updated_at: new Date().toISOString(),
    }).eq('id', entry_id).eq('resume_id', resume_id).select();

    if (result.error) throw result.error;
    return NextResponse.json({ success: true, data: result.data });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message || 'Failed to update entry' }, { status: 500 });
  }
}
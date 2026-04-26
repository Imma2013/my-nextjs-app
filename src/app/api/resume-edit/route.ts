import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Database is not configured');
  return createClient(url, key);
}

export async function POST(req: NextRequest) {
  try {
    const { resumeId, userId, value } = await req.json();
    if (!resumeId || !userId) return NextResponse.json({ error: 'Missing resumeId or userId' }, { status: 400 });
    const supabase = client();
    const loaded = await supabase.from('resumes').select('*').eq('id', resumeId).eq('user_id', userId).single();
    if (loaded.error) throw loaded.error;
    const parsed = JSON.parse(JSON.stringify(loaded.data.parsed_json || {}));
    parsed.sections = parsed.sections || {};
    const exp = Array.isArray(parsed.sections.experience) ? parsed.sections.experience : Array.isArray(parsed.experience) ? parsed.experience : [];
    if (!exp.length) exp.push({ company: 'Company Name', bullets: [] });
    parsed.sections.experience = exp;
    exp[0].role = value || 'Title';
    exp[0].title = value || 'Title';
    const saved = await supabase.from('resumes').update({ parsed_json: parsed }).eq('id', resumeId).eq('user_id', userId).select('*').single();
    if (saved.error) throw saved.error;
    return NextResponse.json({ resume: saved.data, reply: `Updated the first experience job title to "${value || 'Title'}". You should see the preview update now.` });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to edit resume' }, { status: 500 });
  }
}

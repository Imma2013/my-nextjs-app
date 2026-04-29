import { NextRequest, NextResponse } from 'next/server';
import { searchJobs } from '@/lib/jobs';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');

  if (!query) {
    return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });
  }

  try {
    const payload = await searchJobs(query);
    return NextResponse.json({ ...payload, jobs_results: payload.jobs });
  } catch (error: any) {
    console.error('Job search API error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}

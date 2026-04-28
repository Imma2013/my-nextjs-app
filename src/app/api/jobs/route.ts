import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');

  if (!query) {
    return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });
  }

  try {
    const apiKey = "21e2568f036eaa04c45da2e0c37f37423ddd500b319c193c499659170153b380";
    const url = `https://serpapi.com/search.json?engine=google_jobs&google_domain=google.com&hl=en&gl=us&api_key=${apiKey}&q=${encodeURIComponent(query)}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch from SerpApi');
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Job search API error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}

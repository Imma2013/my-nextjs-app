import { NextRequest, NextResponse } from 'next/server';
import { getBillingSummary } from '@/lib/billing';

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    return NextResponse.json(await getBillingSummary(userId));
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to load billing status' }, { status: 500 });
  }
}

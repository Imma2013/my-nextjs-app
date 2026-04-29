import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateStripeCustomer, stripeRequest } from '@/lib/billing';

type PortalResponse = { url: string };

export async function POST(req: NextRequest) {
  try {
    const { userId, returnPath }: { userId?: string; returnPath?: string } = await req.json();
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const safeReturnPath = returnPath?.startsWith('/') ? returnPath : '/';
    const customer = await getOrCreateStripeCustomer(userId);
    const session = await stripeRequest<PortalResponse>('/v1/billing_portal/sessions', {
      customer,
      return_url: `${baseUrl}${safeReturnPath}`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to open billing portal' }, { status: 500 });
  }
}


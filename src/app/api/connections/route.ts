import { Composio } from '@composio/core';
import { NextRequest, NextResponse } from 'next/server';

const composio = new Composio();

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const session = await composio.create(userId);
    const { items } = await session.toolkits({ limit: 50 });

    return NextResponse.json({
      toolkits: items
        .filter(toolkit => !toolkit.isNoAuth)
        .map(toolkit => ({
          slug: toolkit.slug,
          name: toolkit.name,
          logo: toolkit.logo,
          isConnected: toolkit.connection?.isActive ?? false,
          connectedAccountId: toolkit.connection?.connectedAccount?.id,
        })),
    });
  } catch (error) {
    console.error('Failed to load Composio connections:', error);
    return NextResponse.json({ error: 'Failed to load app connections' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId, toolkit }: { userId?: string; toolkit?: string } = await req.json();
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
    if (!toolkit) return NextResponse.json({ error: 'Missing toolkit' }, { status: 400 });

    const origin = new URL(req.url).origin;
    const session = await composio.create(userId);
    const connectionRequest = await session.authorize(toolkit, {
      callbackUrl: `${origin}?view=apps`,
    });

    return NextResponse.json({ redirectUrl: connectionRequest.redirectUrl });
  } catch (error) {
    console.error('Failed to start Composio connection:', error);
    return NextResponse.json({ error: 'Failed to start app connection' }, { status: 500 });
  }
}

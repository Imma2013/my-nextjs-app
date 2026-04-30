import { Composio } from '@composio/core';
import { NextRequest, NextResponse } from 'next/server';

const composio = new Composio();

export async function POST(req: NextRequest) {
  try {
    const { connectedAccountId }: { connectedAccountId?: string } = await req.json();
    if (!connectedAccountId) {
      return NextResponse.json({ error: 'Missing connectedAccountId' }, { status: 400 });
    }

    await composio.connectedAccounts.delete(connectedAccountId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to disconnect Composio account:', error);
    return NextResponse.json({ error: 'Failed to disconnect app' }, { status: 500 });
  }
}

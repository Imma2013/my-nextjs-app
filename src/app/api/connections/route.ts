import { Composio } from '@composio/core';
import { NextRequest, NextResponse } from 'next/server';

const composio = new Composio();

export const dynamic = 'force-dynamic';

const SUPPORTED_TOOLKITS = [
  { slug: 'gmail', aliases: ['gmail'] },
  { slug: 'google_sheets', aliases: ['google_sheets', 'googlesheets', 'google sheets'] },
  { slug: 'google_docs', aliases: ['google_docs', 'googledocs', 'google docs'] },
  { slug: 'google_drive', aliases: ['google_drive', 'googledrive', 'google drive'] },
  { slug: 'outlook', aliases: ['outlook'] },
  { slug: 'onedrive', aliases: ['onedrive', 'one_drive', 'one drive'] },
  { slug: 'linkedin', aliases: ['linkedin', 'linked in'] },
] as const;

type SupportedToolkit = (typeof SUPPORTED_TOOLKITS)[number];
type ToolkitLike = {
  slug?: string | null;
  name?: string | null;
};

function normalizeToolkitKey(value?: string | null) {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
}

function getSupportedToolkit(toolkit: ToolkitLike): SupportedToolkit | undefined {
  const slug = toolkit.slug?.toLowerCase();
  const canonicalMatch = SUPPORTED_TOOLKITS.find(supported => supported.slug === slug);
  if (canonicalMatch) return canonicalMatch;

  const normalizedSlug = normalizeToolkitKey(toolkit.slug);
  const aliasMatch = SUPPORTED_TOOLKITS.find(supported =>
    supported.aliases.some(alias => normalizeToolkitKey(alias) === normalizedSlug)
  );
  if (aliasMatch) return aliasMatch;

  const normalizedName = normalizeToolkitKey(toolkit.name);
  return SUPPORTED_TOOLKITS.find(supported =>
    supported.aliases.some(alias => normalizeToolkitKey(alias) === normalizedName)
  );
}

function getSupportedToolkitOrder(toolkit: ToolkitLike) {
  const supportedToolkit = getSupportedToolkit(toolkit);
  return supportedToolkit ? SUPPORTED_TOOLKITS.indexOf(supportedToolkit) : -1;
}

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const session = await composio.create(userId);
    const { items } = await session.toolkits({ limit: 50 });

    return NextResponse.json({
      toolkits: items
        .filter(toolkit => !toolkit.isNoAuth)
        .filter(toolkit => getSupportedToolkit(toolkit))
        .sort((a, b) => getSupportedToolkitOrder(a) - getSupportedToolkitOrder(b))
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
    if (!getSupportedToolkit({ slug: toolkit })) {
      return NextResponse.json({ error: `Unsupported toolkit: ${toolkit}` }, { status: 400 });
    }

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

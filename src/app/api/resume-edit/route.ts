import { NextRequest, NextResponse } from 'next/server';
import { PaymentRequiredError } from '@/lib/billing';
import { geminiUserError } from '@/lib/gemini';
import { runResumeEdit } from '@/lib/resumeEdit';

export async function POST(req: NextRequest) {
  try {
    const input = await req.json();
    if (!input.resumeId || !input.userId) {
      return NextResponse.json({ error: 'Missing resumeId or userId' }, { status: 400 });
    }

    const result = await runResumeEdit(input);
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    if (e instanceof PaymentRequiredError) {
      return NextResponse.json({ error: e.message, paymentRequired: true, ...e.details }, { status: 402 });
    }
    return NextResponse.json({ error: geminiUserError(e) || 'Failed to edit resume' }, { status: 500 });
  }
}

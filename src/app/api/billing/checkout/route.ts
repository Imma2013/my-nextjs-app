import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateStripeCustomer,
  parseCheckoutPlan,
  priceIdForPlan,
  stripeRequest,
  type CheckoutPlan,
} from '@/lib/billing';

type CheckoutResponse = { id: string; url: string };

function appUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export async function POST(req: NextRequest) {
  try {
    const {
      userId,
      checkoutType,
      plan,
      returnPath,
    }: {
      userId?: string;
      checkoutType?: 'subscription';
      plan?: string;
      returnPath?: string;
    } = await req.json();

    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
    if (checkoutType !== 'subscription') {
      return NextResponse.json({ error: 'Invalid checkout type' }, { status: 400 });
    }

    const customer = await getOrCreateStripeCustomer(userId);
    const baseUrl = appUrl();
    const safeReturnPath = returnPath?.startsWith('/') ? returnPath : '/';
    const successUrl = `${baseUrl}${safeReturnPath}${safeReturnPath.includes('?') ? '&' : '?'}checkout=success`;
    const cancelUrl = `${baseUrl}${safeReturnPath}${safeReturnPath.includes('?') ? '&' : '?'}checkout=cancelled`;

    const parsedPlan = parseCheckoutPlan(plan);
    if (!parsedPlan) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }

    const checkoutPlan = parsedPlan.id as CheckoutPlan;
    const price = priceIdForPlan(checkoutPlan);
    if (!price) return NextResponse.json({ error: 'Stripe plan price is not configured' }, { status: 500 });

    const session = await stripeRequest<CheckoutResponse>('/v1/checkout/sessions', {
      mode: 'subscription',
      customer,
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price]': price,
      'line_items[0][quantity]': 1,
      'metadata[user_id]': userId,
      'metadata[type]': 'subscription',
      'metadata[plan]': checkoutPlan,
      'subscription_data[metadata][user_id]': userId,
      'subscription_data[metadata][plan]': checkoutPlan,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to create checkout session' }, { status: 500 });
  }
}

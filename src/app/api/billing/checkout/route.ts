import { NextRequest, NextResponse } from 'next/server';
import {
  creditsForTopUp,
  getActivePaidPlan,
  getOrCreateStripeCustomer,
  parseCheckoutPlan,
  parseTopUpPackage,
  priceIdForPlan,
  priceIdForTopUp,
  stripeRequest,
  type CheckoutPlan,
  type TopUpPackage,
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
      package: topUpPackage,
      returnPath,
    }: {
      userId?: string;
      checkoutType?: 'subscription' | 'topup';
      plan?: string;
      package?: string;
      returnPath?: string;
    } = await req.json();

    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
    if (checkoutType !== 'subscription' && checkoutType !== 'topup') {
      return NextResponse.json({ error: 'Invalid checkout type' }, { status: 400 });
    }

    const customer = await getOrCreateStripeCustomer(userId);
    const baseUrl = appUrl();
    const safeReturnPath = returnPath?.startsWith('/') ? returnPath : '/';
    const successUrl = `${baseUrl}${safeReturnPath}${safeReturnPath.includes('?') ? '&' : '?'}checkout=success`;
    const cancelUrl = `${baseUrl}${safeReturnPath}${safeReturnPath.includes('?') ? '&' : '?'}checkout=cancelled`;

    if (checkoutType === 'subscription') {
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
        'metadata[actions]': parsedPlan.actions,
        'subscription_data[metadata][user_id]': userId,
        'subscription_data[metadata][plan]': checkoutPlan,
        'subscription_data[metadata][actions]': parsedPlan.actions,
      });

      return NextResponse.json({ url: session.url });
    }

    const parsedTopUp = parseTopUpPackage(topUpPackage);
    if (!parsedTopUp) {
      return NextResponse.json({ error: 'Invalid top-up package' }, { status: 400 });
    }

    const activePlan = await getActivePaidPlan(userId);
    if (!activePlan) {
      return NextResponse.json({ error: 'Top-ups are only available for active paid plans' }, { status: 400 });
    }

    const topUp = parsedTopUp.id as TopUpPackage;
    const price = priceIdForTopUp(topUp);
    if (!price) return NextResponse.json({ error: 'Stripe top-up price is not configured' }, { status: 500 });

    const actions = creditsForTopUp(topUp);
    const session = await stripeRequest<CheckoutResponse>('/v1/checkout/sessions', {
      mode: 'payment',
      customer,
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price]': price,
      'line_items[0][quantity]': 1,
      'metadata[user_id]': userId,
      'metadata[type]': 'topup',
      'metadata[package]': topUp,
      'metadata[plan]': activePlan,
      'metadata[actions]': actions,
      'payment_intent_data[metadata][user_id]': userId,
      'payment_intent_data[metadata][type]': 'topup',
      'payment_intent_data[metadata][package]': topUp,
      'payment_intent_data[metadata][plan]': activePlan,
      'payment_intent_data[metadata][actions]': actions,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to create checkout session' }, { status: 500 });
  }
}

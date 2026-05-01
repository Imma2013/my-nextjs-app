import { NextRequest, NextResponse } from 'next/server';
import {
  creditsForTopUp,
  getActivePaidPlanFamily,
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
        'metadata[plan_family]': parsedPlan.family,
        'metadata[credits]': parsedPlan.credits,
        'subscription_data[metadata][user_id]': userId,
        'subscription_data[metadata][plan]': checkoutPlan,
        'subscription_data[metadata][plan_family]': parsedPlan.family,
        'subscription_data[metadata][credits]': parsedPlan.credits,
      });

      return NextResponse.json({ url: session.url });
    }

    const parsedTopUp = parseTopUpPackage(topUpPackage);
    if (!parsedTopUp) {
      return NextResponse.json({ error: 'Invalid top-up package' }, { status: 400 });
    }

    const activeFamily = await getActivePaidPlanFamily(userId);
    if (!activeFamily) {
      return NextResponse.json({ error: 'Top-ups are only available for active Pro or Business plans' }, { status: 400 });
    }

    const price = priceIdForTopUp(activeFamily);
    if (!price) return NextResponse.json({ error: 'Stripe top-up price is not configured' }, { status: 500 });

    const topUp = parsedTopUp.id as TopUpPackage;
    const credits = creditsForTopUp(topUp);
    const session = await stripeRequest<CheckoutResponse>('/v1/checkout/sessions', {
      mode: 'payment',
      customer,
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      'line_items[0][price]': price,
      'line_items[0][quantity]': credits / 50,
      'metadata[user_id]': userId,
      'metadata[type]': 'topup',
      'metadata[package]': topUp,
      'metadata[plan_family]': activeFamily,
      'metadata[credits]': credits,
      'payment_intent_data[metadata][user_id]': userId,
      'payment_intent_data[metadata][type]': 'topup',
      'payment_intent_data[metadata][package]': topUp,
      'payment_intent_data[metadata][plan_family]': activeFamily,
      'payment_intent_data[metadata][credits]': credits,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to create checkout session' }, { status: 500 });
  }
}

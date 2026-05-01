import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  adminClient,
  creditsForPlan,
  creditsForTopUp,
  parseCheckoutPlan,
  parseTopUpPackage,
  PLAN_FAMILIES,
  PLAN_TIERS,
  priceIdForPlan,
  stripeGet,
  type CheckoutPlan,
  type TopUpPackage,
} from '@/lib/billing';

export const runtime = 'nodejs';

function verifyStripeSignature(payload: string, signature: string | null) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('Stripe webhook secret is not configured');
  if (!signature) throw new Error('Missing Stripe signature');

  const parts = signature.split(',').reduce<Record<string, string>>((acc, part) => {
    const [key, value] = part.split('=');
    if (key && value) acc[key] = value;
    return acc;
  }, {});

  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) throw new Error('Invalid Stripe signature');

  const signedPayload = `${timestamp}.${payload}`;
  const actual = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('Invalid Stripe signature');
  }
}

function planFromPrice(priceId?: string | null): CheckoutPlan | null {
  if (!priceId) return null;
  for (const family of PLAN_FAMILIES) {
    for (const tier of PLAN_TIERS) {
      const plan = `${family}_${tier}_monthly` as CheckoutPlan;
      if (priceId === priceIdForPlan(plan)) return plan;
    }
  }
  return null;
}

function timestampToIso(value?: number | null) {
  return value ? new Date(value * 1000).toISOString() : null;
}

function addOneMonth(iso?: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}

async function upsertCustomer(userId: string, customerId: string) {
  const supabase = adminClient();
  const { error } = await supabase
    .from('billing_customers')
    .upsert({ user_id: userId, stripe_customer_id: customerId, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

  if (error) throw error;
}

async function insertCreditLedgerOnce(row: Record<string, unknown>) {
  const supabase = adminClient();
  const { error } = await supabase.from('credit_ledger').insert(row);

  if (!error) return;
  if (error.code === '23505') return;
  throw error;
}

async function userIdForCustomer(customerId: string) {
  const supabase = adminClient();
  const { data } = await supabase
    .from('billing_customers')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data?.user_id as string | undefined;
}

async function handleCheckoutCompleted(event: any) {
  const session = event.data.object;
  const userId = session.metadata?.user_id || session.client_reference_id;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (!userId || !customerId) return;

  await upsertCustomer(userId, customerId);

  if (session.mode !== 'payment' || session.metadata?.type !== 'topup') return;

  const parsedTopUp = parseTopUpPackage(session.metadata?.package);
  if (!parsedTopUp) return;
  const pkg = parsedTopUp.id as TopUpPackage;

  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  await insertCreditLedgerOnce({
    user_id: userId,
    event_type: 'purchase',
    amount: creditsForTopUp(pkg),
    source: 'stripe_topup',
    stripe_event_id: event.id,
    stripe_checkout_session_id: session.id,
    expires_at: expiresAt.toISOString(),
    metadata: { package: pkg, plan_family: session.metadata?.plan_family || null },
  });
}

async function subscriptionCreditsGrantedThisPeriod({
  userId,
  subscriptionId,
  periodStart,
}: {
  userId: string;
  subscriptionId: string;
  periodStart?: string | null;
}) {
  if (!periodStart) return 0;
  const supabase = adminClient();
  const { data, error } = await supabase
    .from('credit_ledger')
    .select('amount')
    .eq('user_id', userId)
    .eq('stripe_subscription_id', subscriptionId)
    .eq('source', 'stripe_subscription')
    .contains('metadata', { period_start: periodStart });

  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
}

async function upsertSubscriptionFromStripe(subscription: any, eventId?: string) {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const userId = subscription.metadata?.user_id || (customerId ? await userIdForCustomer(customerId) : undefined);
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = parseCheckoutPlan(subscription.metadata?.plan)?.id || planFromPrice(priceId);
  const parsedPlan = parseCheckoutPlan(plan);
  if (!userId || !customerId || !plan || !parsedPlan) return;

  await upsertCustomer(userId, customerId);

  const currentPeriodStart = timestampToIso(subscription.current_period_start);
  const currentPeriodEnd = timestampToIso(subscription.current_period_end);
  const supabase = adminClient();
  const { error: subscriptionError } = await supabase.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    plan,
    price_id: priceId,
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'stripe_subscription_id' });

  if (subscriptionError) throw subscriptionError;

  if (eventId && ['active', 'trialing'].includes(subscription.status)) {
    const alreadyGranted = await subscriptionCreditsGrantedThisPeriod({
      userId,
      subscriptionId: subscription.id,
      periodStart: currentPeriodStart,
    });
    const grantAmount = Math.max(0, creditsForPlan(plan) - alreadyGranted);
    if (grantAmount <= 0) return;

    await insertCreditLedgerOnce({
      user_id: userId,
      event_type: 'subscription_grant',
      amount: grantAmount,
      source: 'stripe_subscription',
      stripe_event_id: eventId,
      stripe_subscription_id: subscription.id,
      expires_at: addOneMonth(currentPeriodEnd),
      metadata: {
        plan,
        plan_family: parsedPlan.family,
        tier: parsedPlan.tier,
        period_start: currentPeriodStart,
        period_end: currentPeriodEnd,
        full_period_credits: parsedPlan.credits,
        already_granted: alreadyGranted,
      },
    });
  }
}

async function handleInvoicePaid(event: any) {
  const invoice = event.data.object;
  const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  if (!subscriptionId) return;

  const subscription = await stripeGet<any>(`/v1/subscriptions/${subscriptionId}`);
  await upsertSubscriptionFromStripe(subscription, event.id);
}

async function handleSubscriptionEvent(event: any) {
  await upsertSubscriptionFromStripe(event.data.object);
}

export async function POST(req: NextRequest) {
  const payload = await req.text();

  try {
    verifyStripeSignature(payload, req.headers.get('stripe-signature'));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid signature' }, { status: 400 });
  }

  try {
    const event = JSON.parse(payload);

    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event);
    } else if (event.type === 'invoice.payment_succeeded') {
      await handleInvoicePaid(event);
    } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      await handleSubscriptionEvent(event);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Webhook failed' }, { status: 500 });
  }
}

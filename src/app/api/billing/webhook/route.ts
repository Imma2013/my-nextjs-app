import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  adminClient,
  parseActivePaidPlan,
  parseCheckoutPlan,
  priceIdForPlan,
  stripeGet,
  type CheckoutPlan,
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
  if (priceId === priceIdForPlan('chat_monthly')) return 'chat_monthly';
  return null;
}

function timestampToIso(value?: number | null) {
  return value ? new Date(value * 1000).toISOString() : null;
}

async function upsertCustomer(userId: string, customerId: string) {
  const supabase = adminClient();
  const { error } = await supabase
    .from('billing_customers')
    .upsert({ user_id: userId, stripe_customer_id: customerId, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

  if (error) throw error;
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
}

async function upsertSubscriptionFromStripe(subscription: any) {
  let customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const supabase = adminClient();
  const { data: existingSubscription } = await supabase
    .from('subscriptions')
    .select('user_id, stripe_customer_id, plan')
    .eq('stripe_subscription_id', subscription.id)
    .maybeSingle();

  let userId = subscription.metadata?.user_id || existingSubscription?.user_id || (customerId ? await userIdForCustomer(customerId) : undefined);
  customerId = customerId || existingSubscription?.stripe_customer_id;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const checkoutPlan = parseCheckoutPlan(subscription.metadata?.plan)?.id || planFromPrice(priceId);
  const plan = checkoutPlan || parseActivePaidPlan(subscription.metadata?.plan) || parseActivePaidPlan(existingSubscription?.plan);
  if (!userId || !customerId || !plan) return;

  await upsertCustomer(userId, customerId);

  const currentPeriodStart = timestampToIso(subscription.current_period_start);
  const currentPeriodEnd = timestampToIso(subscription.current_period_end);
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
}

async function handleInvoicePaid(event: any) {
  const invoice = event.data.object;
  const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  if (!subscriptionId) return;

  const subscription = await stripeGet<any>(`/v1/subscriptions/${subscriptionId}`);
  await upsertSubscriptionFromStripe(subscription);
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

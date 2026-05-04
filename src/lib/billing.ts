import { createClient } from '@supabase/supabase-js';

export type BillingAction =
  | 'tailor_resume'
  | 'resume_edit'
  | 'resume_optimizer'
  | 'cover_letter'
  | 'resume_builder'
  | 'ai_chat_reply';

export type CheckoutPlan = 'chat_monthly';
export type LegacyPaidPlan = 'pro_monthly' | 'pro_plus_monthly';
export type ActivePaidPlan = CheckoutPlan | LegacyPaidPlan;
export type BillingPlan = 'unpaid' | ActivePaidPlan;

export class PaymentRequiredError extends Error {
  details: Record<string, unknown>;

  constructor(message = 'Subscribe to Cryzo to use AI Chat + Resume Agent.', details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PaymentRequiredError';
    this.details = details;
  }
}

export const PLAN_PRICES: Record<CheckoutPlan, number> = {
  chat_monthly: 10,
};

export const PLAN_NAMES: Record<CheckoutPlan, string> = {
  chat_monthly: 'AI Chat + Resume Agent',
};

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Database is not configured');
  return createClient(url, key, { auth: { persistSession: false } });
}

export function creditCostForAction(action: BillingAction) {
  if (action === 'resume_builder') return 2;
  return 1;
}

export function isPaidBillingAction(action?: string | null): action is BillingAction {
  return Boolean(action && ['tailor_resume', 'resume_edit', 'resume_optimizer', 'cover_letter', 'resume_builder', 'ai_chat_reply'].includes(action));
}

export function inferResumeBillingAction(message: string): BillingAction {
  return /\btailor(?:ing)?\b|\btarget\b|\bats\b|\bjob description\b|\bjob\b/i.test(message)
    ? 'tailor_resume'
    : 'resume_edit';
}

export function parseCheckoutPlan(plan?: string | null) {
  if (plan !== 'chat_monthly') return null;
  return {
    id: plan,
    price: PLAN_PRICES[plan],
    name: PLAN_NAMES[plan],
  };
}

export function parseActivePaidPlan(plan?: string | null): ActivePaidPlan | null {
  if (plan === 'chat_monthly' || plan === 'pro_monthly' || plan === 'pro_plus_monthly') return plan;
  return null;
}

export function priceIdForPlan(plan: CheckoutPlan) {
  if (plan === 'chat_monthly') return process.env.NEXT_PUBLIC_STRIPE_CHAT_MONTHLY_PRICE_ID;
  return undefined;
}

export function creditsForPlan(_plan: CheckoutPlan) {
  void _plan;
  return 0;
}

export function hasActiveSubscriptionStatus(status?: string | null) {
  return status === 'active' || status === 'trialing';
}

export function canUsePaidAI(plan?: string | null, status?: string | null) {
  return Boolean(parseActivePaidPlan(plan) && hasActiveSubscriptionStatus(status));
}

export async function getActivePaidPlan(userId: string): Promise<ActivePaidPlan | null> {
  const supabase = adminClient();
  const { data, error } = await supabase
    .from('subscriptions')
    .select('plan, status, current_period_end')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .order('current_period_end', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return parseActivePaidPlan(data?.plan);
}

export async function getBillingSummary(userId: string) {
  const supabase = adminClient();

  const { data: subscription, error: subscriptionError } = await supabase
    .from('subscriptions')
    .select('plan, status, current_period_end')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .order('current_period_end', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subscriptionError) throw subscriptionError;

  const activePlan = parseActivePaidPlan(subscription?.plan);
  const isPaid = Boolean(activePlan);
  const plan = activePlan || 'unpaid';

  return {
    userId,
    plan,
    planStatus: isPaid ? subscription?.status || 'inactive' : 'unpaid',
    isPaid,
    currentPeriodEnd: subscription?.current_period_end || null,
    monthlyActionsRemaining: 0,
    monthlyActionsLimit: 0,
    rolloverActionsRemaining: 0,
    topUpActionsRemaining: 0,
    totalActionsRemaining: 0,
    freeMonthlyActionsUsed: 0,
    pdfDownloadsUsed: 0,
    pdfDownloadsLimit: null,
    credits: 0,
    freeTailorAvailable: false,
  };
}

async function getUsageEvent({
  supabase,
  userId,
  actionType,
  idempotencyKey,
}: {
  supabase: ReturnType<typeof adminClient>;
  userId: string;
  actionType: BillingAction;
  idempotencyKey: string;
}) {
  const { data, error } = await supabase
    .from('usage_events')
    .select('id, credits_charged, free_tailor_used, billing_source, status')
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getLatestSubscriptionForUser(userId: string) {
  const supabase = adminClient();
  const { data, error } = await supabase
    .from('subscriptions')
    .select('plan, status, current_period_end')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .order('current_period_end', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function assertCanUsePaidAI(userId: string) {
  const subscription = await getLatestSubscriptionForUser(userId);
  if (canUsePaidAI(subscription?.plan, subscription?.status)) {
    return {
      plan: parseActivePaidPlan(subscription?.plan),
      status: subscription?.status,
    };
  }

  throw new PaymentRequiredError('Subscribe to Cryzo to use AI Chat + Resume Agent.', {
    subscriptionRequired: true,
    plan: parseActivePaidPlan(subscription?.plan) || 'unpaid',
    status: subscription?.status || 'unpaid',
  });
}

export async function assertCanRunPaidAction({
  userId,
  actionType,
  cost,
  idempotencyKey,
}: {
  userId: string;
  actionType: BillingAction;
  cost: number;
  idempotencyKey: string;
}) {
  const supabase = adminClient();
  const existing = await getUsageEvent({ supabase, userId, actionType, idempotencyKey });
  if (existing?.status === 'completed') {
    return {
      mode: existing.billing_source || 'subscription',
      alreadyRecorded: true,
    } as const;
  }

  const subscription = await assertCanUsePaidAI(userId);
  return {
    mode: 'subscription',
    alreadyRecorded: false,
    cost,
    plan: subscription.plan,
  } as const;
}

export async function recordPaidActionSuccess({
  userId,
  actionType,
  cost,
  idempotencyKey,
  resumeId,
}: {
  userId: string;
  actionType: BillingAction;
  cost: number;
  idempotencyKey: string;
  resumeId?: string | null;
}) {
  const supabase = adminClient();
  await assertCanUsePaidAI(userId);

  const completedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('usage_events')
    .upsert({
      user_id: userId,
      action_type: actionType,
      idempotency_key: idempotencyKey,
      resume_id: resumeId || null,
      credits_charged: cost,
      free_tailor_used: false,
      billing_source: 'subscription',
      status: 'completed',
      completed_at: completedAt,
    }, { onConflict: 'user_id,action_type,idempotency_key' })
    .select('id, credits_charged, billing_source, status')
    .single();

  if (error) throw error;

  return {
    usageEventId: data?.id,
    creditsCharged: data?.credits_charged,
    billingSource: data?.billing_source,
    alreadyRecorded: false,
  };
}

export async function getOrCreateStripeCustomer(userId: string) {
  const supabase = adminClient();
  const { data: existing, error } = await supabase
    .from('billing_customers')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  if (existing?.stripe_customer_id) return existing.stripe_customer_id as string;

  const customer = await stripeRequest<{ id: string }>('/v1/customers', {
    'metadata[user_id]': userId,
  });

  const { error: insertError } = await supabase
    .from('billing_customers')
    .upsert({ user_id: userId, stripe_customer_id: customer.id }, { onConflict: 'user_id' });

  if (insertError) throw insertError;
  return customer.id;
}

export async function stripeRequest<T>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('Stripe is not configured');

  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) body.append(key, String(value));
  });

  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'Stripe request failed');
  }

  return data as T;
}

export async function stripeGet<T>(path: string) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('Stripe is not configured');

  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'Stripe request failed');
  }

  return data as T;
}

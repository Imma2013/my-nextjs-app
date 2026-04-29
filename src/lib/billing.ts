import { createClient } from '@supabase/supabase-js';

export type BillingAction =
  | 'tailor_resume'
  | 'resume_edit'
  | 'resume_optimizer'
  | 'cover_letter'
  | 'resume_builder';

export type CheckoutPlan = 'pro' | 'pro_plus';
export type TopUpPackage = 'credits_5' | 'credits_20' | 'credits_50';

export class PaymentRequiredError extends Error {
  details: Record<string, unknown>;

  constructor(message = 'Not enough credits', details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PaymentRequiredError';
    this.details = details;
  }
}

const PLAN_CREDITS: Record<CheckoutPlan, number> = {
  pro: 30,
  pro_plus: 75,
};

const TOP_UP_CREDITS: Record<TopUpPackage, number> = {
  credits_5: 5,
  credits_20: 20,
  credits_50: 50,
};

export const PLAN_NAMES: Record<CheckoutPlan, string> = {
  pro: 'Pro',
  pro_plus: 'Pro Plus',
};

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Database is not configured');
  return createClient(url, key, { auth: { persistSession: false } });
}

export function creditCostForAction(action: BillingAction) {
  return action === 'resume_builder' ? 2 : 1;
}

export function isPaidBillingAction(action?: string | null): action is BillingAction {
  return Boolean(action && ['tailor_resume', 'resume_edit', 'resume_optimizer', 'cover_letter', 'resume_builder'].includes(action));
}

export function inferResumeBillingAction(message: string): BillingAction {
  return /\btailor(?:ing)?\b|\btarget\b|\bats\b|\bjob description\b|\bjob\b/i.test(message)
    ? 'tailor_resume'
    : 'resume_edit';
}

export function priceIdForPlan(plan: CheckoutPlan) {
  return plan === 'pro'
    ? process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID
    : process.env.NEXT_PUBLIC_STRIPE_PRO_PLUS_PRICE_ID;
}

export function priceIdForTopUp(pkg: TopUpPackage) {
  if (pkg === 'credits_5') return process.env.NEXT_PUBLIC_STRIPE_TOPUP_5_PRICE_ID;
  if (pkg === 'credits_20') return process.env.NEXT_PUBLIC_STRIPE_TOPUP_20_PRICE_ID;
  return process.env.NEXT_PUBLIC_STRIPE_TOPUP_50_PRICE_ID;
}

export function creditsForPlan(plan: CheckoutPlan) {
  return PLAN_CREDITS[plan];
}

export function creditsForTopUp(pkg: TopUpPackage) {
  return TOP_UP_CREDITS[pkg];
}

export async function getBillingSummary(userId: string) {
  const supabase = adminClient();
  const now = new Date().toISOString();

  const [{ data: ledger, error: ledgerError }, { data: subscription }, { data: freeTailorEvents }] = await Promise.all([
    supabase
      .from('credit_ledger')
      .select('amount, expires_at')
      .eq('user_id', userId)
      .or(`expires_at.is.null,expires_at.gt.${now}`),
    supabase
      .from('subscriptions')
      .select('plan, status, current_period_end')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .order('current_period_end', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('usage_events')
      .select('id')
      .eq('user_id', userId)
      .eq('action_type', 'tailor_resume')
      .eq('free_tailor_used', true)
      .eq('status', 'completed')
      .limit(1),
  ]);

  if (ledgerError) throw ledgerError;

  const credits = (ledger || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const plan = subscription?.plan || 'free';

  return {
    userId,
    credits: Math.max(0, credits),
    plan,
    planStatus: subscription?.status || 'free',
    currentPeriodEnd: subscription?.current_period_end || null,
    freeTailorAvailable: !freeTailorEvents?.length,
  };
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

  const { data: existing, error: existingError } = await supabase
    .from('usage_events')
    .select('id, credits_charged, free_tailor_used, status')
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.status === 'completed') {
    return {
      mode: existing.free_tailor_used ? 'free_tailor' : 'credits',
      alreadyRecorded: true,
    } as const;
  }

  const summary = await getBillingSummary(userId);
  if (actionType === 'tailor_resume' && summary.freeTailorAvailable) {
    return { mode: 'free_tailor', alreadyRecorded: false } as const;
  }

  if (summary.credits >= cost) {
    return { mode: 'credits', alreadyRecorded: false } as const;
  }

  throw new PaymentRequiredError('You need credits to run this AI resume action.', {
    credits: summary.credits,
    cost,
    freeTailorAvailable: summary.freeTailorAvailable,
    plan: summary.plan,
  });
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
  const { data, error } = await supabase.rpc('consume_resume_ai_credit', {
    p_user_id: userId,
    p_action_type: actionType,
    p_idempotency_key: idempotencyKey,
    p_resume_id: resumeId || null,
    p_cost: cost,
  });

  if (!error) return data;

  if (error.message?.includes('INSUFFICIENT_CREDITS')) {
    throw new PaymentRequiredError('You need credits to run this AI resume action.');
  }

  throw error;
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

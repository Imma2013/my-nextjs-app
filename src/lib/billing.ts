import { createClient } from '@supabase/supabase-js';

export type BillingAction =
  | 'tailor_resume'
  | 'resume_edit'
  | 'resume_optimizer'
  | 'cover_letter'
  | 'resume_builder';

export type CheckoutPlan = 'pro_monthly' | 'pro_plus_monthly';
export type BillingPlan = 'free' | CheckoutPlan;
export type TopUpPackage = 'actions_50';

export class PaymentRequiredError extends Error {
  details: Record<string, unknown>;

  constructor(message = 'Not enough AI actions', details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PaymentRequiredError';
    this.details = details;
  }
}

export const PLAN_ACTIONS: Record<CheckoutPlan, number> = {
  pro_monthly: 100,
  pro_plus_monthly: 400,
};

export const PLAN_ROLLOVER_CAPS: Record<CheckoutPlan, number> = {
  pro_monthly: 100,
  pro_plus_monthly: 400,
};

export const PLAN_PRICES: Record<CheckoutPlan, number> = {
  pro_monthly: 20,
  pro_plus_monthly: 60,
};

export const PLAN_NAMES: Record<CheckoutPlan, string> = {
  pro_monthly: 'Pro',
  pro_plus_monthly: 'Pro Plus',
};

export const FREE_MONTHLY_ACTION_LIMIT = 5;
export const FREE_PDF_DOWNLOAD_LIMIT = 3;
export const TOP_UP_ACTIONS = 50;
export const TOP_UP_PRICE = 15;

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
  return Boolean(action && ['tailor_resume', 'resume_edit', 'resume_optimizer', 'cover_letter', 'resume_builder'].includes(action));
}

export function inferResumeBillingAction(message: string): BillingAction {
  return /\btailor(?:ing)?\b|\btarget\b|\bats\b|\bjob description\b|\bjob\b/i.test(message)
    ? 'tailor_resume'
    : 'resume_edit';
}

export function parseCheckoutPlan(plan?: string | null) {
  if (plan !== 'pro_monthly' && plan !== 'pro_plus_monthly') return null;
  return {
    id: plan,
    actions: PLAN_ACTIONS[plan],
    rolloverCap: PLAN_ROLLOVER_CAPS[plan],
    price: PLAN_PRICES[plan],
    name: PLAN_NAMES[plan],
  };
}

export function parseTopUpPackage(pkg?: string | null) {
  if (pkg !== 'actions_50') return null;
  return { id: 'actions_50' as TopUpPackage, actions: TOP_UP_ACTIONS, price: TOP_UP_PRICE };
}

export function priceIdForPlan(plan: CheckoutPlan) {
  if (plan === 'pro_monthly') return process.env.NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID;
  if (plan === 'pro_plus_monthly') return process.env.NEXT_PUBLIC_STRIPE_PRO_PLUS_MONTHLY_PRICE_ID;
  return undefined;
}

export function priceIdForTopUp(pkg: TopUpPackage) {
  if (pkg === 'actions_50') return process.env.NEXT_PUBLIC_STRIPE_ACTIONS_TOPUP_50_PRICE_ID;
  return undefined;
}

export function creditsForPlan(plan: CheckoutPlan) {
  return parseCheckoutPlan(plan)?.actions || 0;
}

export function creditsForTopUp(pkg: TopUpPackage) {
  return parseTopUpPackage(pkg)?.actions || 0;
}

function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}

function startOfUtcMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfNextUtcMonth(date = new Date()) {
  const next = startOfUtcMonth(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export function freeMonthlyActionsRemaining(used: number, limit = FREE_MONTHLY_ACTION_LIMIT) {
  return Math.max(0, limit - used);
}

export async function getActivePaidPlan(userId: string): Promise<CheckoutPlan | null> {
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
  const parsed = parseCheckoutPlan(data?.plan);
  return (parsed?.id as CheckoutPlan | undefined) || null;
}

export async function getBillingSummary(userId: string) {
  const supabase = adminClient();
  const now = new Date().toISOString();
  const monthStart = startOfUtcMonth().toISOString();
  const nextMonthStart = startOfNextUtcMonth().toISOString();

  const [{ data: ledger, error: ledgerError }, { data: subscription }, { data: freeMonthlyEvents }, { data: pdfDownloads }] = await Promise.all([
    supabase
      .from('credit_ledger')
      .select('amount, source, expires_at')
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
      .select('credits_charged')
      .eq('user_id', userId)
      .eq('billing_source', 'free_monthly')
      .eq('status', 'completed')
      .gte('completed_at', monthStart)
      .lt('completed_at', nextMonthStart),
    supabase
      .from('usage_events')
      .select('id')
      .eq('user_id', userId)
      .eq('action_type', 'pdf_download')
      .eq('status', 'completed'),
  ]);

  if (ledgerError) throw ledgerError;

  const parsedPlan = parseCheckoutPlan(subscription?.plan);
  const plan = parsedPlan?.id || 'free';
  const monthlyActionsLimit = parsedPlan?.actions || FREE_MONTHLY_ACTION_LIMIT;
  const currentPeriodEnd = subscription?.current_period_end || null;
  const freeMonthlyActionsUsed = parsedPlan
    ? 0
    : roundCredits((freeMonthlyEvents || []).reduce((sum, row) => sum + Number(row.credits_charged || 0), 0));

  const activeLedger = ledger || [];
  const subscriptionRows = activeLedger.filter(row => ['stripe_subscription', 'subscription_usage'].includes(String(row.source)));
  const topUpRows = activeLedger.filter(row => ['stripe_topup', 'topup_usage'].includes(String(row.source)));
  const subscriptionActionsRemaining = Math.max(0, roundCredits(subscriptionRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)));
  const rolloverActionsRemaining = parsedPlan && currentPeriodEnd
    ? Math.max(0, roundCredits(subscriptionRows
      .filter(row => row.expires_at && String(row.expires_at) <= currentPeriodEnd)
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)))
    : 0;
  const monthlyActionsRemaining = parsedPlan
    ? Math.max(0, roundCredits(subscriptionActionsRemaining - rolloverActionsRemaining))
    : freeMonthlyActionsRemaining(freeMonthlyActionsUsed);
  const topUpActionsRemaining = Math.max(0, roundCredits(topUpRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)));
  const totalActionsRemaining = parsedPlan
    ? roundCredits(subscriptionActionsRemaining + topUpActionsRemaining)
    : monthlyActionsRemaining;

  return {
    userId,
    plan,
    planStatus: parsedPlan ? subscription?.status || 'inactive' : 'free',
    currentPeriodEnd,
    monthlyActionsRemaining,
    monthlyActionsLimit,
    rolloverActionsRemaining,
    topUpActionsRemaining,
    totalActionsRemaining,
    freeMonthlyActionsUsed,
    pdfDownloadsUsed: pdfDownloads?.length || 0,
    pdfDownloadsLimit: parsedPlan ? null : FREE_PDF_DOWNLOAD_LIMIT,
    credits: totalActionsRemaining,
    freeTailorAvailable: plan === 'free' && monthlyActionsRemaining >= creditCostForAction('tailor_resume'),
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
    .select('id, credits_charged, free_tailor_used, billing_source, status')
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.status === 'completed') {
    return {
      mode: existing.billing_source || (existing.free_tailor_used ? 'free_monthly' : 'actions'),
      alreadyRecorded: true,
    } as const;
  }

  const summary = await getBillingSummary(userId);
  if (summary.plan === 'free' && summary.monthlyActionsRemaining >= cost) {
    return { mode: 'free_monthly', alreadyRecorded: false } as const;
  }

  if (summary.plan !== 'free' && summary.totalActionsRemaining >= cost) {
    return { mode: 'actions', alreadyRecorded: false } as const;
  }

  throw new PaymentRequiredError(`This AI action costs ${cost} action${cost === 1 ? '' : 's'}. You have ${summary.totalActionsRemaining} remaining.`, {
    credits: summary.totalActionsRemaining,
    remainingActions: summary.totalActionsRemaining,
    monthlyActionsRemaining: summary.monthlyActionsRemaining,
    rolloverActionsRemaining: summary.rolloverActionsRemaining,
    topUpActionsRemaining: summary.topUpActionsRemaining,
    cost,
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
    throw new PaymentRequiredError('You need AI actions to run this resume action.');
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

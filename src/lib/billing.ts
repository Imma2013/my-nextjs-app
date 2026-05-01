import { createClient } from '@supabase/supabase-js';

export type BillingAction =
  | 'tailor_resume'
  | 'resume_edit'
  | 'resume_optimizer'
  | 'cover_letter'
  | 'resume_builder';

export type PlanFamily = 'pro' | 'business';
export type PlanTier = 100 | 200 | 400 | 800 | 1200 | 2000 | 3000 | 4000 | 5000 | 7500 | 10000;
export type CheckoutPlan = `${PlanFamily}_${PlanTier}_monthly`;
export type TopUpPackage =
  | 'credits_50'
  | 'credits_100'
  | 'credits_150'
  | 'credits_200'
  | 'credits_250'
  | 'credits_300'
  | 'credits_350'
  | 'credits_400'
  | 'credits_450'
  | 'credits_500'
  | 'credits_550'
  | 'credits_600'
  | 'credits_650'
  | 'credits_700'
  | 'credits_750'
  | 'credits_800'
  | 'credits_850'
  | 'credits_900'
  | 'credits_950'
  | 'credits_1000';

export class PaymentRequiredError extends Error {
  details: Record<string, unknown>;

  constructor(message = 'Not enough credits', details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PaymentRequiredError';
    this.details = details;
  }
}

export const PLAN_TIERS = [100, 200, 400, 800, 1200, 2000, 3000, 4000, 5000, 7500, 10000] as const;
export const PLAN_FAMILIES = ['pro', 'business'] as const;
export const TOP_UP_AMOUNTS = Array.from({ length: 20 }, (_, index) => (index + 1) * 50);

export const PLAN_PRICES: Record<PlanFamily, Record<PlanTier, number>> = {
  pro: {
    100: 25,
    200: 50,
    400: 100,
    800: 200,
    1200: 294,
    2000: 480,
    3000: 705,
    4000: 920,
    5000: 1125,
    7500: 1688,
    10000: 2250,
  },
  business: {
    100: 50,
    200: 100,
    400: 200,
    800: 400,
    1200: 588,
    2000: 960,
    3000: 1410,
    4000: 1840,
    5000: 2250,
    7500: 3300,
    10000: 4300,
  },
};

export const FREE_DAILY_CREDITS = 5;
export const FREE_MONTHLY_CREDIT_CAP = 30;
export const FREE_PDF_DOWNLOAD_LIMIT = 3;

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Database is not configured');
  return createClient(url, key, { auth: { persistSession: false } });
}

export function creditCostForAction(action: BillingAction) {
  if (action === 'resume_edit') return 0.9;
  if (action === 'resume_builder') return 2;
  return 1.2;
}

export function isPaidBillingAction(action?: string | null): action is BillingAction {
  return Boolean(action && ['tailor_resume', 'resume_edit', 'resume_optimizer', 'cover_letter', 'resume_builder'].includes(action));
}

export function inferResumeBillingAction(message: string): BillingAction {
  return /\btailor(?:ing)?\b|\btarget\b|\bats\b|\bjob description\b|\bjob\b/i.test(message)
    ? 'tailor_resume'
    : 'resume_edit';
}

function titleCasePlanFamily(family: PlanFamily) {
  return family === 'business' ? 'Business' : 'Pro';
}

export function checkoutPlanId(family: PlanFamily, tier: PlanTier): CheckoutPlan {
  return `${family}_${tier}_monthly`;
}

export function parseCheckoutPlan(plan?: string | null) {
  const match = /^([a-z]+)_(\d+)_monthly$/.exec(String(plan || ''));
  if (!match) return null;
  const family = match[1] as PlanFamily;
  const tier = Number(match[2]) as PlanTier;
  if (!PLAN_FAMILIES.includes(family) || !PLAN_TIERS.includes(tier)) return null;
  return {
    id: checkoutPlanId(family, tier),
    family,
    tier,
    credits: tier,
    price: PLAN_PRICES[family][tier],
    name: `${titleCasePlanFamily(family)} ${tier}`,
  };
}

export function parseTopUpPackage(pkg?: string | null) {
  const match = /^credits_(\d+)$/.exec(String(pkg || ''));
  if (!match) return null;
  const credits = Number(match[1]);
  if (!TOP_UP_AMOUNTS.includes(credits)) return null;
  return { id: `credits_${credits}` as TopUpPackage, credits };
}

export function priceIdForPlan(plan: CheckoutPlan) {
  const parsed = parseCheckoutPlan(plan);
  if (!parsed) return undefined;
  return process.env[`NEXT_PUBLIC_STRIPE_${parsed.family.toUpperCase()}_${parsed.tier}_MONTHLY_PRICE_ID`];
}

export function priceIdForTopUp(family: PlanFamily) {
  return process.env[`NEXT_PUBLIC_STRIPE_${family.toUpperCase()}_TOPUP_50_PRICE_ID`];
}

export function creditsForPlan(plan: CheckoutPlan) {
  return parseCheckoutPlan(plan)?.credits || 0;
}

export function creditsForTopUp(pkg: TopUpPackage) {
  return parseTopUpPackage(pkg)?.credits || 0;
}

function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfNextUtcDay(date = new Date()) {
  const next = startOfUtcDay(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function startOfUtcMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfNextUtcMonth(date = new Date()) {
  const next = startOfUtcMonth(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export async function getActivePaidPlanFamily(userId: string): Promise<PlanFamily | null> {
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
  return parsed?.family || null;
}

export async function getBillingSummary(userId: string) {
  const supabase = adminClient();
  const now = new Date().toISOString();
  const todayStart = startOfUtcDay().toISOString();
  const tomorrowStart = startOfNextUtcDay().toISOString();
  const monthStart = startOfUtcMonth().toISOString();
  const nextMonthStart = startOfNextUtcMonth().toISOString();

  const [{ data: ledger, error: ledgerError }, { data: subscription }, { data: freeDailyEvents }, { data: freeMonthlyEvents }, { data: pdfDownloads }] = await Promise.all([
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
      .eq('billing_source', 'free_daily')
      .eq('status', 'completed')
      .gte('completed_at', todayStart)
      .lt('completed_at', tomorrowStart),
    supabase
      .from('usage_events')
      .select('credits_charged')
      .eq('user_id', userId)
      .eq('billing_source', 'free_daily')
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

  const paidCredits = roundCredits((ledger || []).reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const dailyFreeCreditsUsed = roundCredits((freeDailyEvents || []).reduce((sum, row) => sum + Number(row.credits_charged || 0), 0));
  const monthlyFreeCreditsUsed = roundCredits((freeMonthlyEvents || []).reduce((sum, row) => sum + Number(row.credits_charged || 0), 0));
  const dailyFreeCreditsRemaining = roundCredits(Math.max(0, Math.min(
    FREE_DAILY_CREDITS - dailyFreeCreditsUsed,
    FREE_MONTHLY_CREDIT_CAP - monthlyFreeCreditsUsed,
  )));
  const parsedPlan = parseCheckoutPlan(subscription?.plan);

  return {
    userId,
    credits: roundCredits(Math.max(0, paidCredits + dailyFreeCreditsRemaining)),
    paidCredits: Math.max(0, paidCredits),
    dailyFreeCreditsRemaining,
    dailyFreeCreditsUsed,
    monthlyFreeCreditsUsed,
    monthlyFreeCreditCap: FREE_MONTHLY_CREDIT_CAP,
    freeDailyCreditLimit: FREE_DAILY_CREDITS,
    plan: parsedPlan?.id || 'free',
    planFamily: parsedPlan?.family || 'free',
    planTier: parsedPlan?.tier || null,
    planStatus: subscription?.status || 'free',
    currentPeriodEnd: subscription?.current_period_end || null,
    freeTailorAvailable: dailyFreeCreditsRemaining >= creditCostForAction('tailor_resume'),
    pdfDownloadsUsed: pdfDownloads?.length || 0,
    pdfDownloadsLimit: parsedPlan ? null : FREE_PDF_DOWNLOAD_LIMIT,
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
      mode: existing.free_tailor_used ? 'free_daily' : 'credits',
      alreadyRecorded: true,
    } as const;
  }

  const summary = await getBillingSummary(userId);
  if (summary.dailyFreeCreditsRemaining >= cost) {
    return { mode: 'free_daily', alreadyRecorded: false } as const;
  }

  if (summary.paidCredits >= cost) {
    return { mode: 'credits', alreadyRecorded: false } as const;
  }

  throw new PaymentRequiredError(`This AI action costs ${cost} credits. You have ${summary.credits} available.`, {
    credits: summary.credits,
    paidCredits: summary.paidCredits,
    dailyFreeCreditsRemaining: summary.dailyFreeCreditsRemaining,
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

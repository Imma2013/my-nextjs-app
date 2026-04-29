create extension if not exists pgcrypto;

create table if not exists public.billing_customers (
  user_id text primary key,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,
  status text not null,
  plan text not null,
  price_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id);
create index if not exists subscriptions_status_idx on public.subscriptions (status);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  action_type text not null,
  idempotency_key text not null,
  resume_id text,
  credits_charged integer not null default 0,
  free_tailor_used boolean not null default false,
  status text not null default 'completed',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists usage_events_idempotency_idx
  on public.usage_events (user_id, action_type, idempotency_key);

create index if not exists usage_events_user_action_idx
  on public.usage_events (user_id, action_type);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  event_type text not null,
  amount integer not null,
  source text not null,
  stripe_event_id text,
  stripe_checkout_session_id text,
  stripe_subscription_id text,
  usage_event_id uuid references public.usage_events(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists credit_ledger_user_id_idx on public.credit_ledger (user_id);
create index if not exists credit_ledger_expires_at_idx on public.credit_ledger (expires_at);

create unique index if not exists credit_ledger_stripe_event_idx
  on public.credit_ledger (stripe_event_id)
  where stripe_event_id is not null;

create unique index if not exists credit_ledger_usage_event_idx
  on public.credit_ledger (usage_event_id)
  where usage_event_id is not null and event_type = 'usage';

create or replace function public.consume_resume_ai_credit(
  p_user_id text,
  p_action_type text,
  p_idempotency_key text,
  p_resume_id text,
  p_cost integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage public.usage_events%rowtype;
  v_usage_id uuid;
  v_available integer;
  v_subscription_available integer;
  v_topup_available integer;
  v_usage_source text;
  v_usage_expires_at timestamptz;
  v_free_tailor_used boolean;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id));

  select *
    into v_usage
    from public.usage_events
   where user_id = p_user_id
     and action_type = p_action_type
     and idempotency_key = p_idempotency_key;

  if found and v_usage.status = 'completed' then
    return jsonb_build_object(
      'usageEventId', v_usage.id,
      'creditsCharged', v_usage.credits_charged,
      'freeTailorUsed', v_usage.free_tailor_used,
      'alreadyRecorded', true
    );
  end if;

  if not found then
    insert into public.usage_events (
      user_id,
      action_type,
      idempotency_key,
      resume_id,
      status
    )
    values (
      p_user_id,
      p_action_type,
      p_idempotency_key,
      p_resume_id,
      'pending'
    )
    returning id into v_usage_id;
  else
    v_usage_id := v_usage.id;
  end if;

  if p_action_type = 'tailor_resume' then
    select exists (
      select 1
        from public.usage_events
       where user_id = p_user_id
         and action_type = 'tailor_resume'
         and free_tailor_used = true
         and status = 'completed'
         and id <> v_usage_id
    )
    into v_free_tailor_used;

    if not v_free_tailor_used then
      update public.usage_events
         set credits_charged = 0,
             free_tailor_used = true,
             status = 'completed',
             completed_at = now()
       where id = v_usage_id;

      return jsonb_build_object(
        'usageEventId', v_usage_id,
        'creditsCharged', 0,
        'freeTailorUsed', true,
        'alreadyRecorded', false
      );
    end if;
  end if;

  select coalesce(sum(amount), 0)
    into v_available
    from public.credit_ledger
   where user_id = p_user_id
     and (expires_at is null or expires_at > now());

  if v_available < p_cost then
    raise exception 'INSUFFICIENT_CREDITS';
  end if;

  select coalesce(sum(amount), 0), min(expires_at)
    into v_subscription_available, v_usage_expires_at
    from public.credit_ledger
   where user_id = p_user_id
     and source in ('stripe_subscription', 'subscription_usage')
     and (expires_at is null or expires_at > now());

  if v_subscription_available >= p_cost then
    v_usage_source := 'subscription_usage';
  else
    select coalesce(sum(amount), 0), min(expires_at)
      into v_topup_available, v_usage_expires_at
      from public.credit_ledger
     where user_id = p_user_id
       and source in ('stripe_topup', 'topup_usage')
       and (expires_at is null or expires_at > now());

    if v_topup_available < p_cost then
      raise exception 'INSUFFICIENT_CREDITS';
    end if;

    v_usage_source := 'topup_usage';
  end if;

  update public.usage_events
     set credits_charged = p_cost,
         free_tailor_used = false,
         status = 'completed',
         completed_at = now()
   where id = v_usage_id;

  insert into public.credit_ledger (
    user_id,
    event_type,
    amount,
    source,
    usage_event_id,
    expires_at,
    metadata
  )
  values (
    p_user_id,
    'usage',
    -p_cost,
    v_usage_source,
    v_usage_id,
    v_usage_expires_at,
    jsonb_build_object('action_type', p_action_type, 'resume_id', p_resume_id)
  )
  on conflict do nothing;

  return jsonb_build_object(
    'usageEventId', v_usage_id,
    'creditsCharged', p_cost,
    'freeTailorUsed', false,
    'alreadyRecorded', false
  );
end;
$$;

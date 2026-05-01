alter table if exists public.usage_events
  alter column credits_charged type numeric(10,2) using credits_charged::numeric,
  add column if not exists billing_source text;

alter table if exists public.credit_ledger
  alter column amount type numeric(10,2) using amount::numeric;

create index if not exists usage_events_free_monthly_idx
  on public.usage_events (user_id, billing_source, completed_at)
  where status = 'completed';

drop function if exists public.consume_resume_ai_credit(text, text, text, text, integer);
drop function if exists public.consume_resume_ai_credit(text, text, text, text, numeric);

create or replace function public.consume_resume_ai_credit(
  p_user_id text,
  p_action_type text,
  p_idempotency_key text,
  p_resume_id text,
  p_cost numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage public.usage_events%rowtype;
  v_usage_id uuid;
  v_active_plan text;
  v_subscription_available numeric(10,2);
  v_topup_available numeric(10,2);
  v_free_monthly_used numeric(10,2);
  v_free_remaining numeric(10,2);
  v_billing_source text;
  v_usage_expires_at timestamptz;
  v_month_start timestamptz := (date_trunc('month', now() at time zone 'utc') at time zone 'utc');
  v_next_month_start timestamptz := ((date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc');
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
      'billingSource', coalesce(v_usage.billing_source, case when v_usage.free_tailor_used then 'free_monthly' else 'actions' end),
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

  select plan
    into v_active_plan
    from public.subscriptions
   where user_id = p_user_id
     and status in ('active', 'trialing')
     and plan in ('pro_monthly', 'pro_plus_monthly')
   order by current_period_end desc nulls last
   limit 1;

  if v_active_plan is null then
    select coalesce(sum(credits_charged), 0)
      into v_free_monthly_used
      from public.usage_events
     where user_id = p_user_id
       and billing_source = 'free_monthly'
       and status = 'completed'
       and completed_at >= v_month_start
       and completed_at < v_next_month_start
       and id <> v_usage_id;

    v_free_remaining := 5 - v_free_monthly_used;

    if v_free_remaining >= p_cost then
      update public.usage_events
         set credits_charged = p_cost,
             free_tailor_used = p_action_type = 'tailor_resume',
             billing_source = 'free_monthly',
             status = 'completed',
             completed_at = now()
       where id = v_usage_id;

      return jsonb_build_object(
        'usageEventId', v_usage_id,
        'creditsCharged', p_cost,
        'billingSource', 'free_monthly',
        'freeTailorUsed', p_action_type = 'tailor_resume',
        'alreadyRecorded', false
      );
    end if;
  end if;

  select coalesce(sum(amount), 0)
    into v_subscription_available
    from public.credit_ledger
   where user_id = p_user_id
     and source in ('stripe_subscription', 'subscription_usage')
     and (expires_at is null or expires_at > now());

  if v_subscription_available >= p_cost then
    v_billing_source := 'subscription_usage';

    select min(expires_at)
      into v_usage_expires_at
      from public.credit_ledger
     where user_id = p_user_id
       and source = 'stripe_subscription'
       and amount > 0
       and (expires_at is null or expires_at > now());
  else
    select coalesce(sum(amount), 0)
      into v_topup_available
      from public.credit_ledger
     where user_id = p_user_id
       and source in ('stripe_topup', 'topup_usage')
       and (expires_at is null or expires_at > now());

    if v_topup_available < p_cost then
      raise exception 'INSUFFICIENT_CREDITS';
    end if;

    v_billing_source := 'topup_usage';

    select min(expires_at)
      into v_usage_expires_at
      from public.credit_ledger
     where user_id = p_user_id
       and source = 'stripe_topup'
       and amount > 0
       and (expires_at is null or expires_at > now());
  end if;

  update public.usage_events
     set credits_charged = p_cost,
         free_tailor_used = false,
         billing_source = v_billing_source,
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
    v_billing_source,
    v_usage_id,
    v_usage_expires_at,
    jsonb_build_object('action_type', p_action_type, 'resume_id', p_resume_id)
  )
  on conflict do nothing;

  return jsonb_build_object(
    'usageEventId', v_usage_id,
    'creditsCharged', p_cost,
    'billingSource', v_billing_source,
    'freeTailorUsed', false,
    'alreadyRecorded', false
  );
end;
$$;

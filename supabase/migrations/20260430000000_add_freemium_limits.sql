create unique index if not exists credit_ledger_starter_credits_idx
  on public.credit_ledger (user_id)
  where metadata @> '{"grant":"starter_credits"}'::jsonb;

-- Duchess Rewards foundation
-- Phase 1A: additive schema only. This file is intended for manual review and manual application.
-- Safety constraints:
-- - No RMS sync writes
-- - No automatic reward issuance
-- - No UI coupling
-- - No changes to existing crms_jobs / crms_job_items schema
--
-- Points convention for MVP:
-- - earn / bonus rows are typically positive
-- - adjust rows may be positive or negative
-- - redeem rows are stored as negative points and negative value_pence
-- - points remain the source of truth; value_pence is an integer snapshot for reporting

begin;

create or replace function public.set_loyalty_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.loyalty_clients (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  client_email text,
  crms_client_id text,
  portal_token text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  tier text not null default 'standard',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  loyalty_client_id uuid not null references public.loyalty_clients(id) on delete cascade,
  crms_job_id uuid,
  crms_ref text,
  event_name text,
  transaction_type text not null check (transaction_type in ('earn', 'bonus', 'redeem', 'adjust', 'expire')),
  status text not null check (status in ('suggested', 'pending', 'available', 'redeemed', 'rejected', 'cancelled')),
  points integer not null,
  value_pence integer not null,
  reason text,
  notes text,
  calculation_snapshot jsonb,
  needs_attention boolean not null default false,
  needs_attention_reason text,
  available_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (transaction_type <> 'redeem' or (points <= 0 and value_pence <= 0))
);

create table if not exists public.loyalty_settings (
  id uuid primary key default gen_random_uuid(),
  point_value_pence numeric not null default 0.5,
  base_reward_percent numeric not null default 3,
  linen_bonus_percent numeric not null default 20,
  chair_bonus_percent numeric not null default 15,
  furniture_bonus_percent numeric not null default 15,
  availability_delay_days integer not null default 3,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.loyalty_clients is
  'Duchess Rewards clients. portal_token is reserved for the future private /rewards/:token experience.';

comment on table public.loyalty_transactions is
  'Duchess Rewards transaction ledger. MVP requires manual approval before any suggested or pending points become available.';

comment on column public.loyalty_transactions.points is
  'Redeem rows are stored as negative points. Points are the source of truth for reward balances.';

comment on column public.loyalty_transactions.value_pence is
  'Integer value snapshot for reporting. Redeem rows are negative.';

comment on table public.loyalty_settings is
  'Duchess Rewards configuration. MVP expects a single active row and a 3 day post-event availability delay.';

drop trigger if exists loyalty_clients_set_updated_at on public.loyalty_clients;
create trigger loyalty_clients_set_updated_at
before update on public.loyalty_clients
for each row execute function public.set_loyalty_updated_at();

drop trigger if exists loyalty_transactions_set_updated_at on public.loyalty_transactions;
create trigger loyalty_transactions_set_updated_at
before update on public.loyalty_transactions
for each row execute function public.set_loyalty_updated_at();

drop trigger if exists loyalty_settings_set_updated_at on public.loyalty_settings;
create trigger loyalty_settings_set_updated_at
before update on public.loyalty_settings
for each row execute function public.set_loyalty_updated_at();

create unique index if not exists loyalty_clients_portal_token_uidx
  on public.loyalty_clients (portal_token);

create index if not exists loyalty_clients_crms_client_id_idx
  on public.loyalty_clients (crms_client_id);

create index if not exists loyalty_transactions_loyalty_client_id_idx
  on public.loyalty_transactions (loyalty_client_id);

create index if not exists loyalty_transactions_crms_job_id_idx
  on public.loyalty_transactions (crms_job_id);

create index if not exists loyalty_transactions_status_idx
  on public.loyalty_transactions (status);

create index if not exists loyalty_transactions_needs_attention_idx
  on public.loyalty_transactions (needs_attention);

create index if not exists loyalty_transactions_created_at_idx
  on public.loyalty_transactions (created_at);

insert into public.loyalty_settings (
  point_value_pence,
  base_reward_percent,
  linen_bonus_percent,
  chair_bonus_percent,
  furniture_bonus_percent,
  availability_delay_days,
  active
)
select
  0.5,
  3,
  20,
  15,
  15,
  3,
  true
where not exists (
  select 1
  from public.loyalty_settings
  where active = true
);

-- RLS is intentionally not enabled in this phase.
-- Access rules depend on the later admin workflow and the future tokenized client portal.

commit;

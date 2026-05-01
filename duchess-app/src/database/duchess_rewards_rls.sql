-- Duchess Rewards — Row Level Security (Phase 1D)
-- =====================================================================
-- MANUAL APPLICATION ONLY. Do not run from the application.
--
-- Prerequisites:
--   1. `src/database/duchess_rewards_foundation.sql` has been reviewed and applied.
--   2. `public.users` exists (Duchess App auth profile table):
--        users.id uuid references auth.users(id) primary key
--        users.role text in ('admin', 'operations', 'driver')
--
-- Security model (MVP):
--   • Anonymous JWT: no access to loyalty tables (no policies targeting anon reads/writes).
--   • authenticated + role operations/driver: NO access unless you add explicit policies later.
--   • authenticated + role admin: full CRUD exercised below (SELECT/INSERT/UPDATE only; no DELETE).
--
-- Service role bypasses RLS in Supabase; do not add “service role” policies here — none exist.
--
-- Future client portal (/rewards/:token) is explicitly OUT OF SCOPE here.
-- Anonymous or token-based lookups must NOT be exposed until designed (RPC or narrow policy).
--
-- Recommended order when going live:
--   1) Apply foundation SQL
--   2) Review this file against production `users` conventions
--   3) Apply this SQL in Dashboard → SQL Editor
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Helpers: reuse the same predicate in every policy (no SECURITY DEFINER).
-- Mirrors app convention: admins are identified via public.users.
-- ---------------------------------------------------------------------
create or replace function public.duchess_rewards_is_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and coalesce(trim(u.role), '') = 'admin'
  );
$$;

comment on function public.duchess_rewards_is_admin() is
  'True when the current auth user row in public.users has role admin; used only for Duchess Rewards RLS policies.';

-- Allow authenticated sessions to invoke the predicate inside RLS evaluations.
grant execute on function public.duchess_rewards_is_admin() to authenticated;

-- Enable RLS
alter table if exists public.loyalty_clients enable row level security;
alter table if exists public.loyalty_transactions enable row level security;
alter table if exists public.loyalty_settings enable row level security;

-- ---------------------------------------------------------------------
-- loyalty_clients — admin only
-- ---------------------------------------------------------------------
drop policy if exists dr_loyalty_clients_admin_select on public.loyalty_clients;
drop policy if exists dr_loyalty_clients_admin_insert on public.loyalty_clients;
drop policy if exists dr_loyalty_clients_admin_update on public.loyalty_clients;

create policy dr_loyalty_clients_admin_select
  on public.loyalty_clients
  for select
  to authenticated
  using (public.duchess_rewards_is_admin());

create policy dr_loyalty_clients_admin_insert
  on public.loyalty_clients
  for insert
  to authenticated
  with check (public.duchess_rewards_is_admin());

create policy dr_loyalty_clients_admin_update
  on public.loyalty_clients
  for update
  to authenticated
  using (public.duchess_rewards_is_admin())
  with check (public.duchess_rewards_is_admin());

-- ---------------------------------------------------------------------
-- loyalty_transactions — admin only (ledger sensitivity)
-- ---------------------------------------------------------------------
drop policy if exists dr_loyalty_transactions_admin_select on public.loyalty_transactions;
drop policy if exists dr_loyalty_transactions_admin_insert on public.loyalty_transactions;
drop policy if exists dr_loyalty_transactions_admin_update on public.loyalty_transactions;

create policy dr_loyalty_transactions_admin_select
  on public.loyalty_transactions
  for select
  to authenticated
  using (public.duchess_rewards_is_admin());

create policy dr_loyalty_transactions_admin_insert
  on public.loyalty_transactions
  for insert
  to authenticated
  with check (public.duchess_rewards_is_admin());

create policy dr_loyalty_transactions_admin_update
  on public.loyalty_transactions
  for update
  to authenticated
  using (public.duchess_rewards_is_admin())
  with check (public.duchess_rewards_is_admin());

-- ---------------------------------------------------------------------
-- loyalty_settings — admin read/write (no deletes in MVP policies)
-- ---------------------------------------------------------------------
drop policy if exists dr_loyalty_settings_admin_select on public.loyalty_settings;
drop policy if exists dr_loyalty_settings_admin_insert on public.loyalty_settings;
drop policy if exists dr_loyalty_settings_admin_update on public.loyalty_settings;

create policy dr_loyalty_settings_admin_select
  on public.loyalty_settings
  for select
  to authenticated
  using (public.duchess_rewards_is_admin());

-- Allow admins to seed additional inactive rows later if workflow requires more than bootstrap insert.
create policy dr_loyalty_settings_admin_insert
  on public.loyalty_settings
  for insert
  to authenticated
  with check (public.duchess_rewards_is_admin());

create policy dr_loyalty_settings_admin_update
  on public.loyalty_settings
  for update
  to authenticated
  using (public.duchess_rewards_is_admin())
  with check (public.duchess_rewards_is_admin());

commit;

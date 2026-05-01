# Duchess Rewards Supabase Apply Checklist

## Purpose

This guide is for manually applying the Duchess Rewards SQL foundation and RLS files in the Supabase SQL Editor.

It is intentionally operational and manual:

- do not run this SQL from the app
- do not paste ad hoc edits into SQL Editor unless they have been reviewed
- do not treat this document as a migration runner

Before starting, make sure your local repo copy includes both SQL files listed below. If `src/database/duchess_rewards_rls.sql` is missing in your local checkout, refresh from `main` before applying anything.

## Files to apply, in exact order

1. `src/database/duchess_rewards_foundation.sql`
2. `src/database/duchess_rewards_rls.sql`

Apply the files in that order only.

## Pre-application checks

Run these in Supabase SQL Editor before applying anything.

### 1. Confirm `public.users` exists

```sql
select table_schema, table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'users';
```

Expected result: one row for `public.users`.

### 2. Confirm `public.users` has the required columns

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'users'
  and column_name in ('id', 'role')
order by column_name;
```

Expected result: `id` and `role` are present.

### 3. Confirm the admin account you plan to use is actually an admin

```sql
select
  u.id,
  au.email,
  u.role,
  u.active
from public.users u
left join auth.users au on au.id = u.id
where u.role = 'admin'
order by au.email nulls last, u.id;
```

Expected result: the account you plan to use for post-apply validation appears with `role = 'admin'`.

### 4. Confirm the loyalty tables do not already exist, or pause and inspect if they do

```sql
select
  to_regclass('public.loyalty_clients') as loyalty_clients,
  to_regclass('public.loyalty_transactions') as loyalty_transactions,
  to_regclass('public.loyalty_settings') as loyalty_settings;
```

Expected result for a first-time apply: all three values are `null`.

If any value is not `null`, stop and inspect before re-running the SQL.

### 5. If loyalty tables already exist, inspect before re-running

Run these only if one or more loyalty tables already exist.

```sql
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('loyalty_clients', 'loyalty_transactions', 'loyalty_settings')
order by tablename, policyname;
```

```sql
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('loyalty_clients', 'loyalty_transactions', 'loyalty_settings')
order by c.relname;
```

If the tables or policies already exist, do not "fix forward" in SQL Editor by hand. Pause and review the current state first.

## Application steps

1. Open the correct Supabase project for Duchess App.
2. Open `SQL Editor`.
3. Open `src/database/duchess_rewards_foundation.sql` from the repo.
4. Paste the full file into a new SQL Editor query.
5. Run the foundation SQL.
6. Confirm the query succeeds before doing anything else.
7. Open `src/database/duchess_rewards_rls.sql` from the repo.
8. Paste the full file into a new SQL Editor query.
9. Run the RLS SQL.
10. Confirm the query succeeds.

Do not:

- run either file from app runtime
- split the files into ad hoc fragments unless reviewed
- edit policy logic in SQL Editor "just to make it work"

## Post-application verification SQL

Run these after both files have been applied.

### 1. Confirm all three loyalty tables exist

```sql
select
  to_regclass('public.loyalty_clients') as loyalty_clients,
  to_regclass('public.loyalty_transactions') as loyalty_transactions,
  to_regclass('public.loyalty_settings') as loyalty_settings;
```

Expected result: all three values are non-null.

### 2. Confirm the default active settings row exists

```sql
select
  id,
  point_value_pence,
  base_reward_percent,
  linen_bonus_percent,
  chair_bonus_percent,
  furniture_bonus_percent,
  availability_delay_days,
  active,
  created_at
from public.loyalty_settings
where active = true
order by created_at;
```

Expected baseline values for the seeded active row:

- `point_value_pence = 0.5`
- `base_reward_percent = 3`
- `linen_bonus_percent = 20`
- `chair_bonus_percent = 15`
- `furniture_bonus_percent = 15`
- `availability_delay_days = 3`
- `active = true`

If you see zero active rows, the foundation apply did not complete as expected. If you see multiple active rows on a first-time setup, pause and review before proceeding.

### 3. Confirm RLS is enabled on all three loyalty tables

```sql
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('loyalty_clients', 'loyalty_transactions', 'loyalty_settings')
order by c.relname;
```

Expected result: `rls_enabled = true` for all three tables.

### 4. Confirm the expected policies exist

```sql
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('loyalty_clients', 'loyalty_transactions', 'loyalty_settings')
order by tablename, policyname;
```

Expected result: admin-only `select`, `insert`, and `update` policies for each table.

### 5. Confirm `public.duchess_rewards_is_admin()` exists

```sql
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'duchess_rewards_is_admin';
```

Expected result: one row for `public.duchess_rewards_is_admin()`.

### 6. Confirm there are no anonymous loyalty policies

```sql
select schemaname, tablename, policyname, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('loyalty_clients', 'loyalty_transactions', 'loyalty_settings')
  and 'anon' = any(roles);
```

Expected result: zero rows.

## Admin shell validation

After SQL has been applied and the relevant app deploy is ready:

1. Log in with an admin account.
2. Open the Duchess Rewards admin page.
3. Confirm there is no missing-table or setup warning.
4. Confirm metrics load as zero values rather than "table unavailable".
5. Confirm the page does not crash.

If the page loads but shows data-unavailable or permission errors, stop and review the SQL verification results before making any manual changes.

## Security validation

Confirm these behaviors after application:

- admin users can access Duchess Rewards data
- operations and driver users should not see the Duchess Rewards sidebar entry
- there is no anonymous portal access yet
- `/rewards/:token` is not built yet and should not be treated as live access
- the frontend should not use Supabase service role credentials

## Rollback / emergency notes

Use rollback only with care.

If no real loyalty data has been entered yet, the safest rollback is a manual, reviewed cleanup in reverse dependency order:

1. `public.loyalty_transactions`
2. `public.loyalty_clients`
3. `public.loyalty_settings`

After that, review whether the helper functions should also be removed:

- `public.duchess_rewards_is_admin()`
- `public.set_loyalty_updated_at()`

Only remove functions if you have confirmed they are not used elsewhere.

If real data already exists:

- do not drop tables casually
- disable UI or operational access if needed
- pause and ask for review before attempting cleanup

Never drop loyalty data as a quick fix.

## Known non-goals

This apply does not introduce:

- automatic points generation
- redemptions
- client portal access
- RMS sync changes
- invoice or payment integration

## Final checklist

- [ ] I confirmed `public.users` exists.
- [ ] I confirmed `public.users` includes `id` and `role`.
- [ ] I confirmed the admin account I will test with has `role = 'admin'`.
- [ ] I confirmed whether the loyalty tables already exist before applying anything.
- [ ] I applied `src/database/duchess_rewards_foundation.sql` first.
- [ ] I confirmed the foundation SQL succeeded.
- [ ] I applied `src/database/duchess_rewards_rls.sql` second.
- [ ] I confirmed the RLS SQL succeeded.
- [ ] I verified all three loyalty tables exist.
- [ ] I verified the default active settings row exists with the expected values.
- [ ] I verified RLS is enabled on all three loyalty tables.
- [ ] I verified `public.duchess_rewards_is_admin()` exists.
- [ ] I verified there are no `anon` policies on the loyalty tables.
- [ ] I verified the admin experience loads without a missing-table warning or crash.
- [ ] I verified no portal or anonymous access has been enabled.

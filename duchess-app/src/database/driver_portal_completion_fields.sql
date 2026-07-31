-- Run in Supabase SQL Editor (manual apply -- this repo has no migration framework).
--
-- Production status:
--   Already applied on 2026-07-31.
--   This file is the repository record of that change and remains safe to re-run.
--
-- Purpose:
--   Completion state for Driver Portal DEL/COL runs on public.orders and
--   public.crms_jobs (delivery_done / collection_done).
--
-- Safety:
--   - Non-destructive and idempotent. Safe to run multiple times.
--   - No row deletion.
--   - Existing NULL values normalize to false (incomplete).
--   - Columns become boolean NOT NULL DEFAULT false.

begin;

alter table public.orders
  add column if not exists delivery_done boolean,
  add column if not exists collection_done boolean;

update public.orders
set delivery_done = false
where delivery_done is null;

update public.orders
set collection_done = false
where collection_done is null;

alter table public.orders
  alter column delivery_done set default false,
  alter column delivery_done set not null,
  alter column collection_done set default false,
  alter column collection_done set not null;

alter table public.crms_jobs
  add column if not exists delivery_done boolean,
  add column if not exists collection_done boolean;

update public.crms_jobs
set delivery_done = false
where delivery_done is null;

update public.crms_jobs
set collection_done = false
where collection_done is null;

alter table public.crms_jobs
  alter column delivery_done set default false,
  alter column delivery_done set not null,
  alter column collection_done set default false,
  alter column collection_done set not null;

commit;

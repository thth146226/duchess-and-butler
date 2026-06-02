-- Run in Supabase SQL Editor (manual apply — this repo has no migration framework).
--
-- Purpose:
--   Let the Schedule hide jobs that were removed / cancelled / are no longer
--   importable from Current RMS, WITHOUT hard-deleting crms_jobs.
--
-- Safety:
--   - Additive only. No row deletion, no destructive column changes.
--   - Preserves notes, evidence, reports, paperwork, labels, driver assignments
--     and full history (rows are only flagged, never removed).
--   - Idempotent: safe to run multiple times.

begin;

-- ── Visibility / RMS-presence columns ───────────────────────────────────────
alter table public.crms_jobs
  add column if not exists hidden_from_schedule boolean not null default false;

alter table public.crms_jobs
  add column if not exists rms_visibility_status text not null default 'active';

-- Last time Current RMS confirmed this job is still an importable Order.
alter table public.crms_jobs
  add column if not exists last_rms_seen_at timestamptz;

-- First time the job stopped being importable (drives any future retention rules).
alter table public.crms_jobs
  add column if not exists rms_missing_since timestamptz;

-- ── Indexes for Schedule filtering / status reporting ───────────────────────
-- Schedule reads filter on hidden_from_schedule = false.
create index if not exists idx_crms_jobs_hidden_from_schedule
  on public.crms_jobs (hidden_from_schedule);

-- Common visible read is "not hidden, ordered by delivery_date".
create index if not exists idx_crms_jobs_visible_delivery_date
  on public.crms_jobs (hidden_from_schedule, delivery_date);

-- Ops/status dashboards group by rms_visibility_status.
create index if not exists idx_crms_jobs_rms_visibility_status
  on public.crms_jobs (rms_visibility_status);

commit;

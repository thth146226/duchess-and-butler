-- Run in Supabase SQL Editor (manual apply — this repo has no migration framework).
--
-- Purpose:
--   Persist operational item-level change events from manual "Refresh from RMS"
--   apply flows, separate from the legacy change_log field-level feed.
--
-- Safety:
--   - Additive only. Does not modify change_log, sync_log, or crms_job_items.
--   - Idempotent: idempotency_key is unique; re-apply skips duplicates.
--   - Enable OPERATIONAL_CHANGE_EVENTS_ENABLED=true only after this script succeeds.

begin;

-- ── operational_change_events ───────────────────────────────────────────────
create table if not exists public.operational_change_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.crms_jobs(id) on delete set null,
  crms_id text,
  job_ref text,
  event_name text,
  change_type text not null,
  severity text not null default 'high',
  source text not null default 'manual_rms_refresh',
  item_key text,
  item_name text,
  item_category text,
  old_value text,
  new_value text,
  old_quantity integer,
  new_quantity integer,
  quantity_delta integer,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  detected_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  whatsapp_posted_at timestamptz,
  whatsapp_posted_by uuid,
  created_at timestamptz not null default now(),

  constraint operational_change_events_change_type_check
    check (change_type in (
      'item_added',
      'item_quantity_changed',
      'item_removed',
      'item_changed'
    )),

  constraint operational_change_events_severity_check
    check (severity in ('critical', 'high', 'medium', 'low')),

  constraint operational_change_events_source_check
    check (source in (
      'manual_rms_refresh',
      'global_sync',
      'backfill',
      'system'
    )),

  constraint operational_change_events_idempotency_key_unique
    unique (idempotency_key)
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
create index if not exists idx_operational_change_events_detected_at
  on public.operational_change_events (detected_at desc);

create index if not exists idx_operational_change_events_job_ref
  on public.operational_change_events (job_ref);

create index if not exists idx_operational_change_events_crms_id
  on public.operational_change_events (crms_id);

create index if not exists idx_operational_change_events_acknowledged_at
  on public.operational_change_events (acknowledged_at);

create index if not exists idx_operational_change_events_change_type
  on public.operational_change_events (change_type);

create index if not exists idx_operational_change_events_severity
  on public.operational_change_events (severity);

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.operational_change_events enable row level security;

-- Authenticated app users can read operational events (future Change Centre UI).
drop policy if exists "Authenticated can view operational change events"
  on public.operational_change_events;

create policy "Authenticated can view operational change events"
  on public.operational_change_events
  for select
  using (auth.role() = 'authenticated');

-- Inserts/updates/deletes are performed with the Supabase service role from
-- server routes only (bypasses RLS). Do not grant authenticated INSERT here.
--
-- NOTE: Postgres RLS cannot restrict UPDATE to specific columns only.
-- Acknowledgement (acknowledged_at / acknowledged_by) from the browser should
-- be implemented via a dedicated server endpoint in a later phase, with
-- service-role validation of allowed fields. Do not add a broad authenticated
-- UPDATE policy until that endpoint exists.

commit;

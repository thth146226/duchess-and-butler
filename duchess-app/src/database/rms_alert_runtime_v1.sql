-- Repository artifact only until separately authorized to apply.
-- Commit 2 Runtime V1 + C2_RUN_01 stable scan-cycle snapshot:
-- rms_alert_runtime_state, rms_alert_scan_cycle_jobs, lease/cursor/scan RPCs,
-- and fenced wrappers around frozen Commit 1 RPCs.
--
-- Does NOT modify Commit 1 foundation objects.
-- Does NOT create pg_cron / pg_net / scheduler wiring.
-- Stage 1 application must not call fenced mutation wrappers.

begin;

-- ---------------------------------------------------------------------------
-- 1) Runtime coordination row (exactly one logical pipeline)
-- ---------------------------------------------------------------------------

create table if not exists public.rms_alert_runtime_state (
  pipeline_key text primary key,
  active_poll_run_id uuid,
  lease_fence_token bigint not null default 0,
  lease_acquired_at timestamptz,
  lease_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  scan_cycle_id uuid,
  scan_anchor_date date,
  scan_window_days integer,
  cursor_sort_date date,
  cursor_job_id uuid,
  cycle_started_at timestamptz,
  cycle_completed_at timestamptz,
  last_run_started_at timestamptz,
  last_run_finished_at timestamptz,
  last_run_status text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rms_alert_runtime_state_pipeline_check
    check (pipeline_key = 'auto_poll_rms'),
  constraint rms_alert_runtime_state_fence_nonneg
    check (lease_fence_token >= 0),
  constraint rms_alert_runtime_state_cursor_tuple_check
    check (
      (cursor_sort_date is null and cursor_job_id is null)
      or (cursor_sort_date is not null and cursor_job_id is not null)
    ),
  constraint rms_alert_runtime_state_lease_consistency_check
    check (
      (
        active_poll_run_id is null
        and lease_acquired_at is null
        and lease_heartbeat_at is null
        and lease_expires_at is null
      )
      or (
        active_poll_run_id is not null
        and lease_acquired_at is not null
        and lease_heartbeat_at is not null
        and lease_expires_at is not null
        and lease_expires_at >= lease_acquired_at
      )
    ),
  constraint rms_alert_runtime_state_scan_consistency_check
    check (
      (
        scan_cycle_id is null
        and scan_anchor_date is null
        and cycle_started_at is null
        and scan_window_days is null
      )
      or (
        scan_cycle_id is not null
        and scan_anchor_date is not null
        and cycle_started_at is not null
        and scan_window_days is not null
        and scan_window_days >= 1
      )
    )
);

alter table public.rms_alert_runtime_state
  add column if not exists scan_window_days integer;

alter table public.rms_alert_runtime_state
  drop constraint if exists rms_alert_runtime_state_scan_consistency_check;

alter table public.rms_alert_runtime_state
  add constraint rms_alert_runtime_state_scan_consistency_check
  check (
    (
      scan_cycle_id is null
      and scan_anchor_date is null
      and cycle_started_at is null
      and scan_window_days is null
    )
    or (
      scan_cycle_id is not null
      and scan_anchor_date is not null
      and cycle_started_at is not null
      and scan_window_days is not null
      and scan_window_days >= 1
    )
  );

-- Runtime row is created lazily by acquire_rms_alert_runtime_lease only.
-- Migration must not seed rms_alert_runtime_state (C2_DB_01).

-- ---------------------------------------------------------------------------
-- 1b) Immutable per-scan-cycle job snapshot (C2_RUN_01)
-- ---------------------------------------------------------------------------

create table if not exists public.rms_alert_scan_cycle_jobs (
  scan_cycle_id uuid not null,
  job_id uuid not null,
  pipeline_key text not null default 'auto_poll_rms',
  crms_id text not null,
  crms_ref text,
  event_name text,
  event_date date,
  delivery_date date,
  collection_date date,
  snapshot_sort_date date not null,
  created_at timestamptz not null default now(),
  primary key (scan_cycle_id, job_id),
  constraint rms_alert_scan_cycle_jobs_pipeline_check
    check (pipeline_key = 'auto_poll_rms')
);

create index if not exists rms_alert_scan_cycle_jobs_cycle_sort_idx
  on public.rms_alert_scan_cycle_jobs (scan_cycle_id, snapshot_sort_date, job_id);

-- ---------------------------------------------------------------------------
-- Internal: active lease ownership check (no boolean-only running flag)
-- ---------------------------------------------------------------------------

create or replace function public.rms_alert_runtime_lease_is_active(
  p_row public.rms_alert_runtime_state,
  p_now timestamptz default now()
)
returns boolean
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select
    p_row.active_poll_run_id is not null
    and p_row.lease_expires_at is not null
    and p_row.lease_expires_at > p_now;
$$;

-- ---------------------------------------------------------------------------
-- Drop superseded RPC signatures (C2_RUN_01)
-- ---------------------------------------------------------------------------

drop function if exists public.acquire_rms_alert_runtime_lease(text, uuid, uuid, date, integer);
drop function if exists public.list_rms_alert_jobs_for_poll_v1(date, integer, date, uuid, integer);

-- ---------------------------------------------------------------------------
-- 2) Acquire lease (+ atomic snapshot build on new cycle)
-- ---------------------------------------------------------------------------

create or replace function public.acquire_rms_alert_runtime_lease(
  p_pipeline_key text,
  p_poll_run_id uuid,
  p_requested_scan_cycle_id uuid,
  p_anchor_date date,
  p_window_days integer,
  p_lease_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.rms_alert_runtime_state%rowtype;
  v_now timestamptz := now();
  v_ttl integer := p_lease_ttl_seconds;
  v_active boolean;
  v_continue boolean;
begin
  if p_pipeline_key is distinct from 'auto_poll_rms'
     or p_poll_run_id is null
     or p_requested_scan_cycle_id is null
     or p_anchor_date is null
     or v_ttl is null
     or v_ttl < 30
     or v_ttl > 900
     or p_window_days is null
     or p_window_days < 1 then
    return jsonb_build_object('status', 'INVALID_INPUT');
  end if;

  insert into public.rms_alert_runtime_state (pipeline_key)
  values (p_pipeline_key)
  on conflict (pipeline_key) do nothing;

  select * into v_row
  from public.rms_alert_runtime_state
  where pipeline_key = p_pipeline_key
  for update;

  if not found then
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'runtime row missing');
  end if;

  v_active := public.rms_alert_runtime_lease_is_active(v_row, v_now);

  if v_active and v_row.active_poll_run_id = p_poll_run_id then
    update public.rms_alert_runtime_state
    set
      lease_heartbeat_at = v_now,
      lease_expires_at = v_now + make_interval(secs => v_ttl),
      last_run_started_at = coalesce(last_run_started_at, v_now),
      updated_at = v_now
    where pipeline_key = p_pipeline_key
    returning * into v_row;

    return jsonb_build_object(
      'status', 'ALREADY_ACQUIRED',
      'poll_run_id', v_row.active_poll_run_id,
      'lease_fence_token', v_row.lease_fence_token,
      'lease_expires_at', v_row.lease_expires_at,
      'scan_cycle_id', v_row.scan_cycle_id,
      'scan_anchor_date', v_row.scan_anchor_date,
      'scan_window_days', v_row.scan_window_days,
      'cursor_sort_date', v_row.cursor_sort_date,
      'cursor_job_id', v_row.cursor_job_id
    );
  end if;

  if v_active and v_row.active_poll_run_id is distinct from p_poll_run_id then
    return jsonb_build_object(
      'status', 'LEASE_BUSY',
      'poll_run_id', v_row.active_poll_run_id,
      'lease_fence_token', v_row.lease_fence_token,
      'lease_expires_at', v_row.lease_expires_at
    );
  end if;

  -- Lease absent or expired: take over with monotonic fence.
  v_continue := (v_row.scan_cycle_id is not null and v_row.cycle_completed_at is null);

  if v_continue then
    -- CONTINUE unfinished cycle: keep scan identity/window/cursor/snapshot.
    update public.rms_alert_runtime_state
    set
      active_poll_run_id = p_poll_run_id,
      lease_fence_token = lease_fence_token + 1,
      lease_acquired_at = v_now,
      lease_heartbeat_at = v_now,
      lease_expires_at = v_now + make_interval(secs => v_ttl),
      last_run_started_at = v_now,
      last_run_finished_at = null,
      last_run_status = null,
      last_error = null,
      updated_at = v_now
    where pipeline_key = p_pipeline_key
    returning * into v_row;
  else
    -- NEW cycle: assign scan fields, then insert immutable snapshot in same txn.
    update public.rms_alert_runtime_state
    set
      active_poll_run_id = p_poll_run_id,
      lease_fence_token = lease_fence_token + 1,
      lease_acquired_at = v_now,
      lease_heartbeat_at = v_now,
      lease_expires_at = v_now + make_interval(secs => v_ttl),
      scan_cycle_id = p_requested_scan_cycle_id,
      scan_anchor_date = p_anchor_date,
      scan_window_days = p_window_days,
      cursor_sort_date = null,
      cursor_job_id = null,
      cycle_started_at = v_now,
      cycle_completed_at = null,
      last_run_started_at = v_now,
      last_run_finished_at = null,
      last_run_status = null,
      last_error = null,
      updated_at = v_now
    where pipeline_key = p_pipeline_key
    returning * into v_row;

    insert into public.rms_alert_scan_cycle_jobs (
      scan_cycle_id,
      job_id,
      pipeline_key,
      crms_id,
      crms_ref,
      event_name,
      event_date,
      delivery_date,
      collection_date,
      snapshot_sort_date
    )
    select
      v_row.scan_cycle_id,
      ranked.job_id,
      'auto_poll_rms',
      ranked.crms_id,
      ranked.crms_ref,
      ranked.event_name,
      ranked.event_date,
      ranked.delivery_date,
      ranked.collection_date,
      ranked.snapshot_sort_date
    from (
      select
        b.job_id,
        b.crms_id,
        b.crms_ref,
        b.event_name,
        b.event_date,
        b.delivery_date,
        b.collection_date,
        (
          select min(d)
          from unnest(array[b.event_date, b.delivery_date, b.collection_date]) as d
          where d is not null
            and d >= p_anchor_date
            and d <= (p_anchor_date + p_window_days)::date
        ) as snapshot_sort_date
      from (
        select
          j.id as job_id,
          j.crms_id::text as crms_id,
          j.crms_ref::text as crms_ref,
          j.event_name::text as event_name,
          nullif(left(coalesce(j.event_date::text, ''), 10), '')::date as event_date,
          nullif(left(coalesce(j.delivery_date::text, ''), 10), '')::date as delivery_date,
          nullif(left(coalesce(j.collection_date::text, ''), 10), '')::date as collection_date
        from public.crms_jobs j
        where j.crms_id is not null
          and btrim(j.crms_id::text) <> ''
          and coalesce(j.hidden_from_schedule, false) = false
          and coalesce(j.status, '') <> 'cancelled'
          and (
            j.rms_visibility_status is null
            or j.rms_visibility_status = 'active'
          )
      ) b
    ) ranked
    where ranked.snapshot_sort_date is not null;
    -- Any SQL error here aborts the whole acquire transaction (lease + snapshot).
  end if;

  return jsonb_build_object(
    'status', 'ACQUIRED',
    'poll_run_id', v_row.active_poll_run_id,
    'lease_fence_token', v_row.lease_fence_token,
    'lease_expires_at', v_row.lease_expires_at,
    'scan_cycle_id', v_row.scan_cycle_id,
    'scan_anchor_date', v_row.scan_anchor_date,
    'scan_window_days', v_row.scan_window_days,
    'cursor_sort_date', v_row.cursor_sort_date,
    'cursor_job_id', v_row.cursor_job_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Renew lease
-- ---------------------------------------------------------------------------

create or replace function public.renew_rms_alert_runtime_lease(
  p_pipeline_key text,
  p_poll_run_id uuid,
  p_lease_fence_token bigint,
  p_lease_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.rms_alert_runtime_state%rowtype;
  v_now timestamptz := now();
  v_ttl integer := p_lease_ttl_seconds;
begin
  if p_pipeline_key is distinct from 'auto_poll_rms'
     or p_poll_run_id is null
     or p_lease_fence_token is null
     or v_ttl is null
     or v_ttl < 30
     or v_ttl > 900 then
    return jsonb_build_object('status', 'INVALID_INPUT');
  end if;

  select * into v_row
  from public.rms_alert_runtime_state
  where pipeline_key = p_pipeline_key
  for update;

  if not found
     or v_row.active_poll_run_id is distinct from p_poll_run_id
     or v_row.lease_fence_token is distinct from p_lease_fence_token
     or not public.rms_alert_runtime_lease_is_active(v_row, v_now) then
    return jsonb_build_object('status', 'LEASE_LOST');
  end if;

  update public.rms_alert_runtime_state
  set
    lease_heartbeat_at = v_now,
    lease_expires_at = v_now + make_interval(secs => v_ttl),
    updated_at = v_now
  where pipeline_key = p_pipeline_key
  returning * into v_row;

  return jsonb_build_object(
    'status', 'RENEWED',
    'poll_run_id', v_row.active_poll_run_id,
    'lease_fence_token', v_row.lease_fence_token,
    'lease_expires_at', v_row.lease_expires_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Advance cursor
-- ---------------------------------------------------------------------------

create or replace function public.advance_rms_alert_runtime_cursor(
  p_pipeline_key text,
  p_poll_run_id uuid,
  p_lease_fence_token bigint,
  p_scan_cycle_id uuid,
  p_cursor_sort_date date,
  p_cursor_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.rms_alert_runtime_state%rowtype;
  v_now timestamptz := now();
  v_expected_sort_date date;
  v_expected_job_id uuid;
begin
  if p_pipeline_key is distinct from 'auto_poll_rms'
     or p_poll_run_id is null
     or p_lease_fence_token is null
     or p_scan_cycle_id is null
     or p_cursor_sort_date is null
     or p_cursor_job_id is null then
    return jsonb_build_object('status', 'INVALID_INPUT');
  end if;

  select * into v_row
  from public.rms_alert_runtime_state
  where pipeline_key = p_pipeline_key
  for update;

  if not found
     or v_row.active_poll_run_id is distinct from p_poll_run_id
     or v_row.lease_fence_token is distinct from p_lease_fence_token
     or not public.rms_alert_runtime_lease_is_active(v_row, v_now) then
    return jsonb_build_object('status', 'LEASE_LOST');
  end if;

  if v_row.scan_cycle_id is distinct from p_scan_cycle_id
     or v_row.cycle_completed_at is not null then
    return jsonb_build_object('status', 'CURSOR_CONFLICT', 'error', 'scan_cycle mismatch');
  end if;

  if v_row.cursor_sort_date is not null
     and v_row.cursor_job_id is not null
     and v_row.cursor_sort_date = p_cursor_sort_date
     and v_row.cursor_job_id = p_cursor_job_id then
    return jsonb_build_object(
      'status', 'ALREADY_ADVANCED',
      'cursor_sort_date', v_row.cursor_sort_date,
      'cursor_job_id', v_row.cursor_job_id
    );
  end if;

  -- Exact next snapshot member only (C2_DB_02): first tuple after persisted cursor.
  select s.snapshot_sort_date, s.job_id
  into v_expected_sort_date, v_expected_job_id
  from public.rms_alert_scan_cycle_jobs s
  where s.scan_cycle_id = p_scan_cycle_id
    and (
      v_row.cursor_sort_date is null
      or v_row.cursor_job_id is null
      or s.snapshot_sort_date > v_row.cursor_sort_date
      or (
        s.snapshot_sort_date = v_row.cursor_sort_date
        and s.job_id > v_row.cursor_job_id
      )
    )
  order by s.snapshot_sort_date asc, s.job_id asc
  limit 1;

  if not found then
    return jsonb_build_object('status', 'CURSOR_EXHAUSTED');
  end if;

  if p_cursor_sort_date is distinct from v_expected_sort_date
     or p_cursor_job_id is distinct from v_expected_job_id then
    return jsonb_build_object('status', 'CURSOR_CONFLICT');
  end if;

  update public.rms_alert_runtime_state
  set
    cursor_sort_date = p_cursor_sort_date,
    cursor_job_id = p_cursor_job_id,
    updated_at = v_now
  where pipeline_key = p_pipeline_key
  returning * into v_row;

  return jsonb_build_object(
    'status', 'ADVANCED',
    'cursor_sort_date', v_row.cursor_sort_date,
    'cursor_job_id', v_row.cursor_job_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Complete scan cycle (delete immutable snapshot, then clear cursor)
-- ---------------------------------------------------------------------------

create or replace function public.complete_rms_alert_runtime_scan_cycle(
  p_pipeline_key text,
  p_poll_run_id uuid,
  p_lease_fence_token bigint,
  p_scan_cycle_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.rms_alert_runtime_state%rowtype;
  v_now timestamptz := now();
  v_remaining boolean;
begin
  if p_pipeline_key is distinct from 'auto_poll_rms'
     or p_poll_run_id is null
     or p_lease_fence_token is null
     or p_scan_cycle_id is null then
    return jsonb_build_object('status', 'INVALID_INPUT');
  end if;

  select * into v_row
  from public.rms_alert_runtime_state
  where pipeline_key = p_pipeline_key
  for update;

  if not found
     or v_row.active_poll_run_id is distinct from p_poll_run_id
     or v_row.lease_fence_token is distinct from p_lease_fence_token
     or not public.rms_alert_runtime_lease_is_active(v_row, v_now) then
    return jsonb_build_object('status', 'LEASE_LOST');
  end if;

  if v_row.scan_cycle_id is distinct from p_scan_cycle_id then
    return jsonb_build_object('status', 'CURSOR_CONFLICT', 'error', 'scan_cycle mismatch');
  end if;

  -- Completion requires snapshot exhaustion (C2_DB_03).
  -- Zero-row snapshot with NULL cursor has no remaining members: allowed.
  select exists (
    select 1
    from public.rms_alert_scan_cycle_jobs s
    where s.scan_cycle_id = p_scan_cycle_id
      and (
        v_row.cursor_sort_date is null
        or v_row.cursor_job_id is null
        or s.snapshot_sort_date > v_row.cursor_sort_date
        or (
          s.snapshot_sort_date = v_row.cursor_sort_date
          and s.job_id > v_row.cursor_job_id
        )
      )
  ) into v_remaining;

  if v_remaining then
    return jsonb_build_object('status', 'CYCLE_NOT_EXHAUSTED');
  end if;

  delete from public.rms_alert_scan_cycle_jobs
  where scan_cycle_id = p_scan_cycle_id;

  update public.rms_alert_runtime_state
  set
    cycle_completed_at = v_now,
    cursor_sort_date = null,
    cursor_job_id = null,
    updated_at = v_now
  where pipeline_key = p_pipeline_key
  returning * into v_row;

  return jsonb_build_object(
    'status', 'CYCLE_COMPLETED',
    'scan_cycle_id', v_row.scan_cycle_id,
    'cycle_completed_at', v_row.cycle_completed_at,
    'cursor_sort_date', null,
    'cursor_job_id', null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Release lease
-- ---------------------------------------------------------------------------

create or replace function public.release_rms_alert_runtime_lease(
  p_pipeline_key text,
  p_poll_run_id uuid,
  p_lease_fence_token bigint,
  p_run_status text,
  p_last_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.rms_alert_runtime_state%rowtype;
  v_now timestamptz := now();
begin
  if p_pipeline_key is distinct from 'auto_poll_rms'
     or p_poll_run_id is null
     or p_lease_fence_token is null
     or p_run_status not in ('completed', 'partial', 'blocked', 'failed') then
    return jsonb_build_object('status', 'INVALID_INPUT');
  end if;

  select * into v_row
  from public.rms_alert_runtime_state
  where pipeline_key = p_pipeline_key
  for update;

  if not found
     or v_row.active_poll_run_id is distinct from p_poll_run_id
     or v_row.lease_fence_token is distinct from p_lease_fence_token then
    return jsonb_build_object('status', 'LEASE_LOST');
  end if;

  update public.rms_alert_runtime_state
  set
    active_poll_run_id = null,
    lease_acquired_at = null,
    lease_heartbeat_at = null,
    lease_expires_at = null,
    last_run_finished_at = v_now,
    last_run_status = p_run_status,
    last_error = p_last_error,
    updated_at = v_now
  where pipeline_key = p_pipeline_key
  returning * into v_row;

  return jsonb_build_object(
    'status', 'RELEASED',
    'lease_fence_token', v_row.lease_fence_token,
    'last_run_status', v_row.last_run_status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Deterministic job selection from immutable snapshot (read-only)
-- ---------------------------------------------------------------------------

create or replace function public.list_rms_alert_jobs_for_poll_v1(
  p_scan_cycle_id uuid,
  p_cursor_sort_date date,
  p_cursor_job_id uuid,
  p_limit integer
)
returns table (
  job_id uuid,
  crms_id text,
  crms_ref text,
  event_name text,
  event_date date,
  delivery_date date,
  collection_date date,
  status text,
  hidden_from_schedule boolean,
  rms_visibility_status text,
  sort_date date
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select greatest(least(coalesce(p_limit, 25), 200), 1) as page_limit
  )
  select
    s.job_id,
    s.crms_id,
    s.crms_ref,
    s.event_name,
    s.event_date,
    s.delivery_date,
    s.collection_date,
    j.status::text as status,
    coalesce(j.hidden_from_schedule, false) as hidden_from_schedule,
    j.rms_visibility_status::text as rms_visibility_status,
    s.snapshot_sort_date as sort_date
  from public.rms_alert_scan_cycle_jobs s
  left join public.crms_jobs j on j.id = s.job_id
  where s.scan_cycle_id = p_scan_cycle_id
    and (
      p_cursor_sort_date is null
      or p_cursor_job_id is null
      or (s.snapshot_sort_date, s.job_id) > (p_cursor_sort_date, p_cursor_job_id)
    )
  order by s.snapshot_sort_date asc, s.job_id asc
  limit (select page_limit from bounds);
$$;

-- ---------------------------------------------------------------------------
-- 8) Fenced Commit 1 wrappers (Stage 1 must not call these from application)
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_rms_alert_job_state_fenced(
  p_pipeline_key text,
  p_poll_run_id uuid,
  p_lease_fence_token bigint,
  p_job_id uuid,
  p_observed_at timestamptz,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.rms_alert_runtime_state%rowtype;
  v_now timestamptz := now();
begin
  -- 1) runtime lock
  select * into v_row
  from public.rms_alert_runtime_state
  where pipeline_key = p_pipeline_key
  for update;

  -- 2) validate lease/fence
  if not found
     or p_pipeline_key is distinct from 'auto_poll_rms'
     or v_row.active_poll_run_id is distinct from p_poll_run_id
     or v_row.lease_fence_token is distinct from p_lease_fence_token
     or not public.rms_alert_runtime_lease_is_active(v_row, v_now) then
    return jsonb_build_object('status', 'LEASE_LOST');
  end if;

  -- 3) call frozen Commit 1 RPC (allow_empty forced false)
  return public.bootstrap_rms_alert_job_state(
    p_job_id,
    p_observed_at,
    p_items,
    false
  );
end;
$$;

create or replace function public.record_rms_alert_item_observation_evidence_fenced(
  p_pipeline_key text,
  p_poll_run_id uuid,
  p_lease_fence_token bigint,
  p_job_id uuid,
  p_crms_item_id text,
  p_is_missing boolean,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.rms_alert_runtime_state%rowtype;
  v_now timestamptz := now();
begin
  select * into v_row
  from public.rms_alert_runtime_state
  where pipeline_key = p_pipeline_key
  for update;

  if not found
     or p_pipeline_key is distinct from 'auto_poll_rms'
     or v_row.active_poll_run_id is distinct from p_poll_run_id
     or v_row.lease_fence_token is distinct from p_lease_fence_token
     or not public.rms_alert_runtime_lease_is_active(v_row, v_now) then
    return jsonb_build_object('status', 'LEASE_LOST');
  end if;

  return public.record_rms_alert_item_observation_evidence(
    p_job_id,
    p_crms_item_id,
    p_poll_run_id,
    p_is_missing,
    p_observed_at
  );
end;
$$;

create or replace function public.commit_rms_alert_item_transition_fenced(
  p_pipeline_key text,
  p_poll_run_id uuid,
  p_lease_fence_token bigint,
  p_job_id uuid,
  p_crms_item_id text,
  p_expected_state_version bigint,
  p_observed_is_present boolean,
  p_observed_item_name text,
  p_observed_item_category text,
  p_observed_quantity integer,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.rms_alert_runtime_state%rowtype;
  v_now timestamptz := now();
begin
  select * into v_row
  from public.rms_alert_runtime_state
  where pipeline_key = p_pipeline_key
  for update;

  if not found
     or p_pipeline_key is distinct from 'auto_poll_rms'
     or v_row.active_poll_run_id is distinct from p_poll_run_id
     or v_row.lease_fence_token is distinct from p_lease_fence_token
     or not public.rms_alert_runtime_lease_is_active(v_row, v_now) then
    return jsonb_build_object('status', 'LEASE_LOST');
  end if;

  return public.commit_rms_alert_item_transition(
    p_job_id,
    p_crms_item_id,
    p_expected_state_version,
    p_observed_is_present,
    p_observed_item_name,
    p_observed_item_category,
    p_observed_quantity,
    p_observed_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) RLS + grants
-- ---------------------------------------------------------------------------

alter table public.rms_alert_runtime_state enable row level security;
alter table public.rms_alert_scan_cycle_jobs enable row level security;

revoke all on table public.rms_alert_runtime_state from public;
revoke all on table public.rms_alert_runtime_state from anon;
revoke all on table public.rms_alert_runtime_state from authenticated;

revoke insert, update, delete on table public.rms_alert_runtime_state from service_role;
grant select on table public.rms_alert_runtime_state to service_role;

revoke all on table public.rms_alert_scan_cycle_jobs from public;
revoke all on table public.rms_alert_scan_cycle_jobs from anon;
revoke all on table public.rms_alert_scan_cycle_jobs from authenticated;

revoke insert, update, delete on table public.rms_alert_scan_cycle_jobs from service_role;
grant select on table public.rms_alert_scan_cycle_jobs to service_role;

-- Internal helper: no direct EXECUTE for PUBLIC/browser/service_role (C2_SEC_01).
revoke all on function public.rms_alert_runtime_lease_is_active(public.rms_alert_runtime_state, timestamptz) from public;
revoke all on function public.rms_alert_runtime_lease_is_active(public.rms_alert_runtime_state, timestamptz) from anon;
revoke all on function public.rms_alert_runtime_lease_is_active(public.rms_alert_runtime_state, timestamptz) from authenticated;
revoke all on function public.rms_alert_runtime_lease_is_active(public.rms_alert_runtime_state, timestamptz) from service_role;

revoke all on function public.acquire_rms_alert_runtime_lease(text, uuid, uuid, date, integer, integer) from public;
revoke all on function public.acquire_rms_alert_runtime_lease(text, uuid, uuid, date, integer, integer) from anon;
revoke all on function public.acquire_rms_alert_runtime_lease(text, uuid, uuid, date, integer, integer) from authenticated;
grant execute on function public.acquire_rms_alert_runtime_lease(text, uuid, uuid, date, integer, integer) to service_role;

revoke all on function public.renew_rms_alert_runtime_lease(text, uuid, bigint, integer) from public;
revoke all on function public.renew_rms_alert_runtime_lease(text, uuid, bigint, integer) from anon;
revoke all on function public.renew_rms_alert_runtime_lease(text, uuid, bigint, integer) from authenticated;
grant execute on function public.renew_rms_alert_runtime_lease(text, uuid, bigint, integer) to service_role;

revoke all on function public.advance_rms_alert_runtime_cursor(text, uuid, bigint, uuid, date, uuid) from public;
revoke all on function public.advance_rms_alert_runtime_cursor(text, uuid, bigint, uuid, date, uuid) from anon;
revoke all on function public.advance_rms_alert_runtime_cursor(text, uuid, bigint, uuid, date, uuid) from authenticated;
grant execute on function public.advance_rms_alert_runtime_cursor(text, uuid, bigint, uuid, date, uuid) to service_role;

revoke all on function public.complete_rms_alert_runtime_scan_cycle(text, uuid, bigint, uuid) from public;
revoke all on function public.complete_rms_alert_runtime_scan_cycle(text, uuid, bigint, uuid) from anon;
revoke all on function public.complete_rms_alert_runtime_scan_cycle(text, uuid, bigint, uuid) from authenticated;
grant execute on function public.complete_rms_alert_runtime_scan_cycle(text, uuid, bigint, uuid) to service_role;

revoke all on function public.release_rms_alert_runtime_lease(text, uuid, bigint, text, text) from public;
revoke all on function public.release_rms_alert_runtime_lease(text, uuid, bigint, text, text) from anon;
revoke all on function public.release_rms_alert_runtime_lease(text, uuid, bigint, text, text) from authenticated;
grant execute on function public.release_rms_alert_runtime_lease(text, uuid, bigint, text, text) to service_role;

revoke all on function public.list_rms_alert_jobs_for_poll_v1(uuid, date, uuid, integer) from public;
revoke all on function public.list_rms_alert_jobs_for_poll_v1(uuid, date, uuid, integer) from anon;
revoke all on function public.list_rms_alert_jobs_for_poll_v1(uuid, date, uuid, integer) from authenticated;
grant execute on function public.list_rms_alert_jobs_for_poll_v1(uuid, date, uuid, integer) to service_role;

revoke all on function public.bootstrap_rms_alert_job_state_fenced(text, uuid, bigint, uuid, timestamptz, jsonb) from public;
revoke all on function public.bootstrap_rms_alert_job_state_fenced(text, uuid, bigint, uuid, timestamptz, jsonb) from anon;
revoke all on function public.bootstrap_rms_alert_job_state_fenced(text, uuid, bigint, uuid, timestamptz, jsonb) from authenticated;
grant execute on function public.bootstrap_rms_alert_job_state_fenced(text, uuid, bigint, uuid, timestamptz, jsonb) to service_role;

revoke all on function public.record_rms_alert_item_observation_evidence_fenced(text, uuid, bigint, uuid, text, boolean, timestamptz) from public;
revoke all on function public.record_rms_alert_item_observation_evidence_fenced(text, uuid, bigint, uuid, text, boolean, timestamptz) from anon;
revoke all on function public.record_rms_alert_item_observation_evidence_fenced(text, uuid, bigint, uuid, text, boolean, timestamptz) from authenticated;
grant execute on function public.record_rms_alert_item_observation_evidence_fenced(text, uuid, bigint, uuid, text, boolean, timestamptz) to service_role;

revoke all on function public.commit_rms_alert_item_transition_fenced(text, uuid, bigint, uuid, text, bigint, boolean, text, text, integer, timestamptz) from public;
revoke all on function public.commit_rms_alert_item_transition_fenced(text, uuid, bigint, uuid, text, bigint, boolean, text, text, integer, timestamptz) from anon;
revoke all on function public.commit_rms_alert_item_transition_fenced(text, uuid, bigint, uuid, text, bigint, boolean, text, text, integer, timestamptz) from authenticated;
grant execute on function public.commit_rms_alert_item_transition_fenced(text, uuid, bigint, uuid, text, bigint, boolean, text, text, integer, timestamptz) to service_role;

commit;

-- Run in Supabase SQL Editor (manual apply -- this repo has no migration framework).
--
-- Purpose:
--   Alert Pipeline V1 foundation: isolated alert baseline tables, fingerprint,
--   bootstrap / observation-evidence / transition RPCs, and auto_poll_rms source.
--
-- Safety:
--   - Additive / non-destructive toward existing operational data.
--   - Does NOT modify crms_job_items, change_log, or Full Sync behavior.
--   - Does NOT create rms_alert_runtime_state (deferred to Commit 2).
--   - Does NOT activate Auto Poll, Telegram, or scheduler.
--   - Repository artifact only until separately authorized to apply.
--
-- Ownership:
--   Alert Pipeline only. Forbidden writers: /api/sync, Manual Refresh,
--   frontend, Driver Portal, Schedule, Paperwork.

begin;

-- ---------------------------------------------------------------------------
-- 1) Source allow-list: add auto_poll_rms (do not rewrite historical rows)
-- ---------------------------------------------------------------------------
alter table public.operational_change_events
  drop constraint if exists operational_change_events_source_check;

alter table public.operational_change_events
  add constraint operational_change_events_source_check
  check (source in (
    'manual_rms_refresh',
    'global_sync',
    'backfill',
    'system',
    'auto_poll_rms'
  ));

-- ---------------------------------------------------------------------------
-- 2) Job-level alert observation state
-- ---------------------------------------------------------------------------
create table if not exists public.rms_alert_job_state (
  job_id uuid primary key
    references public.crms_jobs(id) on delete restrict,
  crms_id text not null,
  initialized_at timestamptz,
  last_observed_at timestamptz,
  last_successful_poll_at timestamptz,
  last_poll_status text,
  last_warning text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rms_alert_job_state_crms_id_nonempty_check
    check (btrim(crms_id) <> ''),

  constraint rms_alert_job_state_last_poll_status_check
    check (
      last_poll_status is null
      or last_poll_status in (
        'initialized',
        'ok',
        'blocked_zero_items',
        'observation_suspect',
        'partial',
        'error'
      )
    )
);

-- ---------------------------------------------------------------------------
-- 3) Item-level alert baseline (+ removal-candidate evidence)
-- ---------------------------------------------------------------------------
create table if not exists public.rms_alert_item_state (
  job_id uuid not null
    references public.crms_jobs(id) on delete restrict,
  crms_id text not null,
  crms_item_id text not null,

  item_name text,
  item_category text,
  quantity integer not null,

  is_present boolean not null,
  state_version bigint not null,

  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,

  missing_observation_count integer not null default 0,
  missing_first_observed_at timestamptz,
  missing_last_observed_at timestamptz,
  missing_first_poll_run_id uuid,
  missing_last_poll_run_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (job_id, crms_item_id),

  constraint rms_alert_item_state_crms_id_nonempty_check
    check (btrim(crms_id) <> ''),
  constraint rms_alert_item_state_crms_item_id_nonempty_check
    check (btrim(crms_item_id) <> ''),
  constraint rms_alert_item_state_quantity_nonneg_check
    check (quantity >= 0),
  constraint rms_alert_item_state_version_positive_check
    check (state_version >= 1),
  constraint rms_alert_item_state_missing_count_range_check
    check (missing_observation_count between 0 and 2),
  constraint rms_alert_item_state_missing_evidence_consistency_check
    check (
      (
        missing_observation_count = 0
        and missing_first_observed_at is null
        and missing_last_observed_at is null
        and missing_first_poll_run_id is null
        and missing_last_poll_run_id is null
      )
      or (
        missing_observation_count >= 1
        and missing_first_observed_at is not null
        and missing_last_observed_at is not null
        and missing_first_poll_run_id is not null
        and missing_last_poll_run_id is not null
      )
    )
);

create index if not exists idx_rms_alert_item_state_job_present
  on public.rms_alert_item_state (job_id, is_present);

-- ---------------------------------------------------------------------------
-- 4) Canonical fingerprint V1 (DB is sole serializer)
-- ---------------------------------------------------------------------------
create or replace function public.rms_alert_state_fingerprint_v1(
  p_is_present boolean,
  p_quantity integer,
  p_item_name text,
  p_item_category text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_cat text;
  v_qty text;
begin
  if coalesce(p_is_present, false) then
    v_name := btrim(coalesce(p_item_name, ''));
    v_cat := btrim(coalesce(p_item_category, ''));
    v_qty := coalesce(p_quantity, 0)::text;
    return format(
      'v1|p=1|q=%s:%s|n=%s:%s|c=%s:%s',
      char_length(v_qty), v_qty,
      char_length(v_name), v_name,
      char_length(v_cat), v_cat
    );
  end if;

  -- Absent: ignore retained tombstone description.
  return 'v1|p=0|q=0:|n=0:|c=0:';
end;
$$;

revoke all on function public.rms_alert_state_fingerprint_v1(boolean, integer, text, text) from public;
revoke all on function public.rms_alert_state_fingerprint_v1(boolean, integer, text, text) from anon;
revoke all on function public.rms_alert_state_fingerprint_v1(boolean, integer, text, text) from authenticated;
grant execute on function public.rms_alert_state_fingerprint_v1(boolean, integer, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5) Bootstrap RPC
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_rms_alert_job_state(
  p_job_id uuid,
  p_observed_at timestamptz,
  p_items jsonb,
  p_allow_empty boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.crms_jobs%rowtype;
  v_job_state public.rms_alert_job_state%rowtype;
  v_observed_at timestamptz := coalesce(p_observed_at, now());
  v_item jsonb;
  v_crms_item_id text;
  v_qty integer;
  v_ids text[] := array[]::text[];
  v_count integer := 0;
begin
  if p_job_id is null then
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'job_id is required');
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'p_items must be a JSON array');
  end if;

  select * into v_job
  from public.crms_jobs
  where id = p_job_id;

  if not found then
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'job not found');
  end if;

  if v_job.crms_id is null or btrim(v_job.crms_id::text) = '' then
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'job crms_id missing');
  end if;

  -- Validate items before any write.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'each item must be an object');
    end if;

    v_crms_item_id := btrim(coalesce(v_item->>'crms_item_id', ''));
    if v_crms_item_id = '' then
      return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'crms_item_id required');
    end if;

    if v_crms_item_id = any (v_ids) then
      return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'duplicate crms_item_id');
    end if;
    v_ids := array_append(v_ids, v_crms_item_id);

    begin
      v_qty := (v_item->>'quantity')::integer;
    exception when others then
      return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'quantity must be integer');
    end;

    if v_qty is null or v_qty < 0 then
      return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'quantity must be >= 0');
    end if;

    v_count := v_count + 1;
  end loop;

  if v_count = 0 and coalesce(p_allow_empty, false) is not true then
    return jsonb_build_object(
      'status', 'EMPTY_OBSERVATION_BLOCKED',
      'error', 'empty observation refused unless p_allow_empty=true'
    );
  end if;

  -- Ownership / concurrency boundary: unique job_id row.
  insert into public.rms_alert_job_state as js (
    job_id,
    crms_id,
    initialized_at,
    last_observed_at,
    last_poll_status,
    created_at,
    updated_at
  ) values (
    p_job_id,
    btrim(v_job.crms_id::text),
    null,
    v_observed_at,
    null,
    now(),
    now()
  )
  on conflict (job_id) do nothing;

  select * into v_job_state
  from public.rms_alert_job_state
  where job_id = p_job_id
  for update;

  if v_job_state.initialized_at is not null then
    return jsonb_build_object(
      'status', 'ALREADY_INITIALIZED',
      'job_id', p_job_id,
      'initialized_at', v_job_state.initialized_at
    );
  end if;

  -- Fail closed if a prior partial attempt left item rows without initialization.
  if exists (
    select 1 from public.rms_alert_item_state i where i.job_id = p_job_id
  ) then
    raise exception 'rms_alert bootstrap inconsistent: item rows exist before initialized_at';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.rms_alert_item_state (
      job_id,
      crms_id,
      crms_item_id,
      item_name,
      item_category,
      quantity,
      is_present,
      state_version,
      first_observed_at,
      last_observed_at,
      missing_observation_count,
      created_at,
      updated_at
    ) values (
      p_job_id,
      btrim(v_job.crms_id::text),
      btrim(v_item->>'crms_item_id'),
      nullif(btrim(coalesce(v_item->>'item_name', '')), ''),
      nullif(btrim(coalesce(v_item->>'item_category', '')), ''),
      (v_item->>'quantity')::integer,
      true,
      1,
      v_observed_at,
      v_observed_at,
      0,
      now(),
      now()
    );
  end loop;

  update public.rms_alert_job_state
  set
    initialized_at = v_observed_at,
    last_observed_at = v_observed_at,
    last_successful_poll_at = v_observed_at,
    last_poll_status = 'initialized',
    last_warning = null,
    updated_at = now()
  where job_id = p_job_id;

  return jsonb_build_object(
    'status', 'INITIALIZED',
    'job_id', p_job_id,
    'crms_id', btrim(v_job.crms_id::text),
    'item_count', v_count,
    'initialized_at', v_observed_at,
    'events_created', 0
  );
end;
$$;

revoke all on function public.bootstrap_rms_alert_job_state(uuid, timestamptz, jsonb, boolean) from public;
revoke all on function public.bootstrap_rms_alert_job_state(uuid, timestamptz, jsonb, boolean) from anon;
revoke all on function public.bootstrap_rms_alert_job_state(uuid, timestamptz, jsonb, boolean) from authenticated;
grant execute on function public.bootstrap_rms_alert_job_state(uuid, timestamptz, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 6) Observation evidence RPC (removal candidates; no generation bump)
-- ---------------------------------------------------------------------------
create or replace function public.record_rms_alert_item_observation_evidence(
  p_job_id uuid,
  p_crms_item_id text,
  p_poll_run_id uuid,
  p_is_missing boolean,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_state public.rms_alert_job_state%rowtype;
  v_item public.rms_alert_item_state%rowtype;
  v_observed_at timestamptz := coalesce(p_observed_at, now());
  v_item_id text := btrim(coalesce(p_crms_item_id, ''));
  v_confirmation_ready boolean := false;
begin
  if p_job_id is null or v_item_id = '' or p_poll_run_id is null or p_is_missing is null then
    return jsonb_build_object('status', 'INVALID_INPUT');
  end if;

  select * into v_job_state
  from public.rms_alert_job_state
  where job_id = p_job_id
  for update;

  if not found or v_job_state.initialized_at is null then
    return jsonb_build_object('status', 'BASELINE_NOT_INITIALIZED');
  end if;

  select * into v_item
  from public.rms_alert_item_state
  where job_id = p_job_id
    and crms_item_id = v_item_id
  for update;

  if not found then
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'item baseline not found');
  end if;

  if p_is_missing is false then
    update public.rms_alert_item_state
    set
      missing_observation_count = 0,
      missing_first_observed_at = null,
      missing_last_observed_at = null,
      missing_first_poll_run_id = null,
      missing_last_poll_run_id = null,
      last_observed_at = v_observed_at,
      updated_at = now()
    where job_id = p_job_id
      and crms_item_id = v_item_id;

    return jsonb_build_object(
      'status', 'CANDIDATE_CLEARED',
      'missing_observation_count', 0,
      'confirmation_ready', false,
      'state_version', v_item.state_version
    );
  end if;

  -- Missing observation only applies to currently present committed items.
  if v_item.is_present is not true then
    return jsonb_build_object(
      'status', 'NO_CHANGE',
      'missing_observation_count', v_item.missing_observation_count,
      'confirmation_ready', false,
      'state_version', v_item.state_version
    );
  end if;

  if v_item.missing_observation_count = 0 then
    update public.rms_alert_item_state
    set
      missing_observation_count = 1,
      missing_first_observed_at = v_observed_at,
      missing_last_observed_at = v_observed_at,
      missing_first_poll_run_id = p_poll_run_id,
      missing_last_poll_run_id = p_poll_run_id,
      updated_at = now()
    where job_id = p_job_id
      and crms_item_id = v_item_id;

    return jsonb_build_object(
      'status', 'REMOVAL_CANDIDATE',
      'missing_observation_count', 1,
      'confirmation_ready', false,
      'state_version', v_item.state_version
    );
  end if;

  -- Same poll_run_id must not increment.
  if v_item.missing_last_poll_run_id = p_poll_run_id then
    update public.rms_alert_item_state
    set
      missing_last_observed_at = v_observed_at,
      updated_at = now()
    where job_id = p_job_id
      and crms_item_id = v_item_id;

    return jsonb_build_object(
      'status', 'REMOVAL_CANDIDATE',
      'missing_observation_count', v_item.missing_observation_count,
      'confirmation_ready', v_item.missing_observation_count >= 2,
      'state_version', v_item.state_version
    );
  end if;

  -- Distinct poll run: advance to 2 (cap).
  update public.rms_alert_item_state
  set
    missing_observation_count = least(2, v_item.missing_observation_count + 1),
    missing_last_observed_at = v_observed_at,
    missing_last_poll_run_id = p_poll_run_id,
    updated_at = now()
  where job_id = p_job_id
    and crms_item_id = v_item_id
  returning missing_observation_count into v_item.missing_observation_count;

  v_confirmation_ready := v_item.missing_observation_count >= 2;

  return jsonb_build_object(
    'status', 'REMOVAL_CANDIDATE',
    'missing_observation_count', v_item.missing_observation_count,
    'confirmation_ready', v_confirmation_ready,
    'state_version', v_item.state_version
  );
end;
$$;

revoke all on function public.record_rms_alert_item_observation_evidence(uuid, text, uuid, boolean, timestamptz) from public;
revoke all on function public.record_rms_alert_item_observation_evidence(uuid, text, uuid, boolean, timestamptz) from anon;
revoke all on function public.record_rms_alert_item_observation_evidence(uuid, text, uuid, boolean, timestamptz) from authenticated;
grant execute on function public.record_rms_alert_item_observation_evidence(uuid, text, uuid, boolean, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 7) Atomic transition RPC
-- ---------------------------------------------------------------------------
create or replace function public.commit_rms_alert_item_transition(
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
  v_job public.crms_jobs%rowtype;
  v_job_state public.rms_alert_job_state%rowtype;
  v_item public.rms_alert_item_state%rowtype;
  v_item_found boolean := false;
  v_item_id text := btrim(coalesce(p_crms_item_id, ''));
  v_observed_at timestamptz := coalesce(p_observed_at, now());
  v_obs_name text := btrim(coalesce(p_observed_item_name, ''));
  v_obs_cat text := btrim(coalesce(p_observed_item_category, ''));
  v_obs_qty integer := coalesce(p_observed_quantity, 0);
  v_fp_before text;
  v_fp_after text;
  v_version_before bigint;
  v_version_after bigint;
  v_change_type text;
  v_severity text;
  v_idempotency_key text;
  v_existing public.operational_change_events%rowtype;
  v_event_id uuid;
  v_old_name text;
  v_old_cat text;
  v_old_qty integer;
  v_old_present boolean;
  v_new_value text;
  v_old_value text;
  v_qty_delta integer;
begin
  if p_job_id is null or v_item_id = '' or p_expected_state_version is null or p_observed_is_present is null then
    return jsonb_build_object('status', 'INVALID_INPUT');
  end if;

  if p_observed_is_present and (p_observed_quantity is null or p_observed_quantity < 0) then
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'present quantity must be >= 0');
  end if;

  select * into v_job from public.crms_jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'job not found');
  end if;

  -- 1-2) Job lock first (serialization anchor for new items).
  select * into v_job_state
  from public.rms_alert_job_state
  where job_id = p_job_id
  for update;

  if not found or v_job_state.initialized_at is null then
    return jsonb_build_object('status', 'BASELINE_NOT_INITIALIZED');
  end if;

  -- 3) Item lock when present.
  select * into v_item
  from public.rms_alert_item_state
  where job_id = p_job_id
    and crms_item_id = v_item_id
  for update;

  v_item_found := found;

  if not v_item_found then
    if p_expected_state_version <> 0 then
      return jsonb_build_object('status', 'VERSION_CONFLICT');
    end if;
    if p_observed_is_present is not true then
      return jsonb_build_object('status', 'NO_CHANGE');
    end if;

    v_version_before := 0;
    v_fp_before := public.rms_alert_state_fingerprint_v1(false, null, null, null);
    v_old_present := false;
    v_old_name := '';
    v_old_cat := '';
    v_old_qty := null;
  else
    v_version_before := v_item.state_version;
    v_fp_before := public.rms_alert_state_fingerprint_v1(
      v_item.is_present,
      v_item.quantity,
      v_item.item_name,
      v_item.item_category
    );
    v_old_present := v_item.is_present;
    v_old_name := coalesce(v_item.item_name, '');
    v_old_cat := coalesce(v_item.item_category, '');
    v_old_qty := v_item.quantity;
  end if;

  v_fp_after := public.rms_alert_state_fingerprint_v1(
    p_observed_is_present,
    case when p_observed_is_present then v_obs_qty else null end,
    case when p_observed_is_present then v_obs_name else '' end,
    case when p_observed_is_present then v_obs_cat else '' end
  );

  v_idempotency_key := format(
    'auto_poll_rms:%s:%s:v%s',
    p_job_id::text,
    v_item_id,
    p_expected_state_version::text
  );

  -- 5-6) Existing transition slot.
  select * into v_existing
  from public.operational_change_events
  where idempotency_key = v_idempotency_key;

  if found then
    if coalesce(v_existing.payload->>'state_fingerprint_after', '') = v_fp_after then
      return jsonb_build_object(
        'status', 'ALREADY_COMMITTED',
        'event_id', v_existing.id,
        'idempotency_key', v_idempotency_key,
        'change_type', v_existing.change_type,
        'baseline_version_before', coalesce(
          (v_existing.payload->>'baseline_version_before')::bigint,
          p_expected_state_version
        ),
        'baseline_version_after', coalesce(
          (v_existing.payload->>'baseline_version_after')::bigint,
          p_expected_state_version + 1
        ),
        'state_fingerprint_before', coalesce(
          v_existing.payload->>'state_fingerprint_before',
          ''
        ),
        'state_fingerprint_after', coalesce(
          v_existing.payload->>'state_fingerprint_after',
          v_fp_after
        )
      );
    end if;

    return jsonb_build_object(
      'status', 'OBSERVATION_CONFLICT',
      'event_id', v_existing.id,
      'idempotency_key', v_idempotency_key,
      'baseline_version_before', coalesce(
        (v_existing.payload->>'baseline_version_before')::bigint,
        p_expected_state_version
      ),
      'state_fingerprint_before', coalesce(
        v_existing.payload->>'state_fingerprint_before',
        ''
      ),
      'state_fingerprint_after', v_fp_after
    );
  end if;

  -- 7) Version verification for existing rows.
  if v_item_found and v_item.state_version <> p_expected_state_version then
    return jsonb_build_object(
      'status', 'VERSION_CONFLICT',
      'baseline_version_before', v_item.state_version,
      'expected_state_version', p_expected_state_version
    );
  end if;

  if not v_item_found and p_expected_state_version <> 0 then
    return jsonb_build_object('status', 'VERSION_CONFLICT');
  end if;

  if v_fp_before = v_fp_after then
    return jsonb_build_object(
      'status', 'NO_CHANGE',
      'baseline_version_before', v_version_before,
      'baseline_version_after', v_version_before,
      'state_fingerprint_before', v_fp_before,
      'state_fingerprint_after', v_fp_after
    );
  end if;

  -- 8) Derive transition (fail closed for unconfirmed removals).
  if v_item_found and v_old_present is true and p_observed_is_present is false then
    if coalesce(v_item.missing_observation_count, 0) < 2 then
      return jsonb_build_object(
        'status', 'INVALID_INPUT',
        'error', 'confirmed removal requires missing_observation_count >= 2'
      );
    end if;
    v_change_type := 'item_removed';
  elsif (not v_item_found or v_old_present is false) and p_observed_is_present is true then
    v_change_type := 'item_added';
  elsif v_old_present is true and p_observed_is_present is true and coalesce(v_old_qty, 0) <> v_obs_qty then
    v_change_type := 'item_quantity_changed';
  elsif v_old_present is true and p_observed_is_present is true then
    v_change_type := 'item_changed';
  else
    return jsonb_build_object('status', 'INVALID_INPUT', 'error', 'unsupported transition');
  end if;

  v_severity := case
    when v_change_type = 'item_changed' then 'medium'
    else 'high'
  end;

  v_version_after := v_version_before + 1;

  if v_change_type = 'item_added' then
    v_old_value := null;
    v_new_value := case
      when v_obs_name <> '' then v_obs_name || ' x' || v_obs_qty::text
      else v_obs_qty::text
    end;
    v_qty_delta := v_obs_qty;
  elsif v_change_type = 'item_removed' then
    v_old_value := case
      when btrim(coalesce(v_old_name, '')) <> '' then btrim(v_old_name) || ' x' || coalesce(v_old_qty, 0)::text
      else coalesce(v_old_qty, 0)::text
    end;
    v_new_value := null;
    v_qty_delta := -coalesce(v_old_qty, 0);
  elsif v_change_type = 'item_quantity_changed' then
    v_old_value := coalesce(v_old_qty, 0)::text;
    v_new_value := v_obs_qty::text;
    v_qty_delta := v_obs_qty - coalesce(v_old_qty, 0);
  else
    v_old_value := nullif(array_to_string(array[
      nullif(btrim(coalesce(v_old_name, '')), ''),
      nullif(btrim(coalesce(v_old_cat, '')), '')
    ], ' / '), '');
    v_new_value := nullif(array_to_string(array[
      nullif(v_obs_name, ''),
      nullif(v_obs_cat, '')
    ], ' / '), '');
    v_qty_delta := 0;
  end if;

  -- 9) Persist durable event.
  insert into public.operational_change_events (
    job_id,
    crms_id,
    job_ref,
    event_name,
    change_type,
    severity,
    source,
    item_key,
    item_name,
    item_category,
    old_value,
    new_value,
    old_quantity,
    new_quantity,
    quantity_delta,
    payload,
    idempotency_key,
    detected_at
  ) values (
    p_job_id,
    btrim(v_job.crms_id::text),
    v_job.crms_ref,
    v_job.event_name,
    v_change_type,
    v_severity,
    'auto_poll_rms',
    v_item_id,
    case when p_observed_is_present then nullif(v_obs_name, '') else nullif(btrim(coalesce(v_old_name, '')), '') end,
    case when p_observed_is_present then nullif(v_obs_cat, '') else nullif(btrim(coalesce(v_old_cat, '')), '') end,
    v_old_value,
    v_new_value,
    case when v_change_type = 'item_added' then null else v_old_qty end,
    case when v_change_type = 'item_removed' then null else v_obs_qty end,
    v_qty_delta,
    jsonb_build_object(
      'crms_item_id', v_item_id,
      'old_item_name', v_old_name,
      'new_item_name', case when p_observed_is_present then v_obs_name else '' end,
      'old_category', v_old_cat,
      'new_category', case when p_observed_is_present then v_obs_cat else '' end,
      'baseline_version_before', v_version_before,
      'baseline_version_after', v_version_after,
      'state_fingerprint_before', v_fp_before,
      'state_fingerprint_after', v_fp_after,
      'observed_at', v_observed_at
    ),
    v_idempotency_key,
    v_observed_at
  )
  returning id into v_event_id;

  -- 10-11) Advance baseline exactly once.
  if not v_item_found then
    insert into public.rms_alert_item_state (
      job_id,
      crms_id,
      crms_item_id,
      item_name,
      item_category,
      quantity,
      is_present,
      state_version,
      first_observed_at,
      last_observed_at,
      missing_observation_count,
      created_at,
      updated_at
    ) values (
      p_job_id,
      btrim(v_job.crms_id::text),
      v_item_id,
      nullif(v_obs_name, ''),
      nullif(v_obs_cat, ''),
      v_obs_qty,
      true,
      v_version_after,
      v_observed_at,
      v_observed_at,
      0,
      now(),
      now()
    );
  elsif v_change_type = 'item_removed' then
    update public.rms_alert_item_state
    set
      is_present = false,
      state_version = v_version_after,
      last_observed_at = v_observed_at,
      missing_observation_count = 0,
      missing_first_observed_at = null,
      missing_last_observed_at = null,
      missing_first_poll_run_id = null,
      missing_last_poll_run_id = null,
      updated_at = now()
    where job_id = p_job_id
      and crms_item_id = v_item_id;
  else
    update public.rms_alert_item_state
    set
      is_present = true,
      item_name = nullif(v_obs_name, ''),
      item_category = nullif(v_obs_cat, ''),
      quantity = v_obs_qty,
      state_version = v_version_after,
      last_observed_at = v_observed_at,
      missing_observation_count = 0,
      missing_first_observed_at = null,
      missing_last_observed_at = null,
      missing_first_poll_run_id = null,
      missing_last_poll_run_id = null,
      updated_at = now()
    where job_id = p_job_id
      and crms_item_id = v_item_id;
  end if;

  update public.rms_alert_job_state
  set
    last_observed_at = v_observed_at,
    last_successful_poll_at = v_observed_at,
    last_poll_status = 'ok',
    updated_at = now()
  where job_id = p_job_id;

  return jsonb_build_object(
    'status', 'COMMITTED',
    'event_id', v_event_id,
    'idempotency_key', v_idempotency_key,
    'change_type', v_change_type,
    'baseline_version_before', v_version_before,
    'baseline_version_after', v_version_after,
    'state_fingerprint_before', v_fp_before,
    'state_fingerprint_after', v_fp_after
  );
end;
$$;

revoke all on function public.commit_rms_alert_item_transition(uuid, text, bigint, boolean, text, text, integer, timestamptz) from public;
revoke all on function public.commit_rms_alert_item_transition(uuid, text, bigint, boolean, text, text, integer, timestamptz) from anon;
revoke all on function public.commit_rms_alert_item_transition(uuid, text, bigint, boolean, text, text, integer, timestamptz) from authenticated;
grant execute on function public.commit_rms_alert_item_transition(uuid, text, bigint, boolean, text, text, integer, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 8) RLS / table privileges (server-only infrastructure)
-- ---------------------------------------------------------------------------
alter table public.rms_alert_job_state enable row level security;
alter table public.rms_alert_item_state enable row level security;

revoke all on table public.rms_alert_job_state from public;
revoke all on table public.rms_alert_job_state from anon;
revoke all on table public.rms_alert_job_state from authenticated;

revoke all on table public.rms_alert_item_state from public;
revoke all on table public.rms_alert_item_state from anon;
revoke all on table public.rms_alert_item_state from authenticated;

-- Prefer RPC mutations; keep service_role SELECT for diagnostics/adapters.
revoke insert, update, delete on table public.rms_alert_job_state from service_role;
revoke insert, update, delete on table public.rms_alert_item_state from service_role;
grant select on table public.rms_alert_job_state to service_role;
grant select on table public.rms_alert_item_state to service_role;

commit;
;

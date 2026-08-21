import fs from 'fs'
import path from 'path'
import {
  BOOTSTRAP_RPC,
  OBSERVATION_EVIDENCE_RPC,
  RMS_ALERT_SOURCE,
  TRANSITION_RPC,
  bootstrapRmsAlertJobState,
  commitRmsAlertItemTransition,
  recordRmsAlertItemObservationEvidence,
} from '../../server-lib/rmsAlertBaseline.js'
import { isAllowedOperationalEventSource } from '../../server-lib/operationalChangeEvents.js'

const FOUNDATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'database',
  'rms_alert_pipeline_v1_foundation.sql',
)

function readFoundationSql() {
  return fs.readFileSync(FOUNDATION_SQL_PATH, 'utf8')
}

function mockRpcClient(impl) {
  return {
    rpc: jest.fn(impl),
    from: jest.fn(() => {
      throw new Error('direct table mutation is forbidden in rmsAlertBaseline adapters')
    }),
  }
}

describe('rmsAlertBaseline source + adapter contracts', () => {
  test('auto_poll_rms is allowed by operationalChangeEvents', () => {
    expect(isAllowedOperationalEventSource(RMS_ALERT_SOURCE)).toBe(true)
    expect(RMS_ALERT_SOURCE).toBe('auto_poll_rms')
  })

  test('bootstrap wrapper calls exact RPC args and never uses .from()', async () => {
    const supabase = mockRpcClient(async () => ({
      data: { status: 'INITIALIZED', events_created: 0 },
      error: null,
    }))

    const items = [{ crms_item_id: '55', item_name: 'Chair', item_category: 'Furniture', quantity: 8 }]
    const result = await bootstrapRmsAlertJobState(supabase, {
      jobId: '11111111-1111-4111-8111-111111111111',
      observedAt: '2026-08-10T12:00:00.000Z',
      items,
      allowEmpty: false,
    })

    expect(result).toEqual({ status: 'INITIALIZED', events_created: 0 })
    expect(supabase.rpc).toHaveBeenCalledWith(BOOTSTRAP_RPC, {
      p_job_id: '11111111-1111-4111-8111-111111111111',
      p_observed_at: '2026-08-10T12:00:00.000Z',
      p_items: items,
      p_allow_empty: false,
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  test('observation evidence wrapper uses exact RPC name/args', async () => {
    const supabase = mockRpcClient(async () => ({
      data: { status: 'REMOVAL_CANDIDATE', confirmation_ready: false, missing_observation_count: 1 },
      error: null,
    }))

    await recordRmsAlertItemObservationEvidence(supabase, {
      jobId: '11111111-1111-4111-8111-111111111111',
      crmsItemId: '55',
      pollRunId: '22222222-2222-4222-8222-222222222222',
      isMissing: true,
      observedAt: '2026-08-10T12:00:00.000Z',
    })

    expect(supabase.rpc).toHaveBeenCalledWith(OBSERVATION_EVIDENCE_RPC, {
      p_job_id: '11111111-1111-4111-8111-111111111111',
      p_crms_item_id: '55',
      p_poll_run_id: '22222222-2222-4222-8222-222222222222',
      p_is_missing: true,
      p_observed_at: '2026-08-10T12:00:00.000Z',
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  test('transition wrapper uses exact RPC name/args and no direct mutation', async () => {
    const supabase = mockRpcClient(async () => ({
      data: { status: 'COMMITTED', change_type: 'item_quantity_changed' },
      error: null,
    }))

    await commitRmsAlertItemTransition(supabase, {
      jobId: '11111111-1111-4111-8111-111111111111',
      crmsItemId: '55',
      expectedStateVersion: 1,
      observedIsPresent: true,
      observedItemName: 'Chair',
      observedItemCategory: 'Furniture',
      observedQuantity: 8,
      observedAt: '2026-08-10T12:00:00.000Z',
    })

    expect(supabase.rpc).toHaveBeenCalledWith(TRANSITION_RPC, {
      p_job_id: '11111111-1111-4111-8111-111111111111',
      p_crms_item_id: '55',
      p_expected_state_version: 1,
      p_observed_is_present: true,
      p_observed_item_name: 'Chair',
      p_observed_item_category: 'Furniture',
      p_observed_quantity: 8,
      p_observed_at: '2026-08-10T12:00:00.000Z',
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  test('RPC transport errors are surfaced (not converted to COMMITTED)', async () => {
    const supabase = mockRpcClient(async () => ({
      data: null,
      error: { message: 'database exploded' },
    }))

    await expect(
      commitRmsAlertItemTransition(supabase, {
        jobId: '11111111-1111-4111-8111-111111111111',
        crmsItemId: '55',
        expectedStateVersion: 1,
        observedIsPresent: true,
        observedQuantity: 1,
      }),
    ).rejects.toThrow('database exploded')
  })
})

describe('rms_alert_pipeline_v1_foundation.sql static contracts', () => {
  let sql

  beforeAll(() => {
    sql = readFoundationSql()
  })

  test('defines required tables and does not create runtime_state', () => {
    expect(sql).toMatch(/create table if not exists public\.rms_alert_job_state/)
    expect(sql).toMatch(/create table if not exists public\.rms_alert_item_state/)
    expect(sql).not.toMatch(/create table[\s\S]*rms_alert_runtime_state/i)
  })

  test('foreign keys use ON DELETE RESTRICT', () => {
    expect(sql).toMatch(/references public\.crms_jobs\(id\) on delete restrict/)
    expect((sql.match(/on delete restrict/gi) || []).length).toBeGreaterThanOrEqual(2)
  })

  test('enables RLS and revokes PUBLIC/anon/authenticated table access', () => {
    expect(sql).toMatch(/alter table public\.rms_alert_job_state enable row level security/)
    expect(sql).toMatch(/alter table public\.rms_alert_item_state enable row level security/)
    expect(sql).toMatch(/revoke all on table public\.rms_alert_job_state from public/i)
    expect(sql).toMatch(/revoke all on table public\.rms_alert_job_state from anon/i)
    expect(sql).toMatch(/revoke all on table public\.rms_alert_job_state from authenticated/i)
    expect(sql).toMatch(/revoke all on table public\.rms_alert_item_state from anon/i)
    expect(sql).toMatch(/grant select on table public\.rms_alert_job_state to service_role/i)
    expect(sql).toMatch(/revoke insert, update, delete on table public\.rms_alert_item_state from service_role/i)
  })

  test('source CHECK includes auto_poll_rms without rewriting history', () => {
    expect(sql).toMatch(/drop constraint if exists operational_change_events_source_check/)
    expect(sql).toMatch(/'auto_poll_rms'/)
    expect(sql).toMatch(/'manual_rms_refresh'/)
    expect(sql).toMatch(/'global_sync'/)
  })

  test('exact RPC signatures and SECURITY DEFINER + search_path', () => {
    expect(sql).toMatch(
      /create or replace function public\.bootstrap_rms_alert_job_state\(\s*p_job_id uuid,\s*p_observed_at timestamptz,\s*p_items jsonb,\s*p_allow_empty boolean default false\s*\)/s,
    )
    expect(sql).toMatch(
      /create or replace function public\.record_rms_alert_item_observation_evidence\(\s*p_job_id uuid,\s*p_crms_item_id text,\s*p_poll_run_id uuid,\s*p_is_missing boolean,\s*p_observed_at timestamptz\s*\)/s,
    )
    expect(sql).toMatch(
      /create or replace function public\.commit_rms_alert_item_transition\(\s*p_job_id uuid,\s*p_crms_item_id text,\s*p_expected_state_version bigint,\s*p_observed_is_present boolean,\s*p_observed_item_name text,\s*p_observed_item_category text,\s*p_observed_quantity integer,\s*p_observed_at timestamptz\s*\)/s,
    )
    expect(sql).toMatch(/security definer/i)
    expect(sql).toMatch(/set search_path = public, pg_temp/)
    expect(sql).toMatch(/grant execute on function public\.commit_rms_alert_item_transition/i)
    expect(sql).toMatch(/revoke all on function public\.commit_rms_alert_item_transition[\s\S]*from anon/i)
  })

  test('fingerprint V1 contract text is frozen and length-prefixed', () => {
    expect(sql).toMatch(/create or replace function public\.rms_alert_state_fingerprint_v1/)
    expect(sql).toMatch(/v1\|p=1\|q=%s:%s\|n=%s:%s\|c=%s:%s/)
    expect(sql).toMatch(/v1\|p=0\|q=0:\|n=0:\|c=0:/)
  })

  test('job lock precedes item lock in transition RPC', () => {
    const transitionFn = sql.slice(sql.indexOf('commit_rms_alert_item_transition'))
    const jobLockAt = transitionFn.indexOf('from public.rms_alert_job_state')
    const itemLockAt = transitionFn.indexOf('from public.rms_alert_item_state')
    expect(jobLockAt).toBeGreaterThan(-1)
    expect(itemLockAt).toBeGreaterThan(-1)
    expect(jobLockAt).toBeLessThan(itemLockAt)
    expect(transitionFn).toMatch(/for update/)
  })

  test('removal requires confirmed candidate evidence and candidate counter is capped', () => {
    expect(sql).toMatch(/missing_observation_count between 0 and 2/)
    expect(sql).toMatch(/missing_observation_count >= 2/)
    expect(sql).toMatch(/confirmed removal requires missing_observation_count >= 2/)
    expect(sql).toMatch(/least\(2, v_item\.missing_observation_count \+ 1\)/)
  })

  test('idempotency slot includes baseline version and auto_poll_rms source', () => {
    expect(sql).toMatch(/auto_poll_rms:%s:%s:v%s/)
    expect(sql).toMatch(/'auto_poll_rms'/)
    expect(sql).toMatch(/ALREADY_COMMITTED/)
    expect(sql).toMatch(/OBSERVATION_CONFLICT/)
    expect(sql).toMatch(/VERSION_CONFLICT/)
  })

  test('IDP01-TEST-01: first transition slot uses expected version (vN), not live baseline only', () => {
    const transitionFn = sql.slice(sql.indexOf('commit_rms_alert_item_transition'))
    expect(transitionFn).toMatch(
      /v_idempotency_key\s*:=\s*format\(\s*'auto_poll_rms:%s:%s:v%s',\s*p_job_id::text,\s*v_item_id,\s*p_expected_state_version::text\s*\)/s,
    )
    expect(transitionFn).not.toMatch(
      /v_idempotency_key\s*:=\s*format\(\s*'auto_poll_rms:%s:%s:v%s',\s*p_job_id::text,\s*v_item_id,\s*v_version_before::text\s*\)/s,
    )
    expect(transitionFn).toMatch(/insert into public\.operational_change_events/)
    expect(transitionFn).toMatch(/state_version\s*=\s*v_version_after/)
  })

  test('IDP01-TEST-02: identical retry recovers via expected-version slot (ALREADY_COMMITTED)', () => {
    const transitionFn = sql.slice(sql.indexOf('commit_rms_alert_item_transition'))
    const keyAt = transitionFn.search(
      /v_idempotency_key\s*:=\s*format\(\s*'auto_poll_rms:%s:%s:v%s',\s*p_job_id::text,\s*v_item_id,\s*p_expected_state_version::text\s*\)/s,
    )
    const existingLookupAt = transitionFn.indexOf('where idempotency_key = v_idempotency_key')
    const versionCheckAt = transitionFn.indexOf('v_item.state_version <> p_expected_state_version')
    const alreadyCommittedAt = transitionFn.indexOf("'ALREADY_COMMITTED'")

    expect(keyAt).toBeGreaterThan(-1)
    expect(existingLookupAt).toBeGreaterThan(keyAt)
    expect(alreadyCommittedAt).toBeGreaterThan(existingLookupAt)
    expect(versionCheckAt).toBeGreaterThan(existingLookupAt)

    // Retry provenance must prefer committed event payload, not live baseline row.
    expect(transitionFn).toMatch(
      /'ALREADY_COMMITTED'[\s\S]*'baseline_version_before',\s*coalesce\(\s*\(v_existing\.payload->>'baseline_version_before'\)::bigint,\s*p_expected_state_version\s*\)/s,
    )
    expect(transitionFn).toMatch(
      /'ALREADY_COMMITTED'[\s\S]*'baseline_version_after',\s*coalesce\(\s*\(v_existing\.payload->>'baseline_version_after'\)::bigint,\s*p_expected_state_version \+ 1\s*\)/s,
    )
  })

  test('IDP01-TEST-03: same slot different target returns OBSERVATION_CONFLICT before VERSION_CONFLICT', () => {
    const transitionFn = sql.slice(sql.indexOf('commit_rms_alert_item_transition'))
    const observationConflictAt = transitionFn.indexOf("'OBSERVATION_CONFLICT'")
    const versionConflictAt = transitionFn.indexOf(
      "v_item.state_version <> p_expected_state_version",
    )
    expect(observationConflictAt).toBeGreaterThan(-1)
    expect(versionConflictAt).toBeGreaterThan(observationConflictAt)
    expect(transitionFn).toMatch(
      /'OBSERVATION_CONFLICT'[\s\S]*'baseline_version_before',\s*coalesce\(\s*\(v_existing\.payload->>'baseline_version_before'\)::bigint,\s*p_expected_state_version\s*\)/s,
    )
  })

  test('IDP01-TEST-04: stale expected version with no slot falls through to VERSION_CONFLICT', () => {
    const transitionFn = sql.slice(sql.indexOf('commit_rms_alert_item_transition'))
    const existingLookupAt = transitionFn.indexOf('where idempotency_key = v_idempotency_key')
    const ifFoundAt = transitionFn.indexOf('if found then', existingLookupAt)
    const endIfAfterSlot = transitionFn.indexOf('end if;', ifFoundAt)
    const versionCheckAt = transitionFn.indexOf(
      'v_item.state_version <> p_expected_state_version',
      endIfAfterSlot,
    )
    expect(existingLookupAt).toBeGreaterThan(-1)
    expect(versionCheckAt).toBeGreaterThan(endIfAfterSlot)
    expect(transitionFn.slice(versionCheckAt)).toMatch(/'VERSION_CONFLICT'/)
  })

  test('IDP01-TEST-05: recurrence uses distinct versioned slots (not value-pair identity)', () => {
    const transitionFn = sql.slice(sql.indexOf('commit_rms_alert_item_transition'))
    // Slot identity is expected-version based; recurrence 10→8 / 8→10 / 10→8 yields vN, vN+1, vN+2.
    expect(transitionFn).toMatch(/p_expected_state_version::text/)
    expect(transitionFn).not.toMatch(/old_quantity.*new_quantity.*idempotency/i)
    expect(transitionFn).not.toMatch(
      /format\(\s*'auto_poll_rms:%s:%s:%s:%s'/s,
    )
  })

  test('IDP01 order: slot resolution precedes version verification; event precedes baseline', () => {
    const transitionFn = sql.slice(sql.indexOf('commit_rms_alert_item_transition'))
    const jobLockAt = transitionFn.indexOf('from public.rms_alert_job_state')
    const itemLockAt = transitionFn.indexOf('from public.rms_alert_item_state')
    const fpAfterAt = transitionFn.indexOf('v_fp_after :=')
    const slotKeyAt = transitionFn.search(/p_expected_state_version::text/)
    const existingAt = transitionFn.indexOf('where idempotency_key = v_idempotency_key')
    const versionAt = transitionFn.indexOf('v_item.state_version <> p_expected_state_version')
    const eventInsertAt = transitionFn.indexOf('insert into public.operational_change_events')
    const baselineWriteAt = Math.min(
      ...[
        transitionFn.indexOf('insert into public.rms_alert_item_state'),
        transitionFn.indexOf('update public.rms_alert_item_state'),
      ].filter((n) => n >= 0),
    )

    expect(jobLockAt).toBeGreaterThan(-1)
    expect(itemLockAt).toBeGreaterThan(jobLockAt)
    expect(fpAfterAt).toBeGreaterThan(itemLockAt)
    expect(slotKeyAt).toBeGreaterThan(fpAfterAt)
    expect(existingAt).toBeGreaterThan(slotKeyAt)
    expect(versionAt).toBeGreaterThan(existingAt)
    expect(eventInsertAt).toBeGreaterThan(versionAt)
    expect(baselineWriteAt).toBeGreaterThan(eventInsertAt)
  })

  test('bootstrap never references crms_job_items as truth and creates zero events', () => {
    const bootstrapFn = sql.slice(
      sql.indexOf('bootstrap_rms_alert_job_state'),
      sql.indexOf('record_rms_alert_item_observation_evidence'),
    )
    expect(bootstrapFn).not.toMatch(/crms_job_items/)
    expect(bootstrapFn).toMatch(/events_created',\s*0/)
    expect(bootstrapFn).toMatch(/ALREADY_INITIALIZED/)
    expect(bootstrapFn).toMatch(/EMPTY_OBSERVATION_BLOCKED/)
  })

  test('candidate evidence does not increment state_version', () => {
    const evidenceFn = sql.slice(
      sql.indexOf('record_rms_alert_item_observation_evidence'),
      sql.indexOf('commit_rms_alert_item_transition'),
    )
    expect(evidenceFn).not.toMatch(/state_version\s*=\s*[^,\n]+/)
    expect(evidenceFn).toMatch(/'state_version',\s*v_item\.state_version/)
  })
})

describe('IMPLEMENTED_NOT_APPLIED database behaviors', () => {
  test('documents live DB proofs deferred until authorized apply gate', () => {
    // These require executing PostgreSQL against a real schema and are intentionally
    // not claimed by this local Commit 1 repository implementation.
    const deferred = [
      'real transaction atomicity',
      'real concurrent locking',
      'live RLS behavior',
      'live RPC execution',
      'Supabase schema application',
    ]
    expect(deferred.length).toBe(5)
  })
})

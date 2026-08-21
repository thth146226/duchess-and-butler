import fs from 'fs'
import path from 'path'
import {
  ACQUIRE_LEASE_RPC,
  ADVANCE_CURSOR_RPC,
  COMPLETE_CYCLE_RPC,
  FENCED_BOOTSTRAP_RPC,
  FENCED_EVIDENCE_RPC,
  FENCED_TRANSITION_RPC,
  FINGERPRINT_RPC,
  LIST_JOBS_RPC,
  RELEASE_LEASE_RPC,
  RENEW_LEASE_RPC,
  getLondonCalendarDate,
  isRuntimeV1Enabled,
  isRuntimeV1Engine,
  readLiveJobEligibility,
  simulateWouldActions,
} from '../../server-lib/rmsAlertRuntime.js'
import { OBSERVATION_DISPOSITIONS, isJobEligibleForAlertPoll } from '../../server-lib/rmsAlertObservation.js'

const RUNTIME_SQL_PATH = path.join(
  __dirname,
  '..',
  'database',
  'rms_alert_runtime_v1.sql',
)

function readRuntimeSql() {
  return fs.readFileSync(RUNTIME_SQL_PATH, 'utf8')
}

describe('rms_alert_runtime_v1.sql static contracts', () => {
  let sql

  beforeAll(() => {
    sql = readRuntimeSql()
  })

  test('runtime table exists with RLS and browser grants revoked', () => {
    expect(sql).toMatch(/create table if not exists public\.rms_alert_runtime_state/)
    expect(sql).toMatch(/scan_window_days/)
    expect(sql).toMatch(/create table if not exists public\.rms_alert_scan_cycle_jobs/)
    expect(sql).toMatch(/snapshot_sort_date/)
    expect(sql).toMatch(/enable row level security/)
    expect(sql).toMatch(/revoke all on table public\.rms_alert_runtime_state from public/i)
    expect(sql).toMatch(/revoke all on table public\.rms_alert_scan_cycle_jobs from public/i)
    expect(sql).toMatch(/revoke all on table public\.rms_alert_runtime_state from anon/i)
    expect(sql).toMatch(/revoke all on table public\.rms_alert_runtime_state from authenticated/i)
    expect(sql).toMatch(/revoke insert, update, delete on table public\.rms_alert_runtime_state from service_role/i)
    expect(sql).toMatch(/revoke insert, update, delete on table public\.rms_alert_scan_cycle_jobs from service_role/i)
    expect(sql).toMatch(/grant select on table public\.rms_alert_runtime_state to service_role/i)
    expect(sql).toMatch(/grant select on table public\.rms_alert_scan_cycle_jobs to service_role/i)
  })

  test('LEASE RPC set + fence monotonic design', () => {
    expect(sql).toMatch(/create or replace function public\.acquire_rms_alert_runtime_lease/)
    expect(sql).toMatch(/p_window_days integer/)
    expect(sql).toMatch(/create or replace function public\.renew_rms_alert_runtime_lease/)
    expect(sql).toMatch(/create or replace function public\.advance_rms_alert_runtime_cursor/)
    expect(sql).toMatch(/create or replace function public\.complete_rms_alert_runtime_scan_cycle/)
    expect(sql).toMatch(/create or replace function public\.release_rms_alert_runtime_lease/)
    expect(sql).toMatch(/lease_fence_token = lease_fence_token \+ 1/)
    expect(sql).toMatch(/'LEASE_BUSY'/)
    expect(sql).toMatch(/'ALREADY_ACQUIRED'/)
    expect(sql).toMatch(/'LEASE_LOST'/)
    expect(sql).toMatch(/'RENEWED'/)
    expect(sql).toMatch(/'RELEASED'/)
  })

  test('cursor + scan cycle contracts use immutable snapshot', () => {
    expect(sql).toMatch(/'ALREADY_ADVANCED'/)
    expect(sql).toMatch(/'ADVANCED'/)
    expect(sql).toMatch(/'CURSOR_CONFLICT'/)
    expect(sql).toMatch(/'CURSOR_EXHAUSTED'/)
    expect(sql).toMatch(/'CYCLE_COMPLETED'/)
    expect(sql).toMatch(/'CYCLE_NOT_EXHAUSTED'/)
    expect(sql).toMatch(/create or replace function public\.list_rms_alert_jobs_for_poll_v1/)
    expect(sql).toMatch(/from public\.rms_alert_scan_cycle_jobs/)
    expect(sql).toMatch(/order by s\.snapshot_sort_date asc, s\.job_id asc/)
    expect(sql).toMatch(/delete from public\.rms_alert_scan_cycle_jobs/)
    expect(sql).not.toMatch(/list_rms_alert_jobs_for_poll_v1\(\s*p_anchor_date/)
  })

  test('fenced wrappers exist, lock runtime first, fixed search_path, grants', () => {
    expect(sql).toMatch(/create or replace function public\.bootstrap_rms_alert_job_state_fenced/)
    expect(sql).toMatch(/create or replace function public\.record_rms_alert_item_observation_evidence_fenced/)
    expect(sql).toMatch(/create or replace function public\.commit_rms_alert_item_transition_fenced/)

    const bootstrap = sql.slice(sql.indexOf('bootstrap_rms_alert_job_state_fenced'))
    const runtimeLockAt = bootstrap.indexOf('from public.rms_alert_runtime_state')
    const commit1CallAt = bootstrap.indexOf('public.bootstrap_rms_alert_job_state(')
    expect(runtimeLockAt).toBeGreaterThan(-1)
    expect(commit1CallAt).toBeGreaterThan(runtimeLockAt)
    expect(bootstrap).toMatch(/for update/)
    expect(sql).toMatch(/set search_path = public, pg_temp/)

    expect(sql).toMatch(/revoke all on function public\.bootstrap_rms_alert_job_state_fenced[\s\S]*from public/i)
    expect(sql).toMatch(/revoke all on function public\.bootstrap_rms_alert_job_state_fenced[\s\S]*from anon/i)
    expect(sql).toMatch(/revoke all on function public\.bootstrap_rms_alert_job_state_fenced[\s\S]*from authenticated/i)
    expect(sql).toMatch(/grant execute on function public\.commit_rms_alert_item_transition_fenced/i)
  })

  test('LEASE static statuses cover acquisition/reacquire/busy/lost paths', () => {
    expect(sql).toMatch(/'ACQUIRED'/)
    expect(sql).toMatch(/'ALREADY_ACQUIRED'/)
    expect(sql).toMatch(/'LEASE_BUSY'/)
    expect(sql).toMatch(/lease_fence_token = lease_fence_token \+ 1/)
    expect(sql).toMatch(/'LEASE_LOST'/)
    expect(sql).toMatch(/'RENEWED'/)
    expect(sql).toMatch(/'RELEASED'/)
    expect(sql).toMatch(/bootstrap_rms_alert_job_state_fenced/)
    expect(sql).toMatch(/record_rms_alert_item_observation_evidence_fenced/)
    expect(sql).toMatch(/commit_rms_alert_item_transition_fenced/)
  })
})

describe('Europe/London calendar (TIME-01..06)', () => {
  test('TIME-01 GMT date', () => {
    // 2026-01-15 12:00 UTC is still 2026-01-15 in London (GMT)
    expect(getLondonCalendarDate(new Date('2026-01-15T12:00:00.000Z'))).toBe('2026-01-15')
  })

  test('TIME-02 BST date', () => {
    expect(getLondonCalendarDate(new Date('2026-07-15T12:00:00.000Z'))).toBe('2026-07-15')
  })

  test('TIME-03 UTC/London date divergence', () => {
    // 2026-01-15 23:30 UTC = still 15th London (GMT)
    expect(getLondonCalendarDate(new Date('2026-01-15T23:30:00.000Z'))).toBe('2026-01-15')
    // 2026-07-15 23:30 UTC = 2026-07-16 in London (BST UTC+1)
    expect(getLondonCalendarDate(new Date('2026-07-15T23:30:00.000Z'))).toBe('2026-07-16')
  })

  test('TIME-04 DST spring boundary', () => {
    // UK clocks spring forward 2026-03-29 01:00 GMT → 02:00 BST
    expect(getLondonCalendarDate(new Date('2026-03-29T00:30:00.000Z'))).toBe('2026-03-29')
    expect(getLondonCalendarDate(new Date('2026-03-29T01:30:00.000Z'))).toBe('2026-03-29')
  })

  test('TIME-05 DST autumn boundary', () => {
    // UK clocks fall back 2026-10-25
    expect(getLondonCalendarDate(new Date('2026-10-25T00:30:00.000Z'))).toBe('2026-10-25')
    expect(getLondonCalendarDate(new Date('2026-10-25T01:30:00.000Z'))).toBe('2026-10-25')
  })

  test('TIME-06 helper is pure for fixed instants (anchor freeze is scan-cycle concern)', () => {
    const a = getLondonCalendarDate(new Date('2026-08-12T10:00:00.000Z'))
    const b = getLondonCalendarDate(new Date('2026-08-12T10:00:00.000Z'))
    expect(a).toBe(b)
    expect(a).toBe('2026-08-12')
  })
})

describe('feature gate + adapters', () => {
  test('runtime_v1 engine detection and env gate default OFF', () => {
    expect(isRuntimeV1Engine({ engine: 'runtime_v1' })).toBe(true)
    expect(isRuntimeV1Engine({ engine: 'legacy' })).toBe(false)
    const prev = process.env.AUTO_POLL_RUNTIME_V1_ENABLED
    delete process.env.AUTO_POLL_RUNTIME_V1_ENABLED
    expect(isRuntimeV1Enabled()).toBe(false)
    process.env.AUTO_POLL_RUNTIME_V1_ENABLED = 'true'
    expect(isRuntimeV1Enabled()).toBe(true)
    if (prev === undefined) delete process.env.AUTO_POLL_RUNTIME_V1_ENABLED
    else process.env.AUTO_POLL_RUNTIME_V1_ENABLED = prev
  })

  test('RPC name constants match SQL artifact', () => {
    const sql = readRuntimeSql()
    for (const name of [
      ACQUIRE_LEASE_RPC,
      RENEW_LEASE_RPC,
      ADVANCE_CURSOR_RPC,
      COMPLETE_CYCLE_RPC,
      RELEASE_LEASE_RPC,
      LIST_JOBS_RPC,
      FENCED_BOOTSTRAP_RPC,
      FENCED_EVIDENCE_RPC,
      FENCED_TRANSITION_RPC,
    ]) {
      expect(sql).toContain(name)
    }
    expect(FINGERPRINT_RPC).toBe('rms_alert_state_fingerprint_v1')
  })
})

describe('A10 / transition Stage 1 simulation', () => {
  function mockFingerprintClient() {
    return {
      rpc: jest.fn(async (name, args) => {
        if (name !== FINGERPRINT_RPC) throw new Error(`unexpected rpc ${name}`)
        if (!args.p_is_present) return { data: 'v1|p=0|q=0:|n=0:|c=0:', error: null }
        const q = String(args.p_quantity ?? 0)
        const n = String(args.p_item_name || '')
        const c = String(args.p_item_category || '')
        return {
          data: `v1|p=1|q=${q.length}:${q}|n=${n.length}:${n}|c=${c.length}:${c}`,
          error: null,
        }
      }),
      from: jest.fn(() => {
        throw new Error('simulateWouldActions must not touch tables via from()')
      }),
    }
  }

  test('A10-01 first missing → WOULD_RECORD_FIRST_MISSING', async () => {
    const supabase = mockFingerprintClient()
    const actions = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-1',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: true,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 3,
        missing_observation_count: 0,
        missing_last_poll_run_id: null,
      }],
    })
    // empty observed with present baseline would be blocked at observation layer;
    // simulation of missing with partial observe:
    const actions2 = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-1',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '99', item_name: 'Other', item_category: 'X', quantity: 1 }],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: true,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 3,
        missing_observation_count: 0,
        missing_last_poll_run_id: null,
      }],
    })
    expect(actions2.map((a) => a.type)).toEqual(expect.arrayContaining([
      'WOULD_ADD_ITEM',
      'WOULD_RECORD_FIRST_MISSING',
    ]))
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'WOULD_RECORD_FIRST_MISSING', itemKey: '55' }),
    ]))
  })

  test('A10-02 same poll_run retry does not confirm removal', async () => {
    const supabase = mockFingerprintClient()
    const actions = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-1',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '99', item_name: 'Other', item_category: 'X', quantity: 1 }],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: true,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 3,
        missing_observation_count: 1,
        missing_last_poll_run_id: 'poll-1',
      }],
    })
    expect(actions.find((a) => a.itemKey === '55')?.type).toBe('WOULD_NO_CHANGE')
    expect(actions.some((a) => a.type === 'WOULD_REMOVE_ITEM')).toBe(false)
  })

  test('A10-03 second independent poll → WOULD_RECORD_SECOND_MISSING + WOULD_REMOVE_ITEM', async () => {
    const supabase = mockFingerprintClient()
    const actions = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-2',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '99', item_name: 'Other', item_category: 'X', quantity: 1 }],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: true,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 3,
        missing_observation_count: 1,
        missing_last_poll_run_id: 'poll-1',
      }],
    })
    expect(actions.map((a) => a.type)).toEqual(expect.arrayContaining([
      'WOULD_RECORD_SECOND_MISSING',
      'WOULD_REMOVE_ITEM',
    ]))
  })

  test('A10-04 presence clears candidate', async () => {
    const supabase = mockFingerprintClient()
    const actions = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-2',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '55', item_name: 'Chair', item_category: 'Furniture', quantity: 2 }],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: true,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 3,
        missing_observation_count: 1,
        missing_last_poll_run_id: 'poll-1',
      }],
    })
    expect(actions.some((a) => a.type === 'WOULD_CLEAR_MISSING_CANDIDATE')).toBe(true)
  })

  test('A10-05 tombstone still absent → no new removal', async () => {
    const supabase = mockFingerprintClient()
    const actions = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-2',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '99', item_name: 'Other', item_category: 'X', quantity: 1 }],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: false,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 4,
        missing_observation_count: 0,
        missing_last_poll_run_id: null,
      }],
    })
    expect(actions.some((a) => a.itemKey === '55' && a.type === 'WOULD_REMOVE_ITEM')).toBe(false)
  })

  test('A10-06 tombstone reappears → WOULD_REAPPEAR', async () => {
    const supabase = mockFingerprintClient()
    const actions = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-2',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '55', item_name: 'Chair', item_category: 'Furniture', quantity: 2 }],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: false,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 4,
        missing_observation_count: 0,
        missing_last_poll_run_id: null,
      }],
    })
    expect(actions).toEqual([
      expect.objectContaining({ type: 'WOULD_REAPPEAR', itemKey: '55' }),
    ])
  })

  test('transition classification: quantity + metadata + bootstrap', async () => {
    const supabase = mockFingerprintClient()
    const qty = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-1',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '55', item_name: 'Chair', item_category: 'Furniture', quantity: 9 }],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: true,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 1,
        missing_observation_count: 0,
      }],
    })
    expect(qty.some((a) => a.type === 'WOULD_CHANGE_QUANTITY')).toBe(true)

    const meta = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-1',
      jobInitialized: true,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '55', item_name: 'Chair XL', item_category: 'Furniture', quantity: 2 }],
      },
      baselineItems: [{
        crms_item_id: '55',
        is_present: true,
        item_name: 'Chair',
        item_category: 'Furniture',
        quantity: 2,
        state_version: 1,
        missing_observation_count: 0,
      }],
    })
    expect(meta.some((a) => a.type === 'WOULD_CHANGE_METADATA')).toBe(true)

    const boot = await simulateWouldActions({
      supabase,
      pollRunId: 'poll-1',
      jobInitialized: false,
      observation: {
        disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
        items: [{ crms_item_id: '55', item_name: 'Chair', item_category: 'Furniture', quantity: 2 }],
      },
      baselineItems: [],
    })
    expect(boot).toEqual([expect.objectContaining({ type: 'WOULD_BOOTSTRAP' })])
  })
})

describe('C2_RUN_01 scan-cycle snapshot contracts (SNAP-01..14)', () => {
  let sql
  beforeAll(() => {
    sql = readRuntimeSql()
  })

  function acquireBody() {
    return sql.slice(
      sql.indexOf('create or replace function public.acquire_rms_alert_runtime_lease'),
      sql.indexOf('create or replace function public.renew_rms_alert_runtime_lease'),
    )
  }

  function listBody() {
    return sql.slice(
      sql.indexOf('create or replace function public.list_rms_alert_jobs_for_poll_v1'),
      sql.indexOf('create or replace function public.bootstrap_rms_alert_job_state_fenced'),
    )
  }

  function completeBody() {
    return sql.slice(
      sql.indexOf('create or replace function public.complete_rms_alert_runtime_scan_cycle'),
      sql.indexOf('create or replace function public.release_rms_alert_runtime_lease'),
    )
  }

  test('SNAP-01 new scan cycle creates snapshot', () => {
    const body = acquireBody()
    expect(body).toMatch(/insert into public\.rms_alert_scan_cycle_jobs/)
    expect(body).toMatch(/scan_cycle_id = p_requested_scan_cycle_id/)
  })

  test('SNAP-02 snapshot freezes London anchor/window', () => {
    const body = acquireBody()
    expect(body).toMatch(/scan_anchor_date = p_anchor_date/)
    expect(body).toMatch(/scan_window_days = p_window_days/)
    expect(body).toMatch(/d >= p_anchor_date/)
    expect(body).toMatch(/d <= \(p_anchor_date \+ p_window_days\)::date/)
  })

  test('SNAP-03/07 membership uses frozen snapshot_sort_date not live dates', () => {
    const list = listBody()
    expect(list).toMatch(/from public\.rms_alert_scan_cycle_jobs s/)
    expect(list).toMatch(/s\.snapshot_sort_date as sort_date/)
    expect(list).toMatch(/\(s\.snapshot_sort_date, s\.job_id\) > \(p_cursor_sort_date, p_cursor_job_id\)/)
    // Live date columns must not drive ordering
    expect(list).not.toMatch(/order by .*j\.(event_date|delivery_date|collection_date)/i)
  })

  test('SNAP-04 processed job cannot reappear via live date move (cursor on snapshot key)', () => {
    const list = listBody()
    expect(list).toMatch(/\(s\.snapshot_sort_date, s\.job_id\) >/)
    expect(list).toMatch(/order by s\.snapshot_sort_date asc, s\.job_id asc/)
  })

  test('SNAP-05/06 newly eligible after snapshot requires next cycle (no live rebuild while open)', () => {
    const body = acquireBody()
    expect(body).toMatch(/v_continue := \(v_row\.scan_cycle_id is not null and v_row\.cycle_completed_at is null\)/)
    expect(body).toMatch(/CONTINUE unfinished cycle/)
    // continue branch must not insert snapshot
    const continueSlice = body.slice(body.indexOf('if v_continue then'), body.indexOf('else'))
    expect(continueSlice).not.toMatch(/insert into public\.rms_alert_scan_cycle_jobs/)
  })

  test('SNAP-08 cancelled/hidden/inactive remains snapshot member; JS live skip contract exported', () => {
    const list = listBody()
    expect(list).not.toMatch(/status <> 'cancelled'/)
    expect(list).not.toMatch(/hidden_from_schedule = false/)
    expect(typeof readLiveJobEligibility).toBe('function')
    expect(isJobEligibleForAlertPoll({ crms_id: '1', status: 'cancelled' })).toBe(false)
    expect(isJobEligibleForAlertPoll({
      crms_id: '1',
      status: 'confirmed',
      hidden_from_schedule: true,
    })).toBe(false)
  })

  test('SNAP-09 expired lease takeover continues same snapshot/cycle/cursor', () => {
    const body = acquireBody()
    const continueSlice = body.slice(body.indexOf('if v_continue then'), body.indexOf('else'))
    expect(continueSlice).toMatch(/lease_fence_token = lease_fence_token \+ 1/)
    expect(continueSlice).not.toMatch(/scan_cycle_id = p_requested_scan_cycle_id/)
    expect(continueSlice).not.toMatch(/cursor_sort_date = null/)
    expect(continueSlice).not.toMatch(/insert into public\.rms_alert_scan_cycle_jobs/)
  })

  test('SNAP-10 page continuation keeps immutable ordering', () => {
    expect(listBody()).toMatch(/order by s\.snapshot_sort_date asc, s\.job_id asc/)
  })

  test('SNAP-11 cycle completion removes snapshot rows', () => {
    const complete = completeBody()
    expect(complete).toMatch(/delete from public\.rms_alert_scan_cycle_jobs/)
    expect(complete).toMatch(/where scan_cycle_id = p_scan_cycle_id/)
    expect(complete).toMatch(/cursor_sort_date = null/)
  })

  test('SNAP-12 next cycle creates fresh snapshot', () => {
    const body = acquireBody()
    expect(body).toMatch(/else\s+-- NEW cycle/s)
    expect(body).toMatch(/insert into public\.rms_alert_scan_cycle_jobs/)
  })

  test('SNAP-13 snapshot creation failure rolls back acquisition (same function txn)', () => {
    const body = acquireBody()
    const newCycle = body.slice(body.indexOf('else'))
    const updateAt = newCycle.indexOf('update public.rms_alert_runtime_state')
    const insertAt = newCycle.indexOf('insert into public.rms_alert_scan_cycle_jobs')
    expect(updateAt).toBeGreaterThan(-1)
    expect(insertAt).toBeGreaterThan(updateAt)
    // no exception handlers swallowing insert failures in acquire
    expect(body).not.toMatch(/exception when others/i)
  })

  test('SNAP-14 selection/cursor uses snapshot_sort_date only', () => {
    expect(sql).toMatch(/snapshot_sort_date/)
    expect(listBody()).toMatch(/s\.snapshot_sort_date/)
    expect(sql).toMatch(/p_cursor_sort_date/)
  })
})

describe('Addendum C C3 contracts (cursor/cycle/seed/sec/sig)', () => {
  let sql
  let runtimeJs

  const SNAPSHOT = [
    { snapshot_sort_date: '2026-08-01', job_id: '11111111-1111-1111-1111-111111111111' },
    { snapshot_sort_date: '2026-08-02', job_id: '22222222-2222-2222-2222-222222222222' },
    { snapshot_sort_date: '2026-08-03', job_id: '33333333-3333-3333-3333-333333333333' },
  ]

  beforeAll(() => {
    sql = readRuntimeSql()
    runtimeJs = fs.readFileSync(
      path.join(__dirname, '..', '..', 'server-lib', 'rmsAlertRuntime.js'),
      'utf8',
    )
  })

  function advanceBody() {
    return sql.slice(
      sql.indexOf('create or replace function public.advance_rms_alert_runtime_cursor'),
      sql.indexOf('create or replace function public.complete_rms_alert_runtime_scan_cycle'),
    )
  }

  function completeBody() {
    return sql.slice(
      sql.indexOf('create or replace function public.complete_rms_alert_runtime_scan_cycle'),
      sql.indexOf('create or replace function public.release_rms_alert_runtime_lease'),
    )
  }

  function acquireBody() {
    return sql.slice(
      sql.indexOf('create or replace function public.acquire_rms_alert_runtime_lease'),
      sql.indexOf('create or replace function public.renew_rms_alert_runtime_lease'),
    )
  }

  function helperBody() {
    return sql.slice(
      sql.indexOf('create or replace function public.rms_alert_runtime_lease_is_active'),
      sql.indexOf('drop function if exists public.acquire_rms_alert_runtime_lease'),
    )
  }

  /** Mirrors C2_DB_02 exact-next semantics for Stage-1 static verification. */
  function resolveExactNextAdvance({
    cursorSortDate = null,
    cursorJobId = null,
    submittedSortDate,
    submittedJobId,
    snapshot = SNAPSHOT,
  }) {
    if (
      cursorSortDate != null
      && cursorJobId != null
      && cursorSortDate === submittedSortDate
      && cursorJobId === submittedJobId
    ) {
      return 'ALREADY_ADVANCED'
    }
    const ordered = [...snapshot].sort((a, b) => {
      if (a.snapshot_sort_date < b.snapshot_sort_date) return -1
      if (a.snapshot_sort_date > b.snapshot_sort_date) return 1
      if (a.job_id < b.job_id) return -1
      if (a.job_id > b.job_id) return 1
      return 0
    })
    const expected = ordered.find((row) => (
      cursorSortDate == null
      || cursorJobId == null
      || row.snapshot_sort_date > cursorSortDate
      || (row.snapshot_sort_date === cursorSortDate && row.job_id > cursorJobId)
    ))
    if (!expected) return 'CURSOR_EXHAUSTED'
    if (
      submittedSortDate !== expected.snapshot_sort_date
      || submittedJobId !== expected.job_id
    ) {
      return 'CURSOR_CONFLICT'
    }
    return 'ADVANCED'
  }

  /** Mirrors C2_DB_03 exhaustion gate. */
  function resolveCycleCompletion({
    cursorSortDate = null,
    cursorJobId = null,
    snapshot = SNAPSHOT,
  }) {
    const remaining = snapshot.some((row) => (
      cursorSortDate == null
      || cursorJobId == null
      || row.snapshot_sort_date > cursorSortDate
      || (row.snapshot_sort_date === cursorSortDate && row.job_id > cursorJobId)
    ))
    return remaining ? 'CYCLE_NOT_EXHAUSTED' : 'CYCLE_COMPLETED'
  }

  test('C3-CURSOR-01 first member advances', () => {
    const body = advanceBody()
    expect(body).toMatch(/from public\.rms_alert_scan_cycle_jobs s/)
    expect(body).toMatch(/order by s\.snapshot_sort_date asc, s\.job_id asc/)
    expect(body).toMatch(/v_row\.cursor_sort_date is null/)
    expect(resolveExactNextAdvance({
      submittedSortDate: SNAPSHOT[0].snapshot_sort_date,
      submittedJobId: SNAPSHOT[0].job_id,
    })).toBe('ADVANCED')
  })

  test('C3-CURSOR-02 exact next member advances', () => {
    expect(resolveExactNextAdvance({
      cursorSortDate: SNAPSHOT[0].snapshot_sort_date,
      cursorJobId: SNAPSHOT[0].job_id,
      submittedSortDate: SNAPSHOT[1].snapshot_sort_date,
      submittedJobId: SNAPSHOT[1].job_id,
    })).toBe('ADVANCED')
    expect(advanceBody()).toMatch(/p_cursor_sort_date is distinct from v_expected_sort_date/)
  })

  test('C3-CURSOR-03 skipping member rejected', () => {
    expect(resolveExactNextAdvance({
      cursorSortDate: SNAPSHOT[0].snapshot_sort_date,
      cursorJobId: SNAPSHOT[0].job_id,
      submittedSortDate: SNAPSHOT[2].snapshot_sort_date,
      submittedJobId: SNAPSHOT[2].job_id,
    })).toBe('CURSOR_CONFLICT')
  })

  test('C3-CURSOR-04 arbitrary tuple rejected', () => {
    expect(resolveExactNextAdvance({
      cursorSortDate: SNAPSHOT[0].snapshot_sort_date,
      cursorJobId: SNAPSHOT[0].job_id,
      submittedSortDate: '2099-01-01',
      submittedJobId: '99999999-9999-9999-9999-999999999999',
    })).toBe('CURSOR_CONFLICT')
  })

  test('C3-CURSOR-05 backward tuple rejected', () => {
    expect(resolveExactNextAdvance({
      cursorSortDate: SNAPSHOT[1].snapshot_sort_date,
      cursorJobId: SNAPSHOT[1].job_id,
      submittedSortDate: SNAPSHOT[0].snapshot_sort_date,
      submittedJobId: SNAPSHOT[0].job_id,
    })).toBe('CURSOR_CONFLICT')
  })

  test('C3-CURSOR-06 same cursor retry ALREADY_ADVANCED', () => {
    expect(resolveExactNextAdvance({
      cursorSortDate: SNAPSHOT[1].snapshot_sort_date,
      cursorJobId: SNAPSHOT[1].job_id,
      submittedSortDate: SNAPSHOT[1].snapshot_sort_date,
      submittedJobId: SNAPSHOT[1].job_id,
    })).toBe('ALREADY_ADVANCED')
    expect(advanceBody()).toMatch(/'ALREADY_ADVANCED'/)
  })

  test('C3-CURSOR-07 exhausted cursor returns CURSOR_EXHAUSTED', () => {
    expect(resolveExactNextAdvance({
      cursorSortDate: SNAPSHOT[2].snapshot_sort_date,
      cursorJobId: SNAPSHOT[2].job_id,
      submittedSortDate: '2099-01-01',
      submittedJobId: '99999999-9999-9999-9999-999999999999',
    })).toBe('CURSOR_EXHAUSTED')
    expect(advanceBody()).toMatch(/'CURSOR_EXHAUSTED'/)
    expect(advanceBody()).toMatch(/if not found then/)
  })

  test('C3-CYCLE-01 premature completion rejected', () => {
    expect(resolveCycleCompletion({
      cursorSortDate: SNAPSHOT[0].snapshot_sort_date,
      cursorJobId: SNAPSHOT[0].job_id,
    })).toBe('CYCLE_NOT_EXHAUSTED')
    expect(completeBody()).toMatch(/'CYCLE_NOT_EXHAUSTED'/)
  })

  test('C3-CYCLE-02 premature completion mutates nothing', () => {
    const body = completeBody()
    const rejectAt = body.indexOf("'CYCLE_NOT_EXHAUSTED'")
    const deleteAt = body.indexOf('delete from public.rms_alert_scan_cycle_jobs')
    const completeUpdateAt = body.indexOf('cycle_completed_at = v_now')
    expect(rejectAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(rejectAt)
    expect(completeUpdateAt).toBeGreaterThan(rejectAt)
    expect(body).toMatch(/if v_remaining then\s+return jsonb_build_object\('status', 'CYCLE_NOT_EXHAUSTED'\)/s)
  })

  test('C3-CYCLE-03 final-member completion succeeds', () => {
    expect(resolveCycleCompletion({
      cursorSortDate: SNAPSHOT[2].snapshot_sort_date,
      cursorJobId: SNAPSHOT[2].job_id,
    })).toBe('CYCLE_COMPLETED')
  })

  test('C3-CYCLE-04 zero-job cycle completion succeeds', () => {
    expect(resolveCycleCompletion({
      cursorSortDate: null,
      cursorJobId: null,
      snapshot: [],
    })).toBe('CYCLE_COMPLETED')
    const body = completeBody()
    expect(body).toMatch(/Zero-row snapshot with NULL cursor has no remaining members: allowed/)
  })

  test('C3-CYCLE-05 cleanup failure preserves transaction atomicity', () => {
    const body = completeBody()
    expect(body).not.toMatch(/exception when others/i)
    const deleteAt = body.indexOf('delete from public.rms_alert_scan_cycle_jobs')
    const updateAt = body.indexOf('cycle_completed_at = v_now')
    expect(deleteAt).toBeGreaterThan(-1)
    expect(updateAt).toBeGreaterThan(deleteAt)
  })

  test('C3-SEED-01 no top-level runtime seed', () => {
    expect(sql).not.toMatch(
      /insert into public\.rms_alert_runtime_state \(pipeline_key\)\s*values \('auto_poll_rms'\)/i,
    )
    expect(sql).toMatch(/Migration must not seed rms_alert_runtime_state/)
  })

  test('C3-SEED-02 lazy creation remains acquire-only', () => {
    const body = acquireBody()
    expect(body).toMatch(
      /insert into public\.rms_alert_runtime_state \(pipeline_key\)\s*values \(p_pipeline_key\)/i,
    )
    const inserts = sql.match(/insert into public\.rms_alert_runtime_state \(pipeline_key\)/gi) || []
    expect(inserts).toHaveLength(1)
  })

  test('C3-SEC-01 helper fixed search_path', () => {
    const body = helperBody()
    expect(body).toMatch(/security invoker/i)
    expect(body).toMatch(/immutable/i)
    expect(body).toMatch(/set search_path = public, pg_temp/)
  })

  test('C3-SEC-02 PUBLIC/anon/authenticated revoked', () => {
    expect(sql).toMatch(
      /revoke all on function public\.rms_alert_runtime_lease_is_active\(public\.rms_alert_runtime_state, timestamptz\) from public/i,
    )
    expect(sql).toMatch(
      /revoke all on function public\.rms_alert_runtime_lease_is_active\(public\.rms_alert_runtime_state, timestamptz\) from anon/i,
    )
    expect(sql).toMatch(
      /revoke all on function public\.rms_alert_runtime_lease_is_active\(public\.rms_alert_runtime_state, timestamptz\) from authenticated/i,
    )
    expect(sql).toMatch(
      /revoke all on function public\.rms_alert_runtime_lease_is_active\(public\.rms_alert_runtime_state, timestamptz\) from service_role/i,
    )
    expect(sql).not.toMatch(
      /grant execute on function public\.rms_alert_runtime_lease_is_active/i,
    )
  })

  test('C3-SEC-03 no browser-callable helper introduced', () => {
    expect(sql).not.toMatch(
      /grant execute on function public\.rms_alert_runtime_lease_is_active[\s\S]{0,80}to (anon|authenticated)/i,
    )
    expect(helperBody()).toMatch(/security invoker/i)
  })

  test('C3-SIG-01 canonical acquire parameter order', () => {
    expect(sql).toMatch(
      /create or replace function public\.acquire_rms_alert_runtime_lease\(\s*p_pipeline_key text,\s*p_poll_run_id uuid,\s*p_requested_scan_cycle_id uuid,\s*p_anchor_date date,\s*p_window_days integer,\s*p_lease_ttl_seconds integer\s*\)/s,
    )
  })

  test('C3-SIG-02 JS adapter matches canonical order', () => {
    const block = runtimeJs.match(
      /return callRpc\(supabase, ACQUIRE_LEASE_RPC, \{([\s\S]*?)\}\)/,
    )
    expect(block).toBeTruthy()
    const args = block[1]
    expect(args.indexOf('p_anchor_date')).toBeGreaterThan(-1)
    expect(args.indexOf('p_window_days')).toBeGreaterThan(args.indexOf('p_anchor_date'))
    expect(args.indexOf('p_lease_ttl_seconds')).toBeGreaterThan(args.indexOf('p_window_days'))
  })
})

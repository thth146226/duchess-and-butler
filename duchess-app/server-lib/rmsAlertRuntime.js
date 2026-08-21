// Server-only Alert Pipeline runtime orchestration adapters (Commit 2 Stage 1).
// Never import from frontend/src code.
// Stage 1 must not call fenced mutation wrappers or persist events/Telegram.

import {
  OBSERVATION_DISPOSITIONS,
  isJobEligibleForAlertPoll,
  observeJobFromCurrentRms,
} from './rmsAlertObservation.js'

export const RMS_ALERT_PIPELINE_KEY = 'auto_poll_rms'
export const RMS_ALERT_LEASE_TTL_SECONDS_DEFAULT = 120
export const RMS_ALERT_LEASE_TTL_SECONDS_MIN = 30
export const RMS_ALERT_LEASE_TTL_SECONDS_MAX = 900
export const RMS_ALERT_LEASE_RENEW_REMAINING_SECONDS = 45
export const LONDON_TZ = 'Europe/London'

export const ACQUIRE_LEASE_RPC = 'acquire_rms_alert_runtime_lease'
export const RENEW_LEASE_RPC = 'renew_rms_alert_runtime_lease'
export const ADVANCE_CURSOR_RPC = 'advance_rms_alert_runtime_cursor'
export const COMPLETE_CYCLE_RPC = 'complete_rms_alert_runtime_scan_cycle'
export const RELEASE_LEASE_RPC = 'release_rms_alert_runtime_lease'
export const LIST_JOBS_RPC = 'list_rms_alert_jobs_for_poll_v1'
export const FINGERPRINT_RPC = 'rms_alert_state_fingerprint_v1'

export const FENCED_BOOTSTRAP_RPC = 'bootstrap_rms_alert_job_state_fenced'
export const FENCED_EVIDENCE_RPC = 'record_rms_alert_item_observation_evidence_fenced'
export const FENCED_TRANSITION_RPC = 'commit_rms_alert_item_transition_fenced'

const UNRESOLVED_DISPOSITIONS = new Set([
  OBSERVATION_DISPOSITIONS.FETCH_ERROR,
  OBSERVATION_DISPOSITIONS.PARSE_ERROR,
  OBSERVATION_DISPOSITIONS.BLOCKED_ZERO_ITEMS,
  OBSERVATION_DISPOSITIONS.OBSERVATION_SUSPECT,
  OBSERVATION_DISPOSITIONS.SOURCE_DISAPPEARED,
  'DATABASE_ERROR',
  'LEASE_LOST',
  'CURSOR_CONFLICT',
])

function requireSupabase(supabase) {
  if (!supabase || typeof supabase.rpc !== 'function') {
    throw new Error('Supabase client with rpc() is required for rms alert runtime operations.')
  }
}

function clampLeaseTtl(seconds) {
  const n = Number.parseInt(seconds, 10)
  if (!Number.isFinite(n)) return RMS_ALERT_LEASE_TTL_SECONDS_DEFAULT
  return Math.min(
    RMS_ALERT_LEASE_TTL_SECONDS_MAX,
    Math.max(RMS_ALERT_LEASE_TTL_SECONDS_MIN, n),
  )
}

export function getLondonCalendarDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date for London calendar calculation')
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LONDON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parts.find((p) => p.type === 'year')?.value
  const month = parts.find((p) => p.type === 'month')?.value
  const day = parts.find((p) => p.type === 'day')?.value
  return `${year}-${month}-${day}`
}

export function isRuntimeV1Enabled(env = process.env) {
  return String(env.AUTO_POLL_RUNTIME_V1_ENABLED || '') === 'true'
}

export function isRuntimeV1Engine(body = {}) {
  return String(body?.engine || '').trim().toLowerCase() === 'runtime_v1'
}

export function createPollRunId(randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUuid === 'function') return randomUuid()
  throw new Error('crypto.randomUUID is required to create poll_run_id')
}

async function callRpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) {
    const err = new Error(error.message || `${name} failed`)
    err.code = 'DATABASE_ERROR'
    throw err
  }
  return data
}

export async function acquireRuntimeLease(supabase, {
  pollRunId,
  requestedScanCycleId,
  anchorDate,
  windowDays = 14,
  leaseTtlSeconds = RMS_ALERT_LEASE_TTL_SECONDS_DEFAULT,
} = {}) {
  requireSupabase(supabase)
  const days = Number.parseInt(windowDays, 10)
  return callRpc(supabase, ACQUIRE_LEASE_RPC, {
    p_pipeline_key: RMS_ALERT_PIPELINE_KEY,
    p_poll_run_id: pollRunId,
    p_requested_scan_cycle_id: requestedScanCycleId,
    p_anchor_date: anchorDate,
    p_window_days: Number.isFinite(days) && days > 0 ? days : 14,
    p_lease_ttl_seconds: clampLeaseTtl(leaseTtlSeconds),
  })
}

export async function renewRuntimeLease(supabase, {
  pollRunId,
  leaseFenceToken,
  leaseTtlSeconds = RMS_ALERT_LEASE_TTL_SECONDS_DEFAULT,
} = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, RENEW_LEASE_RPC, {
    p_pipeline_key: RMS_ALERT_PIPELINE_KEY,
    p_poll_run_id: pollRunId,
    p_lease_fence_token: leaseFenceToken,
    p_lease_ttl_seconds: clampLeaseTtl(leaseTtlSeconds),
  })
}

export async function advanceRuntimeCursor(supabase, {
  pollRunId,
  leaseFenceToken,
  scanCycleId,
  cursorSortDate,
  cursorJobId,
} = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, ADVANCE_CURSOR_RPC, {
    p_pipeline_key: RMS_ALERT_PIPELINE_KEY,
    p_poll_run_id: pollRunId,
    p_lease_fence_token: leaseFenceToken,
    p_scan_cycle_id: scanCycleId,
    p_cursor_sort_date: cursorSortDate,
    p_cursor_job_id: cursorJobId,
  })
}

export async function completeRuntimeScanCycle(supabase, {
  pollRunId,
  leaseFenceToken,
  scanCycleId,
} = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, COMPLETE_CYCLE_RPC, {
    p_pipeline_key: RMS_ALERT_PIPELINE_KEY,
    p_poll_run_id: pollRunId,
    p_lease_fence_token: leaseFenceToken,
    p_scan_cycle_id: scanCycleId,
  })
}

export async function releaseRuntimeLease(supabase, {
  pollRunId,
  leaseFenceToken,
  runStatus,
  lastError = null,
} = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, RELEASE_LEASE_RPC, {
    p_pipeline_key: RMS_ALERT_PIPELINE_KEY,
    p_poll_run_id: pollRunId,
    p_lease_fence_token: leaseFenceToken,
    p_run_status: runStatus,
    p_last_error: lastError,
  })
}

export async function listJobsForPollPage(supabase, {
  scanCycleId,
  cursorSortDate = null,
  cursorJobId = null,
  limit,
} = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, LIST_JOBS_RPC, {
    p_scan_cycle_id: scanCycleId,
    p_cursor_sort_date: cursorSortDate,
    p_cursor_job_id: cursorJobId,
    p_limit: limit,
  })
}

/** Live eligibility recheck for immutable snapshot members (SNAP-08). */
export async function readLiveJobEligibility(supabase, jobId) {
  requireSupabase(supabase)
  const { data, error } = await supabase
    .from('crms_jobs')
    .select('id, crms_id, status, hidden_from_schedule, rms_visibility_status')
    .eq('id', jobId)
    .maybeSingle()
  if (error) {
    const err = new Error(error.message || 'read live crms_jobs eligibility failed')
    err.code = 'DATABASE_ERROR'
    throw err
  }
  return data || null
}

export async function fingerprintStateV1(supabase, {
  isPresent,
  quantity,
  itemName,
  itemCategory,
} = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, FINGERPRINT_RPC, {
    p_is_present: isPresent,
    p_quantity: quantity,
    p_item_name: itemName,
    p_item_category: itemCategory,
  })
}

/** Adapters for Stage 2 — Stage 1 application must not call these. */
export async function bootstrapJobStateFenced(supabase, args = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, FENCED_BOOTSTRAP_RPC, {
    p_pipeline_key: RMS_ALERT_PIPELINE_KEY,
    p_poll_run_id: args.pollRunId,
    p_lease_fence_token: args.leaseFenceToken,
    p_job_id: args.jobId,
    p_observed_at: args.observedAt,
    p_items: args.items,
  })
}

export async function recordObservationEvidenceFenced(supabase, args = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, FENCED_EVIDENCE_RPC, {
    p_pipeline_key: RMS_ALERT_PIPELINE_KEY,
    p_poll_run_id: args.pollRunId,
    p_lease_fence_token: args.leaseFenceToken,
    p_job_id: args.jobId,
    p_crms_item_id: args.crmsItemId,
    p_is_missing: args.isMissing,
    p_observed_at: args.observedAt,
  })
}

export async function commitItemTransitionFenced(supabase, args = {}) {
  requireSupabase(supabase)
  return callRpc(supabase, FENCED_TRANSITION_RPC, {
    p_pipeline_key: RMS_ALERT_PIPELINE_KEY,
    p_poll_run_id: args.pollRunId,
    p_lease_fence_token: args.leaseFenceToken,
    p_job_id: args.jobId,
    p_crms_item_id: args.crmsItemId,
    p_expected_state_version: args.expectedStateVersion,
    p_observed_is_present: args.observedIsPresent,
    p_observed_item_name: args.observedItemName,
    p_observed_item_category: args.observedItemCategory,
    p_observed_quantity: args.observedQuantity,
    p_observed_at: args.observedAt,
  })
}

export async function readAlertJobState(supabase, jobId) {
  requireSupabase(supabase)
  const { data, error } = await supabase
    .from('rms_alert_job_state')
    .select('job_id, crms_id, initialized_at, last_observed_at')
    .eq('job_id', jobId)
    .maybeSingle()
  if (error) {
    const err = new Error(error.message || 'read rms_alert_job_state failed')
    err.code = 'DATABASE_ERROR'
    throw err
  }
  return data || null
}

export async function readAlertItemStates(supabase, jobId) {
  requireSupabase(supabase)
  const { data, error } = await supabase
    .from('rms_alert_item_state')
    .select(
      'job_id, crms_item_id, is_present, item_name, item_category, quantity, state_version, missing_observation_count, missing_last_poll_run_id',
    )
    .eq('job_id', jobId)
  if (error) {
    const err = new Error(error.message || 'read rms_alert_item_state failed')
    err.code = 'DATABASE_ERROR'
    throw err
  }
  return data || []
}

function norm(value) {
  return String(value ?? '').trim()
}

/**
 * Stage 1 report-only simulation of A10 + transition intents.
 * Does not mutate baseline. Uses Commit 1 fingerprint RPC when needed.
 */
export async function simulateWouldActions({
  supabase,
  pollRunId,
  observation,
  baselineItems = [],
  jobInitialized = false,
}) {
  const wouldActions = []
  if (observation.disposition !== OBSERVATION_DISPOSITIONS.QUALIFIED) {
    return wouldActions
  }

  if (!jobInitialized) {
    wouldActions.push({ type: 'WOULD_BOOTSTRAP', itemKey: null })
    return wouldActions
  }

  const observedById = new Map(observation.items.map((i) => [i.crms_item_id, i]))
  const baselineById = new Map(baselineItems.map((r) => [String(r.crms_item_id), r]))

  for (const [crmsItemId, observed] of observedById.entries()) {
    const baseline = baselineById.get(crmsItemId)

    if (!baseline) {
      wouldActions.push({
        type: 'WOULD_ADD_ITEM',
        itemKey: crmsItemId,
        expectedStateVersion: 0,
      })
      continue
    }

    if (baseline.is_present !== true) {
      wouldActions.push({
        type: 'WOULD_REAPPEAR',
        itemKey: crmsItemId,
        expectedStateVersion: baseline.state_version,
      })
      continue
    }

    if ((baseline.missing_observation_count || 0) > 0) {
      wouldActions.push({
        type: 'WOULD_CLEAR_MISSING_CANDIDATE',
        itemKey: crmsItemId,
      })
    }

    const beforeFp = await fingerprintStateV1(supabase, {
      isPresent: true,
      quantity: baseline.quantity,
      itemName: baseline.item_name,
      itemCategory: baseline.item_category,
    })
    const afterFp = await fingerprintStateV1(supabase, {
      isPresent: true,
      quantity: observed.quantity,
      itemName: observed.item_name,
      itemCategory: observed.item_category,
    })

    if (beforeFp === afterFp) {
      if ((baseline.missing_observation_count || 0) === 0) {
        wouldActions.push({
          type: 'WOULD_NO_CHANGE',
          itemKey: crmsItemId,
          expectedStateVersion: baseline.state_version,
        })
      }
      continue
    }

    if (Number(baseline.quantity) !== Number(observed.quantity)) {
      wouldActions.push({
        type: 'WOULD_CHANGE_QUANTITY',
        itemKey: crmsItemId,
        expectedStateVersion: baseline.state_version,
      })
    } else if (
      norm(baseline.item_name) !== norm(observed.item_name)
      || norm(baseline.item_category) !== norm(observed.item_category)
    ) {
      wouldActions.push({
        type: 'WOULD_CHANGE_METADATA',
        itemKey: crmsItemId,
        expectedStateVersion: baseline.state_version,
      })
    }
  }

  for (const baseline of baselineItems) {
    if (baseline.is_present !== true) continue
    if (observedById.has(String(baseline.crms_item_id))) continue

    const count = Number(baseline.missing_observation_count || 0)
    const lastPoll = baseline.missing_last_poll_run_id

    if (count === 0) {
      wouldActions.push({
        type: 'WOULD_RECORD_FIRST_MISSING',
        itemKey: String(baseline.crms_item_id),
      })
      continue
    }

    if (count >= 1 && lastPoll && String(lastPoll) === String(pollRunId)) {
      // same poll_run retry — not independent confirmation
      wouldActions.push({
        type: 'WOULD_NO_CHANGE',
        itemKey: String(baseline.crms_item_id),
        note: 'same_poll_run_missing_retry',
      })
      continue
    }

    if (count === 1) {
      wouldActions.push({
        type: 'WOULD_RECORD_SECOND_MISSING',
        itemKey: String(baseline.crms_item_id),
      })
      wouldActions.push({
        type: 'WOULD_REMOVE_ITEM',
        itemKey: String(baseline.crms_item_id),
        expectedStateVersion: baseline.state_version,
        confirmationReady: true,
      })
      continue
    }

    if (count >= 2) {
      wouldActions.push({
        type: 'WOULD_REMOVE_ITEM',
        itemKey: String(baseline.crms_item_id),
        expectedStateVersion: baseline.state_version,
        confirmationReady: true,
      })
    }
  }

  return wouldActions
}

function countWould(wouldActions, prefix) {
  return wouldActions.filter((a) => String(a.type || '').startsWith(prefix)).length
}

function leaseNeedsRenewal(leaseExpiresAt, now = new Date()) {
  if (!leaseExpiresAt) return true
  const expires = new Date(leaseExpiresAt).getTime()
  if (Number.isNaN(expires)) return true
  return expires - now.getTime() <= RMS_ALERT_LEASE_RENEW_REMAINING_SECONDS * 1000
}

/**
 * Stage 1 Runtime V1 report-only engine.
 * May call lease/cursor/scan RPCs and baseline/fingerprint reads.
 * Must not call fenced mutation wrappers, Telegram, or crms_job_items.
 */
export async function runRuntimeV1ReportOnly({
  supabase,
  body = {},
  now = new Date(),
  fetchImpl = globalThis.fetch,
  randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
}) {
  requireSupabase(supabase)

  if (body?.apply === true) {
    const error = new Error('auto_poll_rms apply mode is not enabled yet. Use apply: false.')
    error.statusCode = 400
    throw error
  }

  if (!isRuntimeV1Enabled()) {
    const error = new Error('AUTO_POLL_RUNTIME_V1_ENABLED is not true; runtime_v1 is fail-closed.')
    error.statusCode = 403
    throw error
  }

  const windowDaysRaw = Number.parseInt(body?.windowDays, 10)
  const windowDays = Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 ? windowDaysRaw : 14
  const maxJobsRaw = Number.parseInt(body?.maxJobs, 10)
  const maxJobs = Number.isFinite(maxJobsRaw) && maxJobsRaw > 0
    ? Math.min(maxJobsRaw, 40)
    : 25
  const leaseTtlSeconds = clampLeaseTtl(body?.leaseTtlSeconds)

  const pollRunId = createPollRunId(randomUuid)
  const requestedScanCycleId = createPollRunId(randomUuid)
  const anchorDate = getLondonCalendarDate(now)

  const cursorBefore = { sortDate: null, jobId: null }
  let leaseFenceToken = null
  let leaseExpiresAt = null
  let scanCycleId = null
  let scanAnchorDate = anchorDate
  let cursorAfter = { ...cursorBefore }
  let blocked = false
  let blockedReason = null
  let cycleCompleted = false
  let hasMore = false
  let runStatus = 'completed'
  let lastError = null

  const jobResults = []
  let wouldBootstrapCount = 0
  let wouldTransitionCount = 0
  let wouldEvidenceMutationCount = 0

  try {
    const acquired = await acquireRuntimeLease(supabase, {
      pollRunId,
      requestedScanCycleId,
      anchorDate,
      windowDays,
      leaseTtlSeconds,
    })

    if (acquired?.status === 'LEASE_BUSY') {
      return {
        ok: true,
        engine: 'runtime_v1',
        stage: 'report_only',
        pollRunId,
        scanCycleId: null,
        scanAnchorDate: anchorDate,
        leaseFenceToken: acquired.lease_fence_token ?? null,
        cursorBefore,
        cursorAfter,
        jobsReturned: 0,
        jobsProcessed: 0,
        hasMore: false,
        cycleCompleted: false,
        blocked: true,
        blockedReason: 'LEASE_BUSY',
        wouldBootstrapCount: 0,
        wouldTransitionCount: 0,
        wouldEvidenceMutationCount: 0,
        eventsCreated: 0,
        telegramSent: 0,
        jobResults: [],
      }
    }

    if (!acquired || !['ACQUIRED', 'ALREADY_ACQUIRED'].includes(acquired.status)) {
      const error = new Error(acquired?.status || 'lease acquire failed')
      error.code = 'DATABASE_ERROR'
      throw error
    }

    leaseFenceToken = acquired.lease_fence_token
    leaseExpiresAt = acquired.lease_expires_at
    scanCycleId = acquired.scan_cycle_id
    scanAnchorDate = acquired.scan_anchor_date || anchorDate
    cursorBefore.sortDate = acquired.cursor_sort_date || null
    cursorBefore.jobId = acquired.cursor_job_id || null
    cursorAfter = { ...cursorBefore }

    const pageLimit = maxJobs + 1
    const rows = await listJobsForPollPage(supabase, {
      scanCycleId,
      cursorSortDate: cursorBefore.sortDate,
      cursorJobId: cursorBefore.jobId,
      limit: pageLimit,
    })

    const page = Array.isArray(rows) ? rows : []
    hasMore = page.length > maxJobs
    const processable = hasMore ? page.slice(0, maxJobs) : page

    for (const job of processable) {
      if (leaseNeedsRenewal(leaseExpiresAt, new Date())) {
        const renewed = await renewRuntimeLease(supabase, {
          pollRunId,
          leaseFenceToken,
          leaseTtlSeconds,
        })
        if (renewed?.status !== 'RENEWED') {
          blocked = true
          blockedReason = 'LEASE_LOST'
          runStatus = 'blocked'
          lastError = 'LEASE_LOST'
          break
        }
        leaseExpiresAt = renewed.lease_expires_at
      }

      // SNAP-08: immutable membership; live cancelled/hidden/inactive → skip + advance
      let liveJob
      try {
        liveJob = await readLiveJobEligibility(supabase, job.job_id)
      } catch (err) {
        blocked = true
        blockedReason = 'DATABASE_ERROR'
        runStatus = 'blocked'
        lastError = err.message
        jobResults.push({
          jobId: job.job_id,
          crmsId: job.crms_id,
          sortDate: job.sort_date,
          disposition: 'DATABASE_ERROR',
          warnings: [err.message],
          wouldActions: [],
        })
        break
      }

      if (!isJobEligibleForAlertPoll(liveJob || {
        crms_id: job.crms_id,
        status: job.status,
        hidden_from_schedule: job.hidden_from_schedule,
        rms_visibility_status: job.rms_visibility_status,
      })) {
        jobResults.push({
          jobId: job.job_id,
          crmsId: job.crms_id,
          sortDate: job.sort_date,
          disposition: OBSERVATION_DISPOSITIONS.SKIPPED_INELIGIBLE,
          warnings: [],
          wouldActions: [],
        })

        const advancedSkip = await advanceRuntimeCursor(supabase, {
          pollRunId,
          leaseFenceToken,
          scanCycleId,
          cursorSortDate: job.sort_date,
          cursorJobId: job.job_id,
        })
        if (!advancedSkip || !['ADVANCED', 'ALREADY_ADVANCED'].includes(advancedSkip.status)) {
          blocked = true
          blockedReason = advancedSkip?.status === 'LEASE_LOST' ? 'LEASE_LOST'
            : advancedSkip?.status === 'CURSOR_CONFLICT' ? 'CURSOR_CONFLICT'
              : 'DATABASE_ERROR'
          runStatus = 'blocked'
          lastError = blockedReason
          break
        }
        cursorAfter = {
          sortDate: advancedSkip.cursor_sort_date,
          jobId: advancedSkip.cursor_job_id,
        }
        continue
      }

      let jobState
      let baselineItems
      try {
        jobState = await readAlertJobState(supabase, job.job_id)
        baselineItems = await readAlertItemStates(supabase, job.job_id)
      } catch (err) {
        blocked = true
        blockedReason = 'DATABASE_ERROR'
        runStatus = 'blocked'
        lastError = err.message
        jobResults.push({
          jobId: job.job_id,
          crmsId: job.crms_id,
          sortDate: job.sort_date,
          disposition: 'DATABASE_ERROR',
          warnings: [err.message],
          wouldActions: [],
        })
        break
      }

      const jobInitialized = Boolean(jobState?.initialized_at)
      const observation = await observeJobFromCurrentRms({
        job: {
          id: job.job_id,
          crms_id: job.crms_id || liveJob?.crms_id,
          status: liveJob?.status ?? job.status,
          hidden_from_schedule: liveJob?.hidden_from_schedule ?? job.hidden_from_schedule,
          rms_visibility_status: liveJob?.rms_visibility_status ?? job.rms_visibility_status,
        },
        presentBaselineItems: baselineItems,
        jobInitialized,
        fetchImpl,
      })

      let wouldActions = []
      if (observation.disposition === OBSERVATION_DISPOSITIONS.QUALIFIED) {
        try {
          wouldActions = await simulateWouldActions({
            supabase,
            pollRunId,
            observation,
            baselineItems,
            jobInitialized,
          })
        } catch (err) {
          blocked = true
          blockedReason = 'DATABASE_ERROR'
          runStatus = 'blocked'
          lastError = err.message
          jobResults.push({
            jobId: job.job_id,
            crmsId: job.crms_id,
            sortDate: job.sort_date,
            disposition: 'DATABASE_ERROR',
            warnings: [err.message],
            wouldActions: [],
          })
          break
        }
      }

      jobResults.push({
        jobId: job.job_id,
        crmsId: job.crms_id,
        sortDate: job.sort_date,
        disposition: observation.disposition,
        warnings: observation.warnings || [],
        wouldActions,
      })

      wouldBootstrapCount += wouldActions.filter((a) => a.type === 'WOULD_BOOTSTRAP').length
      wouldEvidenceMutationCount += wouldActions.filter((a) =>
        [
          'WOULD_CLEAR_MISSING_CANDIDATE',
          'WOULD_RECORD_FIRST_MISSING',
          'WOULD_RECORD_SECOND_MISSING',
        ].includes(a.type),
      ).length
      wouldTransitionCount += wouldActions.filter((a) =>
        [
          'WOULD_ADD_ITEM',
          'WOULD_CHANGE_QUANTITY',
          'WOULD_CHANGE_METADATA',
          'WOULD_REMOVE_ITEM',
          'WOULD_REAPPEAR',
        ].includes(a.type),
      ).length

      if (UNRESOLVED_DISPOSITIONS.has(observation.disposition)) {
        blocked = true
        blockedReason = observation.disposition
        runStatus = 'blocked'
        lastError = observation.disposition
        break
      }

      const advanced = await advanceRuntimeCursor(supabase, {
        pollRunId,
        leaseFenceToken,
        scanCycleId,
        cursorSortDate: job.sort_date,
        cursorJobId: job.job_id,
      })

      if (advanced?.status === 'LEASE_LOST') {
        blocked = true
        blockedReason = 'LEASE_LOST'
        runStatus = 'blocked'
        lastError = 'LEASE_LOST'
        break
      }
      if (advanced?.status === 'CURSOR_CONFLICT') {
        blocked = true
        blockedReason = 'CURSOR_CONFLICT'
        runStatus = 'blocked'
        lastError = 'CURSOR_CONFLICT'
        break
      }
      if (!advanced || !['ADVANCED', 'ALREADY_ADVANCED'].includes(advanced.status)) {
        blocked = true
        blockedReason = 'DATABASE_ERROR'
        runStatus = 'blocked'
        lastError = advanced?.status || 'cursor advance failed'
        break
      }

      cursorAfter = {
        sortDate: advanced.cursor_sort_date,
        jobId: advanced.cursor_job_id,
      }
    }

    if (!blocked && !hasMore) {
      const completed = await completeRuntimeScanCycle(supabase, {
        pollRunId,
        leaseFenceToken,
        scanCycleId,
      })
      if (completed?.status === 'CYCLE_COMPLETED') {
        cycleCompleted = true
        cursorAfter = { sortDate: null, jobId: null }
      } else if (completed?.status === 'LEASE_LOST') {
        blocked = true
        blockedReason = 'LEASE_LOST'
        runStatus = 'blocked'
      }
    } else if (!blocked && hasMore) {
      runStatus = 'partial'
    }
  } catch (err) {
    blocked = true
    blockedReason = err.code || 'DATABASE_ERROR'
    runStatus = 'failed'
    lastError = err.message
    if (err.statusCode) {
      throw err
    }
  } finally {
    if (leaseFenceToken != null) {
      try {
        await releaseRuntimeLease(supabase, {
          pollRunId,
          leaseFenceToken,
          runStatus,
          lastError,
        })
      } catch {
        // release best-effort; Stage 1 report still returns
      }
    }
  }

  return {
    ok: true,
    engine: 'runtime_v1',
    stage: 'report_only',
    pollRunId,
    scanCycleId,
    scanAnchorDate,
    leaseFenceToken,
    cursorBefore,
    cursorAfter,
    jobsReturned: jobResults.length,
    jobsProcessed: jobResults.length,
    hasMore: blocked ? false : hasMore,
    cycleCompleted,
    blocked,
    blockedReason,
    wouldBootstrapCount,
    wouldTransitionCount,
    wouldEvidenceMutationCount,
    eventsCreated: 0,
    telegramSent: 0,
    jobResults,
  }
}

export const __testables = {
  clampLeaseTtl,
  leaseNeedsRenewal,
  UNRESOLVED_DISPOSITIONS,
  countWould,
}

// Server-only automatic RMS polling helpers (report-only foundation).
// Never import from frontend/src code.

import { reconcileJobItemsFromRms } from './crmsItemReconcile.js'
import {
  buildOperationalItemChangeEventRows,
  isAllowedOperationalEventSource,
} from './operationalChangeEvents.js'
import { shouldSendTelegramForEvent } from './telegramAlerts.js'

export const AUTO_POLL_DEFAULT_WINDOW_DAYS = 14
export const AUTO_POLL_DEFAULT_MAX_JOBS = 25
export const AUTO_POLL_MAX_JOBS_CAP = 40
export const AUTO_POLL_DEFAULT_CONCURRENCY = 2
export const AUTO_POLL_MAX_CONCURRENCY = 4
export const AUTO_POLL_OPERATIONAL_SOURCE = 'global_sync'

export function isAutoPollMode(body) {
  return String(body?.mode || '').trim().toLowerCase() === 'auto_poll_rms'
}

export function isCronAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  const authHeader = req.headers.authorization || ''
  return authHeader === `Bearer ${cronSecret}`
}

function toDateOnly(value) {
  if (!value) return null
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

export function getForwardWindowDates(windowDays = AUTO_POLL_DEFAULT_WINDOW_DAYS) {
  const today = new Date()
  const windowStart = today.toISOString().slice(0, 10)
  const end = new Date(today)
  end.setDate(end.getDate() + Math.max(1, windowDays))
  const windowEnd = end.toISOString().slice(0, 10)
  return { windowStart, windowEnd }
}

export function jobInForwardWindow(job, windowStart, windowEnd) {
  const dates = [job?.event_date, job?.delivery_date, job?.collection_date].filter(Boolean)
  if (!dates.length) return false

  return dates.some((dateValue) => {
    const dateOnly = toDateOnly(dateValue)
    if (!dateOnly) return false
    return dateOnly >= windowStart && dateOnly <= windowEnd
  })
}

export function parseAutoPollOptions(body = {}) {
  const apply = body?.apply === true
  const windowDaysRaw = Number.parseInt(body?.windowDays, 10)
  const windowDays = Number.isFinite(windowDaysRaw) && windowDaysRaw > 0
    ? windowDaysRaw
    : AUTO_POLL_DEFAULT_WINDOW_DAYS

  const maxJobsRaw = Number.parseInt(body?.maxJobs, 10)
  const maxJobs = Number.isFinite(maxJobsRaw) && maxJobsRaw > 0
    ? Math.min(maxJobsRaw, AUTO_POLL_MAX_JOBS_CAP)
    : AUTO_POLL_DEFAULT_MAX_JOBS

  const concurrencyRaw = Number.parseInt(body?.concurrency, 10)
  const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0
    ? Math.min(concurrencyRaw, AUTO_POLL_MAX_CONCURRENCY)
    : AUTO_POLL_DEFAULT_CONCURRENCY

  const { windowStart, windowEnd } = getForwardWindowDates(windowDays)

  return {
    apply,
    dryRun: !apply,
    windowDays,
    windowStart,
    windowEnd,
    maxJobs,
    concurrency,
  }
}

export async function fetchAutoPollScopedJobs(supabase, { windowStart, windowEnd, maxJobs }) {
  const { data, error } = await supabase
    .from('crms_jobs')
    .select('id, crms_id, crms_ref, event_name, delivery_date, event_date, collection_date, status, hidden_from_schedule, rms_visibility_status')
    .not('crms_id', 'is', null)
    .eq('hidden_from_schedule', false)
    .neq('status', 'cancelled')

  if (error) throw new Error(error.message)

  const inWindow = (data || []).filter((job) => {
    if (!job?.crms_id) return false
    if (job.hidden_from_schedule) return false
    if (job.status === 'cancelled') return false
    if (job.rms_visibility_status && job.rms_visibility_status !== 'active') return false
    return jobInForwardWindow(job, windowStart, windowEnd)
  })

  const jobs = inWindow.slice(0, maxJobs)

  return {
    jobs,
    totalMatching: inWindow.length,
    truncated: inWindow.length > maxJobs,
  }
}

export function countItemChangesFromDiff(diff) {
  if (!diff) return 0
  return (diff.added?.length || 0) + (diff.changed?.length || 0) + (diff.stale?.length || 0)
}

export function estimateOperationalNotifications({ job, diff, source = AUTO_POLL_OPERATIONAL_SOURCE }) {
  if (!isAllowedOperationalEventSource(source)) {
    return { eventsWouldCreate: 0, telegramWouldSend: 0 }
  }

  const rows = buildOperationalItemChangeEventRows({ job, diff, source })
  const eventsWouldCreate = rows.length
  const telegramWouldSend = rows.filter((row) =>
    shouldSendTelegramForEvent({
      change_type: row.change_type,
      payload: {},
    }),
  ).length

  return { eventsWouldCreate, telegramWouldSend }
}

async function runWithConcurrency(items, limit, worker) {
  if (!items.length) return []
  const results = new Array(items.length)
  let nextIndex = 0

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  }

  const poolSize = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()))
  return results
}

function mergeJobWarnings(job, warnings = []) {
  const ref = job.crms_ref || job.event_name || job.id
  return warnings.map((w) => `[${ref}] ${w}`)
}

export async function runAutoPollRms({ supabase, body = {} }) {
  const started = Date.now()
  const options = parseAutoPollOptions(body)

  if (options.apply) {
    const error = new Error('auto_poll_rms apply mode is not enabled yet. Use apply: false.')
    error.statusCode = 400
    throw error
  }

  const { jobs, totalMatching, truncated } = await fetchAutoPollScopedJobs(supabase, {
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    maxJobs: options.maxJobs,
  })

  const jobResults = await runWithConcurrency(jobs, options.concurrency, async (job) => {
    try {
      const result = await reconcileJobItemsFromRms({
        supabase,
        oppId: job.crms_id,
        jobUuid: job.id,
        dryRun: true,
        operationalEventSource: null,
      })

      const itemChangesDetected = countItemChangesFromDiff(result.diff)
      const estimates = estimateOperationalNotifications({
        job,
        diff: result.diff,
        source: AUTO_POLL_OPERATIONAL_SOURCE,
      })

      return {
        ok: true,
        job,
        result,
        itemChangesDetected,
        ...estimates,
      }
    } catch (jobErr) {
      return {
        ok: false,
        job,
        error: jobErr.message || 'Reconcile failed',
      }
    }
  })

  const aggregate = {
    ok: true,
    mode: 'auto_poll_rms',
    dryRun: true,
    apply: false,
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    windowDays: options.windowDays,
    maxJobs: options.maxJobs,
    concurrency: options.concurrency,
    jobsScanned: jobs.length,
    jobsSucceeded: 0,
    jobsFailed: 0,
    jobsChanged: 0,
    itemChangesDetected: 0,
    eventsWouldCreate: 0,
    telegramWouldSend: 0,
    eventsCreated: 0,
    telegramSent: 0,
    warnings: [],
    errors: [],
    durationMs: 0,
    truncated,
    totalMatching,
  }

  for (const row of jobResults) {
    if (!row.ok) {
      aggregate.jobsFailed += 1
      aggregate.errors.push({
        job_id: row.job.id,
        crms_ref: row.job.crms_ref || null,
        message: row.error,
      })
      continue
    }

    aggregate.itemChangesDetected += row.itemChangesDetected || 0
    aggregate.eventsWouldCreate += row.eventsWouldCreate || 0
    aggregate.telegramWouldSend += row.telegramWouldSend || 0

    if (row.itemChangesDetected > 0) {
      aggregate.jobsChanged += 1
    }

    if (row.result?.warnings?.length) {
      aggregate.warnings.push(...mergeJobWarnings(row.job, row.result.warnings))
    }

    aggregate.jobsSucceeded += 1
  }

  aggregate.durationMs = Date.now() - started
  return aggregate
}

// POST /api/admin-sync-inventory — batch RMS opportunity_items reconcile for Inventory.
// Auth: Supabase user JWT (admin/operations). Does not modify api/sync.js.

import { reconcileJobItemsFromRms } from './lib/crmsItemReconcile.js'
import { HttpError, requireAdminOrOperations } from './lib/adminAuth.js'

const DEFAULT_WINDOW_START = '2026-01-01'
const DEFAULT_MAX_JOBS = 100
const RECONCILE_CONCURRENCY = 4

function parseRequestBody(req) {
  try {
    if (!req.body) return {}
    if (typeof req.body === 'string') return JSON.parse(req.body)
    return req.body
  } catch {
    const error = new Error('Invalid JSON body.')
    error.statusCode = 400
    throw error
  }
}

function jobInOperationalWindow(job, windowStart) {
  const dates = [job.delivery_date, job.event_date, job.collection_date].filter(Boolean)
  if (!dates.length) return false
  return dates.some(d => String(d) >= windowStart)
}

async function fetchScopedJobs(supabase, { windowStart, maxJobs }) {
  const { data, error } = await supabase
    .from('crms_jobs')
    .select('id, crms_id, crms_ref, event_name, delivery_date, event_date, collection_date, status')
    .not('crms_id', 'is', null)
    .eq('hidden_from_schedule', false)
    .neq('status', 'cancelled')
    .order('delivery_date', { ascending: false, nullsFirst: false })

  if (error) throw new Error(error.message)

  const inWindow = (data || []).filter(job => jobInOperationalWindow(job, windowStart))
  const jobs = inWindow.slice(0, maxJobs)

  return {
    jobs,
    totalMatching: inWindow.length,
    truncated: inWindow.length > maxJobs,
  }
}

function mergeJobWarnings(job, warnings = []) {
  const ref = job.crms_ref || job.event_name || job.id
  return warnings.map(w => `[${ref}] ${w}`)
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const started = Date.now()

  try {
    const { supabase } = await requireAdminOrOperations(req)
    const body = parseRequestBody(req)

    const apply = body?.apply === true || body?.dryRun === false
    const dryRun = !apply

    const windowStart = String(body?.windowStart || DEFAULT_WINDOW_START).trim() || DEFAULT_WINDOW_START
    const maxJobsRaw = Number.parseInt(body?.maxJobs, 10)
    const maxJobs = Number.isFinite(maxJobsRaw) && maxJobsRaw > 0
      ? Math.min(maxJobsRaw, 500)
      : DEFAULT_MAX_JOBS

    const { jobs, totalMatching, truncated } = await fetchScopedJobs(supabase, { windowStart, maxJobs })

    const jobResults = await runWithConcurrency(jobs, RECONCILE_CONCURRENCY, async (job) => {
      try {
        const result = await reconcileJobItemsFromRms({
          supabase,
          oppId: job.crms_id,
          jobUuid: job.id,
          dryRun,
        })
        return { ok: true, job, result }
      } catch (jobErr) {
        return {
          ok: false,
          job,
          error: jobErr.message || 'Reconcile failed',
        }
      }
    })

    const aggregate = {
      success: true,
      dryRun,
      windowStart,
      maxJobs,
      jobsScanned: jobs.length,
      jobsSucceeded: 0,
      jobsFailed: 0,
      itemsFetched: 0,
      itemsAdded: 0,
      itemsChanged: 0,
      itemsStale: 0,
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

      const stats = row.result.stats || {}
      aggregate.itemsFetched += stats.fetchedFromRms || 0
      aggregate.itemsAdded += stats.addedFound || 0
      aggregate.itemsChanged += stats.changedFound || 0
      aggregate.itemsStale += stats.staleFound || 0

      if (row.result.warnings?.length) {
        aggregate.warnings.push(...mergeJobWarnings(row.job, row.result.warnings))
      }

      aggregate.jobsSucceeded += 1
    }

    aggregate.durationMs = Date.now() - started

    return res.status(200).json(aggregate)
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({
        success: false,
        error: err.message,
        durationMs: Date.now() - started,
      })
    }

    const statusCode = err.statusCode || (String(err.message || '').includes('Current RMS') ? 502 : 500)
    return res.status(statusCode).json({
      success: false,
      error: err.message || 'admin-sync-inventory failed',
      durationMs: Date.now() - started,
    })
  }
}

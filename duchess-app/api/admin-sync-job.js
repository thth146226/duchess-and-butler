// POST /api/admin-sync-job — admin/operations RMS reconciliation.
// Per-job refresh (default) or batch inventory refresh when body.mode === 'inventory'.
// Auth: Supabase user JWT (not CRON_SECRET). Dry-run by default.

import { findJobByIdentifier, reconcileJobItemsFromRms } from '../server-lib/crmsItemReconcile.js'
import { HttpError, requireAdminOrOperations } from '../server-lib/adminAuth.js'

const INVENTORY_DEFAULT_WINDOW_START = '2026-01-01'
const INVENTORY_DEFAULT_MAX_JOBS = 100
const INVENTORY_RECONCILE_CONCURRENCY = 4

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

function isInventoryMode(body) {
  const marker = String(body?.mode || body?.scope || '').trim().toLowerCase()
  return marker === 'inventory'
}

function normOptionalString(value) {
  if (value == null) return ''
  const trimmed = String(value).trim()
  return trimmed || ''
}

function pickIdentifier(body) {
  const identifiers = {
    crms_ref: normOptionalString(body?.crms_ref),
    job_id: normOptionalString(body?.job_id),
    crms_id: normOptionalString(body?.crms_id),
  }

  const provided = Object.entries(identifiers).filter(([, value]) => value)
  if (provided.length !== 1) {
    const error = new Error('Provide exactly one identifier: crms_ref, job_id, or crms_id.')
    error.statusCode = 400
    throw error
  }

  const [key, value] = provided[0]
  return { [key]: value }
}

function jobInOperationalWindow(job, windowStart) {
  const dates = [job.delivery_date, job.event_date, job.collection_date].filter(Boolean)
  if (!dates.length) return false
  return dates.some(d => String(d) >= windowStart)
}

async function fetchInventoryScopedJobs(supabase, { windowStart, maxJobs }) {
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

async function handleInventoryBatch(res, { supabase, body }) {
  const started = Date.now()

  const apply = body?.apply === true || body?.dryRun === false
  const dryRun = !apply

  const windowStart = String(body?.windowStart || INVENTORY_DEFAULT_WINDOW_START).trim() || INVENTORY_DEFAULT_WINDOW_START
  const maxJobsRaw = Number.parseInt(body?.maxJobs, 10)
  const maxJobs = Number.isFinite(maxJobsRaw) && maxJobsRaw > 0
    ? Math.min(maxJobsRaw, 500)
    : INVENTORY_DEFAULT_MAX_JOBS

  const { jobs, totalMatching, truncated } = await fetchInventoryScopedJobs(supabase, { windowStart, maxJobs })

  const jobResults = await runWithConcurrency(jobs, INVENTORY_RECONCILE_CONCURRENCY, async (job) => {
    try {
      const result = await reconcileJobItemsFromRms({
        supabase,
        oppId: job.crms_id,
        jobUuid: job.id,
        dryRun,
        operationalEventSource: apply ? 'manual_rms_refresh' : null,
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
    mode: 'inventory',
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

    if (isInventoryMode(body)) {
      return handleInventoryBatch(res, { supabase, body })
    }

    const identifier = pickIdentifier(body)
    const apply = body?.apply === true
    const dryRun = !apply

    const job = await findJobByIdentifier({ supabase, ...identifier })

    if (!job) {
      return res.status(404).json({ error: 'Job not found for the provided identifier.' })
    }

    if (!job.crms_id) {
      return res.status(400).json({ error: 'Job is not an RMS job and cannot be refreshed from Current RMS.' })
    }

    const result = await reconcileJobItemsFromRms({
      supabase,
      oppId: job.crms_id,
      jobUuid: job.id,
      dryRun,
      operationalEventSource: apply ? 'manual_rms_refresh' : null,
    })

    return res.status(200).json({
      ok: result.ok,
      apply,
      dryRun,
      job: {
        id: job.id,
        crms_id: job.crms_id,
        crms_ref: job.crms_ref,
        event_name: job.event_name,
      },
      stats: result.stats,
      diff: result.diff,
      warnings: result.warnings,
      operationalEvents: result.operationalEvents ?? null,
    })
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({ error: err.message })
    }

    const statusCode = err.statusCode || (String(err.message || '').includes('Current RMS') ? 502 : 500)
    return res.status(statusCode).json({
      error: err.message || 'admin-sync-job failed',
      durationMs: Date.now() - started,
    })
  }
}

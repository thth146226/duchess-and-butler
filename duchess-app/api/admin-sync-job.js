// POST /api/admin-sync-job — per-job RMS reconciliation for admin/operations UI.
// Auth: Supabase user JWT (not CRON_SECRET). Dry-run by default.

import { findJobByIdentifier, reconcileJobItemsFromRms } from './lib/crmsItemReconcile.js'
import { HttpError, requireAdminOrOperations } from './lib/adminAuth.js'

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { supabase } = await requireAdminOrOperations(req)
    const body = parseRequestBody(req)
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
    })
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({ error: err.message })
    }

    const statusCode = err.statusCode || (String(err.message || '').includes('Current RMS') ? 502 : 500)
    return res.status(statusCode).json({
      error: err.message || 'admin-sync-job failed',
    })
  }
}

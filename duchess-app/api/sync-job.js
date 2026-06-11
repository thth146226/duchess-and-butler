// POST /api/sync-job — per-job RMS item reconciliation (dry-run by default).
// Phase 1A: does not modify global /api/sync behavior.

import { createClient } from '@supabase/supabase-js'
import { findJobByIdentifier, reconcileJobItemsFromRms } from '../server-lib/crmsItemReconcile.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  return authHeader === `Bearer ${cronSecret}`
}

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

function normOptionalString(value) {
  if (value == null) return ''
  const trimmed = String(value).trim()
  return trimmed || ''
}

function getSupabaseAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase server credentials are not configured.')
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'Server sync-job auth is not configured.' })
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized sync-job trigger' })
  }

  try {
    const body = parseRequestBody(req)
    const identifier = pickIdentifier(body)
    const apply = body?.apply === true
    const dryRun = apply ? false : true

    const supabase = getSupabaseAdminClient()
    const job = await findJobByIdentifier({ supabase, ...identifier })

    if (!job) {
      return res.status(404).json({ error: 'Job not found for the provided identifier.' })
    }

    if (!job.crms_id) {
      return res.status(400).json({ error: 'Job is missing crms_id and cannot be reconciled with RMS.' })
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
    const statusCode = err.statusCode || (String(err.message || '').includes('Current RMS') ? 502 : 500)
    return res.status(statusCode).json({
      error: err.message || 'sync-job failed',
    })
  }
}

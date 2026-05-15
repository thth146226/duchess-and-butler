import { supabase } from './supabase'

export async function refreshJobFromRms({ job_id, crms_ref, crms_id, apply = false } = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  const token = session?.access_token
  if (!token) {
    throw new Error('Session expired. Please reload and sign in again.')
  }

  const body = { apply: apply === true }
  if (job_id) body.job_id = job_id
  else if (crms_ref) body.crms_ref = crms_ref
  else if (crms_id) body.crms_id = crms_id
  else {
    throw new Error('Provide job_id, crms_ref, or crms_id.')
  }

  const res = await fetch('/api/admin-sync-job', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  let json = {}
  try {
    json = await res.json()
  } catch {
    json = {}
  }

  if (!res.ok) {
    throw new Error(json.error || 'RMS refresh failed.')
  }

  return json
}

export function canRefreshFromRmsRole(role) {
  return role === 'admin' || role === 'operations'
}

export function hasRmsJobId(job) {
  return Boolean(job?.crms_id)
}

export function countRmsRefreshChanges(stats) {
  if (!stats) return 0
  return (stats.addedFound || 0) + (stats.changedFound || 0) + (stats.staleFound || 0)
}

export function isApplyBlockedByWarnings(stats, warnings = []) {
  if (!stats) return true
  if ((stats.fetchedFromRms || 0) === 0) return true

  const list = Array.isArray(warnings) ? warnings : []
  const blockedPatterns = [
    /zero opportunity_items/i,
    /stale ratio/i,
    /exceeds.*threshold/i,
    /apply aborted/i,
  ]

  return list.some((warning) =>
    blockedPatterns.some((pattern) => pattern.test(String(warning))),
  )
}

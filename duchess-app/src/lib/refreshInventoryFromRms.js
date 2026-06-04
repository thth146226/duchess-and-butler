import { supabase } from './supabase'

export { canRefreshFromRmsRole as canRefreshInventoryFromRms } from './refreshJobFromRms'

export function countInventoryRefreshChanges(data) {
  if (!data) return 0
  return (data.itemsAdded || 0) + (data.itemsChanged || 0) + (data.itemsStale || 0)
}

export function hasInventoryApplyBlockers(data) {
  const warnings = data?.warnings || []
  if (!warnings.length) return false
  const blockedPatterns = [
    /zero opportunity_items while local items exist/i,
    /stale ratio/i,
    /apply aborted/i,
  ]
  return warnings.some(w =>
    blockedPatterns.some(pattern => pattern.test(String(w))),
  )
}

export async function refreshInventoryFromRms({
  dryRun = true,
  apply = false,
  windowStart,
  maxJobs,
} = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  const token = session?.access_token
  if (!token) {
    throw new Error('Session expired. Please reload and sign in again.')
  }

  const body = { mode: 'inventory' }
  if (apply) {
    body.apply = true
    body.dryRun = false
  } else {
    body.dryRun = dryRun !== false
  }
  if (windowStart) body.windowStart = windowStart
  if (maxJobs != null) body.maxJobs = maxJobs

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
    throw new Error(json.error || 'Inventory RMS refresh failed.')
  }

  return json
}

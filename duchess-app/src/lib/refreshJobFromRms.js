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

export function isZeroRmsItemsBlocked(stats, warnings = []) {
  if ((stats?.fetchedFromRms || 0) === 0) return true
  const list = Array.isArray(warnings) ? warnings : []
  return list.some((warning) => /zero opportunity_items/i.test(String(warning)))
}

export function isApplyBlockedByWarnings(stats, warnings = []) {
  if (!stats) return true
  if (isZeroRmsItemsBlocked(stats, warnings)) return true

  const list = Array.isArray(warnings) ? warnings : []
  const blockedPatterns = [
    /stale ratio/i,
    /exceeds.*threshold/i,
    /apply aborted/i,
  ]

  return list.some((warning) =>
    blockedPatterns.some((pattern) => pattern.test(String(warning))),
  )
}

/** Dry-run scan with one retry when RMS returns zero items (check phase only). */
export async function dryRunScanJobFromRms(job) {
  let result = await refreshJobFromRms({ job_id: job.id, apply: false })
  let row = classifyRmsRefreshScanResult({ result, job })

  if (row.status === 'blocked' && isZeroRmsItemsBlocked(result?.stats, result?.warnings)) {
    result = await refreshJobFromRms({ job_id: job.id, apply: false })
    row = classifyRmsRefreshScanResult({ result, job })
  }

  return { result, row }
}

export function classifyRmsRefreshScanResult({ result, error, job } = {}) {
  if (job && !hasRmsJobId(job)) {
    return {
      status: 'skipped',
      job,
      changeCount: 0,
      stats: null,
      warnings: [],
      errorMessage: null,
    }
  }

  if (error) {
    const errorMessage = typeof error === 'string' ? error : error?.message || 'RMS refresh failed.'
    return {
      status: 'error',
      job,
      changeCount: 0,
      stats: null,
      warnings: [],
      errorMessage,
    }
  }

  const stats = result?.stats || null
  const warnings = result?.warnings || []
  const changeCount = countRmsRefreshChanges(stats)
  const blocked = isApplyBlockedByWarnings(stats, warnings)

  if (blocked) {
    return {
      status: 'blocked',
      job,
      changeCount,
      stats,
      warnings,
      errorMessage: null,
    }
  }

  if (changeCount === 0) {
    return {
      status: 'upToDate',
      job,
      changeCount: 0,
      stats,
      warnings,
      errorMessage: null,
    }
  }

  return {
    status: 'needsRefresh',
    job,
    changeCount,
    stats,
    warnings,
    errorMessage: null,
  }
}

export function isSafeToApply(scanResult) {
  return scanResult?.status === 'needsRefresh'
}

export async function runWithConcurrency(items, limit, worker) {
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

export const RMS_STATUS_META = {
  notChecked: {
    label: 'Not checked',
    bg: '#F3F4F6',
    color: '#6B6860',
    barColor: '#E5E7EB',
  },
  upToDate: {
    label: 'Up to date',
    bg: '#EAF3DE',
    color: '#3B6D11',
    barColor: '#86EFAC',
  },
  needsRefresh: {
    label: 'Needs refresh',
    bg: '#FEF3C7',
    color: '#854F0B',
    barColor: '#FDE68A',
  },
  blocked: {
    label: 'Blocked',
    bg: '#FCEBEB',
    color: '#A32D2D',
    barColor: '#FCA5A5',
  },
  error: {
    label: 'Error',
    bg: '#FCEBEB',
    color: '#A32D2D',
    barColor: '#FCA5A5',
  },
  skipped: {
    label: 'Skipped non-RMS',
    bg: '#F3F4F6',
    color: '#6B6860',
    barColor: '#E5E7EB',
  },
}

export function buildVisibleJobsFingerprint(jobs = []) {
  return [...jobs]
    .map((job) => job.id)
    .filter(Boolean)
    .sort()
    .join('|')
}

export function buildScanResultsByJobId(scanResultsArray = []) {
  const byJobId = {}
  for (const row of scanResultsArray) {
    const id = row?.job?.id
    if (id) byJobId[id] = row
  }
  return byJobId
}

export function summariseScanResults(scanResults = []) {
  const summary = {
    totalChecked: 0,
    upToDate: 0,
    needsRefresh: 0,
    blocked: 0,
    errors: 0,
    skipped: 0,
  }

  for (const row of scanResults) {
    if (row.status === 'skipped') {
      summary.skipped += 1
      continue
    }
    summary.totalChecked += 1
    if (row.status === 'upToDate') summary.upToDate += 1
    else if (row.status === 'needsRefresh') summary.needsRefresh += 1
    else if (row.status === 'blocked') summary.blocked += 1
    else if (row.status === 'error') summary.errors += 1
  }

  return summary
}

export function formatRmsRowStatusDetail(scanResult) {
  if (!scanResult) return null

  const { status, stats, warnings, errorMessage } = scanResult

  if (status === 'upToDate') return 'Up to date'
  if (status === 'skipped') return 'Skipped non-RMS'

  if (status === 'needsRefresh' && stats) {
    const parts = []
    const stale = stats.staleFound || 0
    const changed = stats.changedFound || 0
    const added = stats.addedFound || 0
    if (stale > 0) parts.push(`${stale} stale`)
    if (changed > 0) parts.push(`${changed} changed`)
    if (added > 0) parts.push(`${added} added`)
    const counts = parts.length ? parts.join(' · ') : 'changes detected'
    return `Needs refresh · ${counts}`
  }

  if (status === 'blocked') {
    if (isZeroRmsItemsBlocked(stats, warnings)) {
      return 'Blocked · RMS returned zero items during this check. Recheck before applying.'
    }
    const warning = warnings?.[0]
    if (warning) {
      const text = String(warning)
      return `Blocked · Safety stop — ${text.length > 56 ? `${text.slice(0, 56)}…` : text}`
    }
    return 'Blocked · Safety stop — manual review required before applying.'
  }

  if (status === 'error') {
    const text = errorMessage || 'See details'
    return `Error · ${text.length > 72 ? `${text.slice(0, 72)}…` : text}`
  }

  return null
}

export function matchesRmsListFilter(scanResult, filter) {
  if (filter === 'all') return true
  if (!scanResult) return false

  if (filter === 'needsRefresh') return scanResult.status === 'needsRefresh'
  if (filter === 'issues') return scanResult.status === 'blocked' || scanResult.status === 'error'
  if (filter === 'upToDate') return scanResult.status === 'upToDate'

  return true
}

export function getRmsRowTintStyle(scanResult) {
  const status = scanResult?.status || 'notChecked'

  if (status === 'needsRefresh') {
    return { background: '#FFFBF3', boxShadow: 'inset 3px 0 0 #FDE68A' }
  }

  if (status === 'blocked' || status === 'error') {
    return { background: '#FEF7F7', boxShadow: 'inset 3px 0 0 #FCA5A5' }
  }

  return {}
}

export function countRmsFilterMatches(jobs, byJobId, filter) {
  if (filter === 'all') return jobs.length
  return jobs.filter((job) => matchesRmsListFilter(byJobId[job.id], filter)).length
}

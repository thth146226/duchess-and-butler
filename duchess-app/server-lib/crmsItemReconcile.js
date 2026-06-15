// Per-job Current RMS opportunity_items reconciliation (upsert + scoped prune).
// Copied mapItem/crmsGet patterns from api/sync.js — global sync unchanged in Phase 1A.

import { createOperationalItemChangeEvents } from './operationalChangeEvents.js'

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const CRMS_BASE = 'https://api.current-rms.com/api/v1'

const STALE_RATIO_ABORT_THRESHOLD = 0.8

function crmsHeaders() {
  return {
    'X-AUTH-TOKEN': CRMS_API_KEY,
    'X-SUBDOMAIN': CRMS_SUBDOMAIN,
    'Content-Type': 'application/json',
  }
}

async function crmsGet(path, params = {}) {
  const url = new URL(`${CRMS_BASE}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url.toString(), { headers: crmsHeaders() })
  if (!res.ok) throw new Error(`Current RMS ${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

function mapItem(item, crmsOpportunityId, jobId) {
  return {
    job_id: jobId ? String(jobId) : null,
    crms_opportunity_id: String(crmsOpportunityId),
    crms_item_id: String(item.id),
    item_name: item.product_name || item.name || '',
    category: item.product_group_name || item.category || 'other',
    quantity: parseInt(item.quantity || item.quantity_reserved || 0, 10),
    unit: item.rental_price_name || 'unit',
    item_type: item.type_name || 'rental',
    crms_raw: item,
  }
}

function normText(value) {
  return String(value ?? '').trim()
}

function normQty(value) {
  const qty = Number.parseInt(value, 10)
  return Number.isFinite(qty) ? qty : 0
}

function hasCrmsItemId(value) {
  return normText(value).length > 0
}

function toSafeLocalRow(row) {
  return {
    id: row.id,
    job_id: row.job_id,
    crms_opportunity_id: row.crms_opportunity_id,
    crms_item_id: row.crms_item_id,
    item_name: row.item_name,
    quantity: row.quantity,
    category: row.category,
  }
}

function toSafeRmsRow(row) {
  return {
    crms_item_id: row.crms_item_id,
    item_name: row.item_name,
    quantity: row.quantity,
    category: row.category,
  }
}

function fieldsDiffer(localRow, rmsRow) {
  return (
    normText(localRow.item_name) !== normText(rmsRow.item_name) ||
    normQty(localRow.quantity) !== normQty(rmsRow.quantity) ||
    normText(localRow.category) !== normText(rmsRow.category)
  )
}

export async function findJobByIdentifier({ supabase, crms_ref, job_id, crms_id }) {
  const select = 'id, crms_id, crms_ref, event_name'

  if (crms_ref) {
    const { data, error } = await supabase
      .from('crms_jobs')
      .select(select)
      .eq('crms_ref', normText(crms_ref))
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data || null
  }

  if (job_id) {
    const { data, error } = await supabase
      .from('crms_jobs')
      .select(select)
      .eq('id', normText(job_id))
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data || null
  }

  if (crms_id) {
    const { data, error } = await supabase
      .from('crms_jobs')
      .select(select)
      .eq('crms_id', normText(crms_id))
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data || null
  }

  return null
}

export async function reconcileJobItemsFromRms({
  supabase,
  oppId,
  jobUuid,
  dryRun = true,
  operationalEventSource = null,
}) {
  if (!CRMS_API_KEY || !CRMS_SUBDOMAIN) {
    throw new Error('Current RMS credentials are not configured.')
  }

  const warnings = []
  const oppIdStr = String(oppId)
  const jobUuidStr = String(jobUuid)

  const data = await crmsGet(`/opportunities/${oppIdStr}/opportunity_items`)
  if (!data || typeof data !== 'object') {
    throw new Error('Current RMS returned an invalid opportunity_items payload.')
  }

  const rawItems = data.opportunity_items ?? data.items
  if (!Array.isArray(rawItems)) {
    throw new Error('Current RMS opportunity_items is not an array.')
  }

  const rmsRows = rawItems.map(item => mapItem(item, oppIdStr, jobUuidStr))
  const rmsById = new Map()
  for (const row of rmsRows) {
    if (hasCrmsItemId(row.crms_item_id)) rmsById.set(String(row.crms_item_id), row)
  }

  const { data: localRows, error: localError } = await supabase
    .from('crms_job_items')
    .select('id, job_id, crms_opportunity_id, crms_item_id, item_name, quantity, category')
    .eq('job_id', jobUuidStr)

  if (localError) throw new Error(localError.message)

  const local = localRows || []
  const localKeyed = local.filter(row => hasCrmsItemId(row.crms_item_id))
  const ignoredLocal = local
    .filter(row => !hasCrmsItemId(row.crms_item_id))
    .map(toSafeLocalRow)

  const localById = new Map()
  for (const row of localKeyed) localById.set(String(row.crms_item_id), row)

  const added = []
  const changed = []
  let unchangedCount = 0

  for (const [crmsItemId, rmsRow] of rmsById.entries()) {
    const localRow = localById.get(crmsItemId)
    if (!localRow) {
      added.push(toSafeRmsRow(rmsRow))
      continue
    }
    if (fieldsDiffer(localRow, rmsRow)) {
      changed.push({
        crms_item_id: crmsItemId,
        local: toSafeLocalRow(localRow),
        rms: toSafeRmsRow(rmsRow),
      })
    } else {
      unchangedCount += 1
    }
  }

  const stale = localKeyed
    .filter(row => !rmsById.has(String(row.crms_item_id)))
    .map(toSafeLocalRow)

  const existingLocal = local.length
  const staleFound = stale.length
  const fetchedFromRms = rmsRows.length

  if (fetchedFromRms === 0) {
    if (existingLocal > 0) {
      warnings.push('RMS returned zero opportunity_items while local items exist; delete aborted.')
    } else {
      warnings.push('RMS returned zero opportunity_items; no local items exist, skipped safely.')
    }
  }

  const staleRatio = existingLocal > 0 ? staleFound / existingLocal : 0
  const staleRatioAbort = existingLocal > 0 && staleRatio > STALE_RATIO_ABORT_THRESHOLD
  if (staleRatioAbort) {
    warnings.push(
      `Stale ratio ${(staleRatio * 100).toFixed(1)}% exceeds ${STALE_RATIO_ABORT_THRESHOLD * 100}% threshold; apply aborted.`
    )
  }

  const stats = {
    fetchedFromRms,
    existingLocal,
    upserted: 0,
    staleFound,
    staleRemoved: 0,
    changedFound: changed.length,
    addedFound: added.length,
    unchangedCount,
    dryRun: !!dryRun,
  }

  const diff = {
    added,
    changed,
    stale,
    ignoredLocal,
    unchangedCount,
  }

  const canApply =
    dryRun === false &&
    fetchedFromRms > 0 &&
    !staleRatioAbort

  if (!canApply) {
    return { ok: true, stats, diff, warnings }
  }

  const { error: upsertError } = await supabase
    .from('crms_job_items')
    .upsert(rmsRows, { onConflict: 'crms_opportunity_id,crms_item_id', ignoreDuplicates: false })

  if (upsertError) throw new Error(upsertError.message)

  stats.upserted = rmsRows.length

  if (staleFound > 0) {
    const staleIds = stale.map(row => row.id).filter(Boolean)
    const { error: deleteError } = await supabase
      .from('crms_job_items')
      .delete()
      .eq('job_id', jobUuidStr)
      .in('id', staleIds)

    if (deleteError) throw new Error(deleteError.message)
    stats.staleRemoved = staleIds.length
  }

  let operationalEvents = null
  if (operationalEventSource === 'manual_rms_refresh') {
    const { data: jobRow } = await supabase
      .from('crms_jobs')
      .select('id, crms_id, crms_ref, event_name')
      .eq('id', jobUuidStr)
      .maybeSingle()

    if (jobRow) {
      operationalEvents = await createOperationalItemChangeEvents({
        supabase,
        job: jobRow,
        diff,
        source: operationalEventSource,
      })
    } else {
      operationalEvents = {
        enabled: false,
        attempted: 0,
        insertedOrUpserted: 0,
        skipped: 0,
        errors: ['Job metadata not found for operational change events.'],
      }
    }
  }

  return { ok: true, stats, diff, warnings, operationalEvents }
}

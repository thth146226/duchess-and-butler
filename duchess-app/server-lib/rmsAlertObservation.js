// Server-only Current RMS observation + completeness classification (Commit 2).
// Never import from frontend/src code.
// Does not write crms_job_items, alert baseline, events, or Telegram.

export const RMS_ALERT_OBSERVATION_COLLAPSE_THRESHOLD_V1 = 0.80

const CRMS_BASE = 'https://api.current-rms.com/api/v1'

export const OBSERVATION_DISPOSITIONS = Object.freeze({
  FETCH_ERROR: 'FETCH_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  BLOCKED_ZERO_ITEMS: 'BLOCKED_ZERO_ITEMS',
  OBSERVATION_SUSPECT: 'OBSERVATION_SUSPECT',
  SOURCE_DISAPPEARED: 'SOURCE_DISAPPEARED',
  SKIPPED_INELIGIBLE: 'SKIPPED_INELIGIBLE',
  QUALIFIED: 'QUALIFIED',
})

function getCrmsCredentials() {
  return {
    apiKey: process.env.CRMS_API_KEY,
    subdomain: process.env.CRMS_SUBDOMAIN,
  }
}

function normText(value) {
  return String(value ?? '').trim()
}

function parseQuantity(value) {
  if (value == null || value === '') return { ok: false }
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false }
  return { ok: true, quantity: n }
}

export function normalizeObservedItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return { ok: false, error: 'item is not an object' }
  }

  const crmsItemId = normText(rawItem.id ?? rawItem.crms_item_id)
  if (!crmsItemId) {
    return { ok: false, error: 'crms_item_id required' }
  }

  const qtySource = rawItem.quantity ?? rawItem.quantity_reserved
  const qtyParsed = parseQuantity(qtySource)
  if (!qtyParsed.ok) {
    return { ok: false, error: 'invalid quantity' }
  }

  return {
    ok: true,
    item: {
      crms_item_id: crmsItemId,
      item_name: normText(rawItem.product_name || rawItem.name || rawItem.item_name || ''),
      item_category: normText(
        rawItem.product_group_name || rawItem.category || rawItem.item_category || 'other',
      ) || 'other',
      quantity: qtyParsed.quantity,
    },
  }
}

export function parseOpportunityItemsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, disposition: OBSERVATION_DISPOSITIONS.PARSE_ERROR, error: 'payload not object' }
  }

  const rawItems = payload.opportunity_items ?? payload.items
  if (!Array.isArray(rawItems)) {
    return { ok: false, disposition: OBSERVATION_DISPOSITIONS.PARSE_ERROR, error: 'items not array' }
  }

  const items = []
  const seen = new Set()

  for (const raw of rawItems) {
    const normalized = normalizeObservedItem(raw)
    if (!normalized.ok) {
      return {
        ok: false,
        disposition: OBSERVATION_DISPOSITIONS.PARSE_ERROR,
        error: normalized.error,
      }
    }
    if (seen.has(normalized.item.crms_item_id)) {
      return {
        ok: false,
        disposition: OBSERVATION_DISPOSITIONS.PARSE_ERROR,
        error: 'duplicate crms_item_id',
      }
    }
    seen.add(normalized.item.crms_item_id)
    items.push(normalized.item)
  }

  return { ok: true, items }
}

export function isJobEligibleForAlertPoll(job) {
  if (!job) return false
  if (!normText(job.crms_id)) return false
  if (job.hidden_from_schedule) return false
  if (String(job.status || '') === 'cancelled') return false
  if (job.rms_visibility_status && job.rms_visibility_status !== 'active') return false
  return true
}

/**
 * Classify a fully parsed observation against present alert-baseline rows.
 * presentBaselineItems: array of { crms_item_id, is_present, ... }
 */
export function classifyParsedObservation({
  items,
  presentBaselineItems = [],
  jobInitialized = false,
}) {
  const observedCount = items.length

  if (observedCount === 0) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.BLOCKED_ZERO_ITEMS,
      observed_count: 0,
      present_baseline_count: presentBaselineItems.filter((r) => r.is_present === true).length,
      missing_count: 0,
      missing_ratio: 0,
      items: [],
    }
  }

  if (!jobInitialized) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
      observed_count: observedCount,
      present_baseline_count: 0,
      missing_count: 0,
      missing_ratio: 0,
      items,
    }
  }

  const present = presentBaselineItems.filter((r) => r.is_present === true)
  const presentBaselineCount = present.length
  const observedIds = new Set(items.map((i) => i.crms_item_id))
  const missingCount = present.filter((r) => !observedIds.has(String(r.crms_item_id))).length
  const missingRatio = presentBaselineCount > 0 ? missingCount / presentBaselineCount : 0

  if (
    presentBaselineCount > 0
    && missingRatio > RMS_ALERT_OBSERVATION_COLLAPSE_THRESHOLD_V1
  ) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.OBSERVATION_SUSPECT,
      observed_count: observedCount,
      present_baseline_count: presentBaselineCount,
      missing_count: missingCount,
      missing_ratio: missingRatio,
      items,
    }
  }

  return {
    disposition: OBSERVATION_DISPOSITIONS.QUALIFIED,
    observed_count: observedCount,
    present_baseline_count: presentBaselineCount,
    missing_count: missingCount,
    missing_ratio: missingRatio,
    items,
  }
}

export async function fetchCurrentRmsOpportunityItems(oppId, { fetchImpl = globalThis.fetch } = {}) {
  const { apiKey, subdomain } = getCrmsCredentials()
  if (!apiKey || !subdomain) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.FETCH_ERROR,
      error: 'Current RMS credentials are not configured.',
      items: [],
    }
  }

  if (!fetchImpl) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.FETCH_ERROR,
      error: 'Fetch is not available.',
      items: [],
    }
  }

  const oppIdStr = String(oppId)
  const url = `${CRMS_BASE}/opportunities/${encodeURIComponent(oppIdStr)}/opportunity_items`

  let response
  try {
    response = await fetchImpl(url, {
      headers: {
        'X-AUTH-TOKEN': apiKey,
        'X-SUBDOMAIN': subdomain,
        'Content-Type': 'application/json',
      },
    })
  } catch (err) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.FETCH_ERROR,
      error: err?.message || 'Current RMS network error',
      items: [],
    }
  }

  if (response.status === 404) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.SOURCE_DISAPPEARED,
      error: 'Current RMS opportunity not found',
      items: [],
      httpStatus: 404,
    }
  }

  if (!response.ok) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.FETCH_ERROR,
      error: `Current RMS opportunity_items → ${response.status} ${response.statusText || ''}`.trim(),
      items: [],
      httpStatus: response.status,
    }
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    return {
      disposition: OBSERVATION_DISPOSITIONS.PARSE_ERROR,
      error: 'Current RMS returned non-JSON body',
      items: [],
    }
  }

  const parsed = parseOpportunityItemsPayload(payload)
  if (!parsed.ok) {
    return {
      disposition: parsed.disposition,
      error: parsed.error,
      items: [],
    }
  }

  return {
    disposition: null,
    items: parsed.items,
    error: null,
  }
}

/**
 * End-to-end observation for one job against alert baseline presence rows.
 */
export async function observeJobFromCurrentRms({
  job,
  presentBaselineItems = [],
  jobInitialized = false,
  fetchImpl = globalThis.fetch,
}) {
  if (!isJobEligibleForAlertPoll(job)) {
    return {
      disposition: OBSERVATION_DISPOSITIONS.SKIPPED_INELIGIBLE,
      items: [],
      observed_count: 0,
      present_baseline_count: 0,
      missing_count: 0,
      missing_ratio: 0,
      warnings: [],
    }
  }

  const fetched = await fetchCurrentRmsOpportunityItems(job.crms_id, { fetchImpl })
  if (fetched.disposition) {
    return {
      disposition: fetched.disposition,
      items: [],
      observed_count: 0,
      present_baseline_count: presentBaselineItems.filter((r) => r.is_present === true).length,
      missing_count: 0,
      missing_ratio: 0,
      warnings: fetched.error ? [fetched.error] : [],
      error: fetched.error || null,
    }
  }

  return {
    ...classifyParsedObservation({
      items: fetched.items,
      presentBaselineItems,
      jobInitialized,
    }),
    warnings: [],
    error: null,
  }
}

import { HttpError } from './adminAuth.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuidString(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim())
}

export function parseAcknowledgeBody(body, { maxBatchSize = 50 } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('Invalid request body.', 400)
  }

  const action = String(body.action || '').trim()
  if (action !== 'acknowledge') {
    throw new HttpError('Unsupported action. Use action: "acknowledge".', 400)
  }

  if (!Array.isArray(body.eventIds)) {
    throw new HttpError('eventIds must be an array.', 400)
  }

  if (body.eventIds.length < 1) {
    throw new HttpError('eventIds must contain at least one id.', 400)
  }

  if (body.eventIds.length > maxBatchSize) {
    throw new HttpError(`eventIds cannot exceed ${maxBatchSize} items.`, 400)
  }

  const dedupedIds = []
  const seen = new Set()

  for (const rawId of body.eventIds) {
    if (!isUuidString(rawId)) {
      throw new HttpError('Every eventIds entry must be a valid UUID string.', 400)
    }

    const id = rawId.trim()
    if (seen.has(id)) continue
    seen.add(id)
    dedupedIds.push(id)
  }

  return { action, eventIds: dedupedIds }
}

export async function acknowledgeOperationalChangeEvents({ supabase, userId, eventIds }) {
  if (!supabase) {
    throw new Error('Supabase client is required.')
  }

  if (!userId) {
    throw new HttpError('Unauthorised', 401)
  }

  const ids = Array.isArray(eventIds) ? eventIds : []
  if (ids.length === 0) {
    return {
      ok: true,
      updatedCount: 0,
      updatedIds: [],
      skippedCount: 0,
    }
  }

  const acknowledgedAt = new Date().toISOString()

  const { data, error } = await supabase
    .from('operational_change_events')
    .update({
      acknowledged_at: acknowledgedAt,
      acknowledged_by: userId,
    })
    .in('id', ids)
    .is('acknowledged_at', null)
    .select('id, acknowledged_at, acknowledged_by')

  if (error) {
    throw new Error(error.message || 'Failed to acknowledge operational change events.')
  }

  const updatedRows = data || []
  const updatedIds = updatedRows.map((row) => row.id)

  return {
    ok: true,
    updatedCount: updatedIds.length,
    updatedIds,
    skippedCount: ids.length - updatedIds.length,
  }
}

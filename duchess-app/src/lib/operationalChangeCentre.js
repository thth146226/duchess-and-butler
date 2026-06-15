const ITEM_CHANGE_TYPES = new Set([
  'item_added',
  'item_quantity_changed',
  'item_removed',
  'item_changed',
])

export const OPERATIONAL_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unacknowledged', label: 'Unacknowledged' },
  { id: 'today', label: 'Today' },
  { id: 'next7days', label: 'Next 7 days' },
  { id: 'item_changes', label: 'Item changes' },
]

export function getOrderGroupKey(event) {
  const ref = String(event?.job_ref || '').trim()
  if (ref) return ref
  const crmsId = String(event?.crms_id || '').trim()
  if (crmsId) return `crms:${crmsId}`
  const name = String(event?.event_name || '').trim()
  if (name) return `event:${name}`
  return `unknown:${event?.id || 'event'}`
}

export function formatSourceLabel(source) {
  if (source === 'manual_rms_refresh') return 'Refresh from RMS'
  if (source === 'global_sync') return 'Global sync'
  if (source === 'backfill') return 'Backfill'
  if (source === 'system') return 'System'
  return source || 'Unknown source'
}

export function formatQuantityDelta(delta) {
  if (delta == null || Number.isNaN(Number(delta))) return ''
  const n = Number(delta)
  if (n > 0) return `+${n}`
  return String(n)
}

export const QUANTITY_DELTA_TONE_STYLES = {
  positive: {
    background: '#EAF3DE',
    color: '#2F5F0C',
    border: '1px solid #C8DEB0',
  },
  negative: {
    background: '#FCEBEB',
    color: '#A32D2D',
    border: '1px solid #F5C2C2',
  },
  neutral: {
    background: '#F1EFE8',
    color: '#6B6860',
    border: '1px solid #DDD8CF',
  },
}

export function getQuantityDeltaPresentation(delta) {
  if (delta == null || Number.isNaN(Number(delta))) {
    return { label: '', visible: false, tone: 'neutral' }
  }

  const n = Number(delta)
  if (n === 0) {
    return { label: '0', visible: false, tone: 'neutral' }
  }

  const label = formatQuantityDelta(n)
  const tone = n > 0 ? 'positive' : 'negative'
  return { label, visible: true, tone }
}

export function quantityDeltaBadgeStyle(tone) {
  return QUANTITY_DELTA_TONE_STYLES[tone] || QUANTITY_DELTA_TONE_STYLES.neutral
}

export function formatChangeTypeLabel(changeType) {
  switch (changeType) {
    case 'item_quantity_changed':
      return 'Quantity changed'
    case 'item_added':
      return 'Item added'
    case 'item_removed':
      return 'Item removed'
    case 'item_changed':
      return 'Item changed'
    default:
      return String(changeType || 'Change').replace(/_/g, ' ')
  }
}

export function formatEventSummary(event) {
  const itemName = event?.item_name || 'Item'
  const typeLabel = formatChangeTypeLabel(event?.change_type)

  if (event?.change_type === 'item_quantity_changed') {
    return `${typeLabel}: ${itemName}`
  }

  if (event?.change_type === 'item_added') {
    const qty = event?.new_quantity != null ? ` × ${event.new_quantity}` : ''
    return `${typeLabel}: ${itemName}${qty}`
  }

  if (event?.change_type === 'item_removed') {
    const qty = event?.old_quantity != null ? ` × ${event.old_quantity}` : ''
    return `${typeLabel}: ${itemName}${qty}`
  }

  if (event?.change_type === 'item_changed') {
    const from = event?.old_value || '—'
    const to = event?.new_value || '—'
    return `${typeLabel}: ${itemName} — ${from} → ${to}`
  }

  return `${typeLabel}: ${itemName}`
}

export function getJobDateCandidates(job) {
  if (!job) return []
  return [job.event_date, job.delivery_date, job.collection_date].filter(Boolean)
}

export function hasJobDateMetadata(job) {
  return getJobDateCandidates(job).length > 0
}

function toDateOnly(value) {
  if (!value) return null
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

export function isDetectedToday(detectedAt, todayIso) {
  const detectedDate = toDateOnly(detectedAt)
  return Boolean(detectedDate && todayIso && detectedDate === todayIso)
}

export function isJobWithinNext7Days(job, todayIso) {
  if (!hasJobDateMetadata(job) || !todayIso) return false
  const start = new Date(`${todayIso}T12:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  const endIso = end.toISOString().slice(0, 10)

  return getJobDateCandidates(job).some((dateValue) => {
    const dateOnly = toDateOnly(dateValue)
    if (!dateOnly) return false
    return dateOnly >= todayIso && dateOnly <= endIso
  })
}

export function groupOperationalEvents(events = [], jobsById = {}) {
  const groups = new Map()

  for (const event of events) {
    const groupKey = getOrderGroupKey(event)
    if (!groups.has(groupKey)) {
      const job = event?.job_id ? jobsById[event.job_id] : null
      groups.set(groupKey, {
        groupKey,
        jobRef: event?.job_ref || null,
        crmsId: event?.crms_id || null,
        eventName: event?.event_name || 'Unknown event',
        job,
        events: [],
      })
    }
    groups.get(groupKey).events.push(event)
  }

  return [...groups.values()]
    .map((group) => {
      const sortedEvents = [...group.events].sort(
        (a, b) => new Date(b.detected_at) - new Date(a.detected_at),
      )
      const latestDetectedAt = sortedEvents[0]?.detected_at || null
      const hasUnacknowledged = sortedEvents.some((event) => !event.acknowledged_at)
      const sources = [...new Set(sortedEvents.map((event) => event.source).filter(Boolean))]

      return {
        ...group,
        events: sortedEvents,
        eventCount: sortedEvents.length,
        latestDetectedAt,
        statusLabel: hasUnacknowledged ? 'Unacknowledged' : 'Acknowledged',
        hasUnacknowledged,
        sourceLabel: sources.map(formatSourceLabel).join(', ') || 'Refresh from RMS',
      }
    })
    .sort((a, b) => new Date(b.latestDetectedAt) - new Date(a.latestDetectedAt))
}

export function filterOperationalGroups(groups = [], filter = 'all', { todayIso } = {}) {
  if (filter === 'all') return groups

  return groups.filter((group) => {
    if (filter === 'unacknowledged') return group.hasUnacknowledged
    if (filter === 'today') {
      return group.events.some((event) => isDetectedToday(event.detected_at, todayIso))
    }
    if (filter === 'next7days') {
      return isJobWithinNext7Days(group.job, todayIso)
    }
    if (filter === 'item_changes') {
      return group.events.some((event) => ITEM_CHANGE_TYPES.has(event.change_type))
    }
    return true
  })
}

function whatsappEventLines(events = []) {
  const lines = []

  for (const event of events) {
    const itemName = event?.item_name || 'Item'

    if (event.change_type === 'item_quantity_changed') {
      const oldQty = event?.old_quantity ?? '—'
      const newQty = event?.new_quantity ?? '—'
      const delta = formatQuantityDelta(event?.quantity_delta)
      lines.push(`• ${itemName}: ${oldQty} → ${newQty}${delta ? ` (${delta})` : ''}`)
      continue
    }

    if (event.change_type === 'item_added') {
      const qty = event?.new_quantity != null ? ` × ${event.new_quantity}` : ''
      lines.push(`• ${itemName} added${qty}`)
      continue
    }

    if (event.change_type === 'item_removed') {
      const qty = event?.old_quantity != null ? ` × ${event.old_quantity}` : ''
      lines.push(`• ${itemName} removed${qty}`)
      continue
    }

    if (event.change_type === 'item_changed') {
      const from = event?.old_value || '—'
      const to = event?.new_value || '—'
      lines.push(`• ${itemName}: ${from} → ${to}`)
      continue
    }

    lines.push(`• ${formatEventSummary(event)}`)
  }

  return lines
}

export function buildWhatsAppUpdate(group) {
  const ref = group?.jobRef || group?.crmsId || 'Order'
  const title = group?.eventName || 'Order update'
  const source = formatSourceLabel(group?.events?.[0]?.source || 'manual_rms_refresh')
  const lines = whatsappEventLines(group?.events || [])

  const quantityLines = (group?.events || [])
    .filter((event) => event.change_type === 'item_quantity_changed')
    .map((event) => {
      const itemName = event?.item_name || 'Item'
      const oldQty = event?.old_quantity ?? '—'
      const newQty = event?.new_quantity ?? '—'
      const delta = formatQuantityDelta(event?.quantity_delta)
      return `• ${itemName}: ${oldQty} → ${newQty}${delta ? ` (${delta})` : ''}`
    })

  const bodyLines = quantityLines.length > 0
    ? ['Item quantity changed:', ...quantityLines]
    : ['Item changes:', ...lines]

  return [
    `⚠️ Order update — ${ref}`,
    title,
    '',
    ...bodyLines,
    '',
    `Source: ${source}`,
    'Please update picking/packing/team plan.',
  ].join('\n')
}

export function groupsMissingJobDateMetadata(groups = []) {
  if (!groups.length) return false
  return groups.some((group) => !hasJobDateMetadata(group.job))
}

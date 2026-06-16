const TELEGRAM_MAX_LENGTH = 4096
const TRUNCATION_RESERVE = 80

const TELEGRAM_CHANGE_TYPES = new Set([
  'item_quantity_changed',
  'item_added',
  'item_removed',
])

function formatSourceLabel(source) {
  if (source === 'manual_rms_refresh') return 'Refresh from RMS'
  if (source === 'global_sync') return 'Global sync'
  if (source === 'backfill') return 'Backfill'
  if (source === 'system') return 'System'
  return source || 'Unknown source'
}

function formatQuantityDelta(delta) {
  if (delta == null || Number.isNaN(Number(delta))) return ''
  const n = Number(delta)
  if (n > 0) return `+${n}`
  return String(n)
}

function itemLabel(event) {
  const name = String(event?.item_name || '').trim()
  return name || 'Unknown item'
}

function quantityChangedLine(event) {
  const itemName = itemLabel(event)
  const oldQty = event?.old_quantity ?? '—'
  const newQty = event?.new_quantity ?? '—'
  const delta = formatQuantityDelta(event?.quantity_delta)
  return `• ${itemName}: ${oldQty} → ${newQty}${delta ? ` (${delta})` : ''}`
}

function itemAddedLine(event) {
  const itemName = itemLabel(event)
  const qty = event?.new_quantity != null ? ` ${event.new_quantity}` : ''
  return `• ${itemName}: added qty${qty}`
}

function itemRemovedLine(event) {
  const itemName = itemLabel(event)
  const qty = event?.old_quantity != null ? ` ${event.old_quantity}` : ''
  return `• ${itemName}: removed qty${qty}`
}

function buildBodyLines(events = []) {
  const quantityEvents = events.filter((e) => e.change_type === 'item_quantity_changed')
  const addedEvents = events.filter((e) => e.change_type === 'item_added')
  const removedEvents = events.filter((e) => e.change_type === 'item_removed')

  const lines = []

  if (quantityEvents.length > 0) {
    lines.push('Item quantity changed:')
    for (const event of quantityEvents) {
      lines.push(quantityChangedLine(event))
    }
  }

  if (addedEvents.length > 0) {
    lines.push('Item added:')
    for (const event of addedEvents) {
      lines.push(itemAddedLine(event))
    }
  }

  if (removedEvents.length > 0) {
    lines.push('Item removed:')
    for (const event of removedEvents) {
      lines.push(itemRemovedLine(event))
    }
  }

  return lines
}

function truncateMessage(text, hiddenCount) {
  if (!hiddenCount || hiddenCount <= 0) return text
  const suffix = `\n+${hiddenCount} more changes`
  const maxBody = TELEGRAM_MAX_LENGTH - TRUNCATION_RESERVE - suffix.length
  if (text.length <= maxBody) return text + suffix
  return `${text.slice(0, maxBody).trimEnd()}\n${suffix}`
}

export function buildOperationalAlertMessage({ job, events = [], appUrl = '' } = {}) {
  const alertEvents = events.filter((event) => TELEGRAM_CHANGE_TYPES.has(event?.change_type))
  const ref = job?.job_ref || job?.crms_ref || job?.crms_id || 'Order'
  const title = job?.event_name || alertEvents[0]?.event_name || 'Order update'
  const source = formatSourceLabel(alertEvents[0]?.source || 'manual_rms_refresh')

  const bodyLines = buildBodyLines(alertEvents)
  const footer = [
    `Source: ${source}`,
    'Please update picking/packing/team plan.',
    'Acknowledge in Duchess App.',
  ]

  const normalizedAppUrl = String(appUrl || '').trim().replace(/\/$/, '')
  if (normalizedAppUrl) {
    footer.push(`Open in Duchess App: ${normalizedAppUrl}`)
  }

  const maxLines = 40
  const visibleLines = bodyLines.slice(0, maxLines)
  const hiddenLineCount = Math.max(0, bodyLines.length - visibleLines.length)

  const parts = [
    `⚠️ Order update — ${ref}`,
    title,
    '',
    ...visibleLines,
    '',
    ...footer,
  ]

  let text = parts.join('\n')
  if (hiddenLineCount > 0) {
    text = truncateMessage(text, hiddenLineCount)
  } else if (text.length > TELEGRAM_MAX_LENGTH) {
    text = truncateMessage(text, 0).slice(0, TELEGRAM_MAX_LENGTH)
  }

  return text
}

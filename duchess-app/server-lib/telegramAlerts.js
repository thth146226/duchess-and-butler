import { buildOperationalAlertMessage } from './operationalAlertMessage.js'

const TELEGRAM_SEND_TYPES = new Set([
  'item_quantity_changed',
  'item_added',
  'item_removed',
])

const TELEGRAM_TIMEOUT_MS = 10000

export function isTelegramAlertsEnabled() {
  return process.env.TELEGRAM_ALERTS_ENABLED === 'true'
}

export function shouldSendTelegramForEvent(event) {
  if (!event || !TELEGRAM_SEND_TYPES.has(event.change_type)) {
    return false
  }

  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
  if (payload?.telegram?.sent_at) {
    return false
  }

  return true
}

function getTelegramConfig() {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
  const chatId = String(process.env.TELEGRAM_ALERT_CHAT_ID || '').trim()
  const appUrl = String(process.env.DUCHESS_APP_URL || '').trim()

  return { botToken, chatId, appUrl }
}

async function fetchWithTimeout(url, options, fetchImpl, timeoutMs = TELEGRAM_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function sendTelegramMessage({
  text,
  chatId,
  botToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!botToken || !chatId) {
    return { ok: false, messageId: null, error: 'Telegram bot token or chat id is not configured.' }
  }

  if (!fetchImpl) {
    return { ok: false, messageId: null, error: 'Fetch is not available.' }
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  })

  let lastError = 'Telegram send failed.'

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        fetchImpl,
      )

      let json = {}
      try {
        json = await response.json()
      } catch {
        json = {}
      }

      if (response.ok && json?.ok) {
        return {
          ok: true,
          messageId: json?.result?.message_id ?? null,
          error: null,
          attemptCount: attempt,
        }
      }

      lastError = json?.description || json?.error || `Telegram API returned status ${response.status}.`
    } catch (err) {
      lastError = err?.name === 'AbortError'
        ? 'Telegram request timed out.'
        : (err?.message || 'Telegram send failed.')
    }
  }

  return {
    ok: false,
    messageId: null,
    error: lastError,
    attemptCount: 2,
  }
}

async function updateEventTelegramPayload({
  supabase,
  event,
  chatId,
  marker,
}) {
  if (!supabase || !event?.id) return

  const existingPayload = event?.payload && typeof event.payload === 'object'
    ? { ...event.payload }
    : {}

  const nextPayload = {
    ...existingPayload,
    telegram: marker,
  }

  await supabase
    .from('operational_change_events')
    .update({ payload: nextPayload })
    .eq('id', event.id)
}

export async function sendOperationalTelegramAlerts({
  supabase,
  job,
  events = [],
  fetchImpl = globalThis.fetch,
}) {
  const baseResult = {
    enabled: isTelegramAlertsEnabled(),
    attempted: 0,
    sent: 0,
    skipped: 0,
    errors: [],
  }

  if (!baseResult.enabled) {
    return {
      ...baseResult,
      skipped: events.length,
    }
  }

  const { botToken, chatId, appUrl } = getTelegramConfig()
  if (!botToken || !chatId) {
    return {
      ...baseResult,
      skipped: events.length,
      errors: ['Telegram alerts are enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID is missing.'],
    }
  }

  const sendable = []
  let skipped = 0

  for (const event of events) {
    if (shouldSendTelegramForEvent(event)) {
      sendable.push(event)
    } else {
      skipped += 1
    }
  }

  if (sendable.length === 0) {
    return {
      ...baseResult,
      skipped,
    }
  }

  const text = buildOperationalAlertMessage({ job, events: sendable, appUrl })
  const sendResult = await sendTelegramMessage({
    text,
    chatId,
    botToken,
    fetchImpl,
  })

  const attemptCount = sendResult.attemptCount || 1

  if (sendResult.ok) {
    const sentAt = new Date().toISOString()
    for (const event of sendable) {
      await updateEventTelegramPayload({
        supabase,
        event,
        chatId,
        marker: {
          sent_at: sentAt,
          message_id: sendResult.messageId,
          chat_id: chatId,
          attempt_count: attemptCount,
          last_error: null,
        },
      })
    }

    return {
      enabled: true,
      attempted: sendable.length,
      sent: sendable.length,
      skipped,
      errors: [],
    }
  }

  for (const event of sendable) {
    await updateEventTelegramPayload({
      supabase,
      event,
      chatId,
      marker: {
        sent_at: null,
        message_id: null,
        chat_id: chatId,
        attempt_count: attemptCount,
        last_error: sendResult.error || 'Telegram send failed.',
      },
    })
  }

  return {
    enabled: true,
    attempted: sendable.length,
    sent: 0,
    skipped,
    errors: [sendResult.error || 'Telegram send failed.'],
  }
}

import {
  isTelegramAlertsEnabled,
  sendOperationalTelegramAlerts,
  sendTelegramMessage,
  shouldSendTelegramForEvent,
} from '../../server-lib/telegramAlerts.js'

const JOB = {
  id: '11111111-1111-1111-1111-111111111111',
  crms_ref: 'QDB07915',
  event_name: 'Test Event',
}

function makeEvent(overrides = {}) {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    job_ref: 'QDB07915',
    event_name: 'Test Event',
    change_type: 'item_quantity_changed',
    source: 'manual_rms_refresh',
    item_name: 'Plate',
    old_quantity: 50,
    new_quantity: 60,
    quantity_delta: 10,
    payload: { crms_item_id: '55' },
    ...overrides,
  }
}

describe('telegramAlerts', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    jest.restoreAllMocks()
  })

  test('shouldSendTelegramForEvent skips item_changed', () => {
    expect(shouldSendTelegramForEvent({
      change_type: 'item_changed',
      payload: {},
    })).toBe(false)
  })

  test('shouldSendTelegramForEvent skips when telegram already sent', () => {
    expect(shouldSendTelegramForEvent({
      change_type: 'item_quantity_changed',
      payload: { telegram: { sent_at: '2026-06-15T10:00:00Z' } },
    })).toBe(false)
  })

  test('disabled env results in no fetch', async () => {
    delete process.env.TELEGRAM_ALERTS_ENABLED
    const fetchImpl = jest.fn()

    const result = await sendOperationalTelegramAlerts({
      supabase: { from: jest.fn() },
      job: JOB,
      events: [makeEvent()],
      fetchImpl,
    })

    expect(isTelegramAlertsEnabled()).toBe(false)
    expect(result).toEqual({
      enabled: false,
      attempted: 0,
      sent: 0,
      skipped: 1,
      errors: [],
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('missing env while enabled returns error without throwing', async () => {
    process.env.TELEGRAM_ALERTS_ENABLED = 'true'
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_ALERT_CHAT_ID

    const fetchImpl = jest.fn()
    const result = await sendOperationalTelegramAlerts({
      supabase: { from: jest.fn() },
      job: JOB,
      events: [makeEvent()],
      fetchImpl,
    })

    expect(result.enabled).toBe(true)
    expect(result.sent).toBe(0)
    expect(result.errors[0]).toMatch(/TELEGRAM_BOT_TOKEN|TELEGRAM_ALERT_CHAT_ID/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('Telegram API failure returns structured error without throwing', async () => {
    process.env.TELEGRAM_ALERTS_ENABLED = 'true'
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    process.env.TELEGRAM_ALERT_CHAT_ID = '-100123'

    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'Bad Request' }),
    })

    const update = jest.fn().mockResolvedValue({ error: null })
    const eq = jest.fn(() => ({ error: null }))
    const supabase = {
      from: jest.fn(() => ({
        update: jest.fn(() => ({ eq })),
      })),
    }

    const result = await sendOperationalTelegramAlerts({
      supabase,
      job: JOB,
      events: [makeEvent()],
      fetchImpl,
    })

    expect(result.sent).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(fetchImpl).toHaveBeenCalled()
  })

  test('empty events list sends nothing', async () => {
    process.env.TELEGRAM_ALERTS_ENABLED = 'true'
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    process.env.TELEGRAM_ALERT_CHAT_ID = '-100123'

    const fetchImpl = jest.fn()
    const result = await sendOperationalTelegramAlerts({
      supabase: { from: jest.fn() },
      job: JOB,
      events: [],
      fetchImpl,
    })

    expect(result).toMatchObject({
      enabled: true,
      attempted: 0,
      sent: 0,
      skipped: 0,
      errors: [],
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('delivery marker merge preserves existing payload fields', async () => {
    process.env.TELEGRAM_ALERTS_ENABLED = 'true'
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    process.env.TELEGRAM_ALERT_CHAT_ID = '-100123'

    const event = makeEvent({ payload: { crms_item_id: '55', extra: 'keep-me' } })
    const updatePayload = jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) })
    const supabase = {
      from: jest.fn(() => ({ update: updatePayload })),
    }

    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 99 } }),
    })

    const result = await sendOperationalTelegramAlerts({
      supabase,
      job: JOB,
      events: [event],
      fetchImpl,
    })

    expect(result.sent).toBe(1)
    expect(updatePayload).toHaveBeenCalledWith({
      payload: {
        crms_item_id: '55',
        extra: 'keep-me',
        telegram: {
          sent_at: expect.any(String),
          message_id: 99,
          chat_id: '-100123',
          attempt_count: 1,
          last_error: null,
        },
      },
    })
  })

  test('sendTelegramMessage retries once then fails', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, description: 'Server error' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, description: 'Server error' }),
      })

    const result = await sendTelegramMessage({
      text: 'hello',
      chatId: '-100123',
      botToken: 'token',
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    expect(result.attemptCount).toBe(2)
  })
})

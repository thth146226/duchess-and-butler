import { HttpError } from '../../server-lib/adminAuth.js'
import {
  acknowledgeOperationalChangeEvents,
  isUuidString,
  parseAcknowledgeBody,
} from '../../server-lib/operationalChangeAcknowledge.js'

const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

describe('operationalChangeAcknowledge', () => {
  test('isUuidString accepts valid UUID strings', () => {
    expect(isUuidString(UUID_A)).toBe(true)
    expect(isUuidString(` ${UUID_B} `)).toBe(true)
  })

  test('isUuidString rejects invalid values', () => {
    expect(isUuidString('not-a-uuid')).toBe(false)
    expect(isUuidString('')).toBe(false)
    expect(isUuidString(null)).toBe(false)
  })

  test('parseAcknowledgeBody accepts valid eventIds', () => {
    const parsed = parseAcknowledgeBody({
      action: 'acknowledge',
      eventIds: [UUID_A, UUID_B],
    })

    expect(parsed).toEqual({
      action: 'acknowledge',
      eventIds: [UUID_A, UUID_B],
    })
  })

  test('parseAcknowledgeBody dedupes duplicate ids', () => {
    const parsed = parseAcknowledgeBody({
      action: 'acknowledge',
      eventIds: [UUID_A, UUID_A, UUID_B],
    })

    expect(parsed.eventIds).toEqual([UUID_A, UUID_B])
  })

  test('parseAcknowledgeBody rejects invalid UUID', () => {
    expect(() => parseAcknowledgeBody({
      action: 'acknowledge',
      eventIds: [UUID_A, 'bad-id'],
    })).toThrow(HttpError)
  })

  test('parseAcknowledgeBody rejects empty array', () => {
    expect(() => parseAcknowledgeBody({
      action: 'acknowledge',
      eventIds: [],
    })).toThrow(HttpError)
  })

  test('parseAcknowledgeBody rejects over max batch size', () => {
    const eventIds = Array.from({ length: 51 }, (_, i) => {
      const hex = String(i).padStart(12, '0')
      return `11111111-1111-1111-1111-${hex}`
    })

    expect(() => parseAcknowledgeBody({ action: 'acknowledge', eventIds })).toThrow(HttpError)
  })

  test('parseAcknowledgeBody rejects wrong action', () => {
    expect(() => parseAcknowledgeBody({
      action: 'delete',
      eventIds: [UUID_A],
    })).toThrow(HttpError)
  })

  test('acknowledgeOperationalChangeEvents updates only unacknowledged rows', async () => {
    const select = jest.fn().mockResolvedValue({
      data: [{ id: UUID_A, acknowledged_at: '2026-06-15T12:00:00.000Z', acknowledged_by: 'user-1' }],
      error: null,
    })
    const is = jest.fn(() => ({ select }))
    const inFn = jest.fn(() => ({ is }))
    const update = jest.fn(() => ({ in: inFn }))
    const from = jest.fn(() => ({ update }))

    const supabase = { from }

    const result = await acknowledgeOperationalChangeEvents({
      supabase,
      userId: 'user-1',
      eventIds: [UUID_A, UUID_B],
    })

    expect(from).toHaveBeenCalledWith('operational_change_events')
    expect(update).toHaveBeenCalledWith({
      acknowledged_at: expect.any(String),
      acknowledged_by: 'user-1',
    })
    expect(inFn).toHaveBeenCalledWith('id', [UUID_A, UUID_B])
    expect(is).toHaveBeenCalledWith('acknowledged_at', null)
    expect(result).toEqual({
      ok: true,
      updatedCount: 1,
      updatedIds: [UUID_A],
      skippedCount: 1,
    })
  })
})

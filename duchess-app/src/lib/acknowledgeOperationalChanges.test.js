import { canAcknowledgeOperationalChanges } from './acknowledgeOperationalChanges'
import {
  buildWhatsAppUpdate,
  filterOperationalGroups,
  groupOperationalEvents,
} from './operationalChangeCentre'

const QDB07915_EVENT = {
  id: '11111111-1111-1111-1111-111111111111',
  job_id: 'job-1',
  job_ref: 'QDB07915',
  crms_id: '12345',
  event_name: 'Alison Price Ali Fortune Event Thursday 18th June 2026',
  change_type: 'item_quantity_changed',
  severity: 'high',
  source: 'manual_rms_refresh',
  item_name: 'Bronte Gold Rimmed Charger Plate',
  old_quantity: 50,
  new_quantity: 60,
  quantity_delta: 10,
  detected_at: '2026-06-15T10:00:00Z',
  acknowledged_at: null,
}

describe('acknowledgeOperationalChanges', () => {
  test('canAcknowledgeOperationalChanges allows admin and operations only', () => {
    expect(canAcknowledgeOperationalChanges('admin')).toBe(true)
    expect(canAcknowledgeOperationalChanges('operations')).toBe(true)
    expect(canAcknowledgeOperationalChanges('driver')).toBe(false)
    expect(canAcknowledgeOperationalChanges(null)).toBe(false)
  })

  test('group is acknowledged after acknowledged_at is set', () => {
    const acknowledgedEvent = {
      ...QDB07915_EVENT,
      acknowledged_at: '2026-06-15T12:00:00Z',
      acknowledged_by: 'user-1',
    }
    const groups = groupOperationalEvents([acknowledgedEvent])

    expect(groups[0].hasUnacknowledged).toBe(false)
    expect(groups[0].statusLabel).toBe('Acknowledged')

    const filtered = filterOperationalGroups(groups, 'unacknowledged', { todayIso: '2026-06-15' })
    expect(filtered).toHaveLength(0)
  })

  test('WhatsApp copy output unchanged for QDB07915', () => {
    const groups = groupOperationalEvents([QDB07915_EVENT])
    const text = buildWhatsAppUpdate(groups[0])

    expect(text).toContain('Bronte Gold Rimmed Charger Plate: 50 → 60 (+10)')
    expect(text).toContain('Source: Refresh from RMS')
  })
})

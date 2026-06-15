import {
  buildWhatsAppUpdate,
  filterOperationalGroups,
  formatEventSummary,
  formatQuantityDelta,
  getOrderGroupKey,
  groupOperationalEvents,
  hasJobDateMetadata,
  isDetectedToday,
  isJobWithinNext7Days,
} from './operationalChangeCentre'

const QDB07915_EVENT = {
  id: 'evt-1',
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

describe('operationalChangeCentre', () => {
  test('groups events by job_ref', () => {
    const groups = groupOperationalEvents([
      QDB07915_EVENT,
      { ...QDB07915_EVENT, id: 'evt-2', item_name: 'Other Item', change_type: 'item_added', new_quantity: 5 },
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].jobRef).toBe('QDB07915')
    expect(groups[0].eventCount).toBe(2)
    expect(groups[0].hasUnacknowledged).toBe(true)
  })

  test('falls back to crms_id then event_name for grouping', () => {
    const byCrms = groupOperationalEvents([{ id: '1', crms_id: '999', event_name: 'Event A', detected_at: '2026-06-15T10:00:00Z' }])
    expect(byCrms[0].groupKey).toBe('crms:999')

    const byName = groupOperationalEvents([{ id: '2', event_name: 'Only Name', detected_at: '2026-06-15T10:00:00Z' }])
    expect(byName[0].groupKey).toBe('event:Only Name')
  })

  test('formats item_quantity_changed summary', () => {
    expect(formatEventSummary(QDB07915_EVENT)).toBe(
      'Quantity changed: Bronte Gold Rimmed Charger Plate — 50 → 60 (+10)',
    )
    expect(formatQuantityDelta(10)).toBe('+10')
  })

  test('builds WhatsApp copy for QDB07915-style event', () => {
    const groups = groupOperationalEvents([QDB07915_EVENT])
    const text = buildWhatsAppUpdate(groups[0])

    expect(text).toContain('⚠️ Order update — QDB07915')
    expect(text).toContain('Alison Price Ali Fortune Event Thursday 18th June 2026')
    expect(text).toContain('Bronte Gold Rimmed Charger Plate: 50 → 60 (+10)')
    expect(text).toContain('Source: Refresh from RMS')
    expect(text).toContain('Please update picking/packing/team plan.')
  })

  test('filters unacknowledged groups', () => {
    const groups = groupOperationalEvents([
      QDB07915_EVENT,
      {
        id: 'evt-ack',
        job_ref: 'QDB1000',
        event_name: 'Acked Event',
        detected_at: '2026-06-14T10:00:00Z',
        acknowledged_at: '2026-06-14T11:00:00Z',
        change_type: 'item_added',
      },
    ])

    const filtered = filterOperationalGroups(groups, 'unacknowledged', { todayIso: '2026-06-15' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].jobRef).toBe('QDB07915')
  })

  test('filters today by detected_at', () => {
    const groups = groupOperationalEvents([
      QDB07915_EVENT,
      {
        id: 'evt-old',
        job_ref: 'QDB0001',
        event_name: 'Old',
        detected_at: '2026-06-10T10:00:00Z',
        change_type: 'item_added',
      },
    ])

    const filtered = filterOperationalGroups(groups, 'today', { todayIso: '2026-06-15' })
    expect(filtered).toHaveLength(1)
    expect(isDetectedToday(QDB07915_EVENT.detected_at, '2026-06-15')).toBe(true)
  })

  test('does not include orders in next 7 days when job date metadata is missing', () => {
    const groups = groupOperationalEvents([QDB07915_EVENT])
    expect(hasJobDateMetadata(groups[0].job)).toBe(false)

    const filtered = filterOperationalGroups(groups, 'next7days', { todayIso: '2026-06-15' })
    expect(filtered).toHaveLength(0)
  })

  test('includes orders in next 7 days when job metadata is available', () => {
    const job = {
      id: 'job-1',
      event_date: '2026-06-18',
      delivery_date: null,
      collection_date: null,
    }
    const groups = groupOperationalEvents([QDB07915_EVENT], { 'job-1': job })

    expect(isJobWithinNext7Days(job, '2026-06-15')).toBe(true)
    const filtered = filterOperationalGroups(groups, 'next7days', { todayIso: '2026-06-15' })
    expect(filtered).toHaveLength(1)
  })

  test('getOrderGroupKey prefers job_ref', () => {
    expect(getOrderGroupKey(QDB07915_EVENT)).toBe('QDB07915')
  })
})

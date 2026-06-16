import { buildOperationalAlertMessage } from '../../server-lib/operationalAlertMessage.js'

const JOB = {
  id: '11111111-1111-1111-1111-111111111111',
  crms_id: '12345',
  crms_ref: 'QDB07915',
  event_name: 'Alison Price Ali Fortune Event Thursday 18th June 2026',
}

const QDB07915_EVENT = {
  id: 'evt-1',
  job_ref: 'QDB07915',
  event_name: JOB.event_name,
  change_type: 'item_quantity_changed',
  source: 'manual_rms_refresh',
  item_name: 'Bronte Gold Rimmed Charger Plate',
  old_quantity: 50,
  new_quantity: 60,
  quantity_delta: 10,
}

describe('operationalAlertMessage', () => {
  test('formats QDB07915 quantity +10 correctly', () => {
    const text = buildOperationalAlertMessage({
      job: JOB,
      events: [QDB07915_EVENT],
      appUrl: 'https://app.example.com',
    })

    expect(text).toContain('⚠️ Order update — QDB07915')
    expect(text).toContain('Alison Price Ali Fortune Event Thursday 18th June 2026')
    expect(text).toContain('Item quantity changed:')
    expect(text).toContain('Bronte Gold Rimmed Charger Plate: 50 → 60 (+10)')
    expect(text).toContain('Source: Refresh from RMS')
    expect(text).toContain('Please update picking/packing/team plan.')
    expect(text).toContain('Acknowledge in Duchess App.')
    expect(text).toContain('Open in Duchess App: https://app.example.com')
  })

  test('formats negative quantity delta', () => {
    const text = buildOperationalAlertMessage({
      job: JOB,
      events: [{
        ...QDB07915_EVENT,
        old_quantity: 60,
        new_quantity: 50,
        quantity_delta: -10,
      }],
    })

    expect(text).toContain('60 → 50 (-10)')
  })

  test('groups multiple events for same order in one message', () => {
    const text = buildOperationalAlertMessage({
      job: JOB,
      events: [
        QDB07915_EVENT,
        {
          change_type: 'item_added',
          source: 'manual_rms_refresh',
          item_name: 'Salad Plate',
          new_quantity: 20,
        },
        {
          change_type: 'item_removed',
          source: 'manual_rms_refresh',
          item_name: 'Saucer',
          old_quantity: 5,
        },
      ],
    })

    expect(text).toContain('Item quantity changed:')
    expect(text).toContain('Bronte Gold Rimmed Charger Plate: 50 → 60 (+10)')
    expect(text).toContain('Item added:')
    expect(text).toContain('Salad Plate: added qty 20')
    expect(text).toContain('Item removed:')
    expect(text).toContain('Saucer: removed qty 5')
  })

  test('uses Unknown item when item_name missing', () => {
    const text = buildOperationalAlertMessage({
      job: JOB,
      events: [{
        change_type: 'item_added',
        source: 'manual_rms_refresh',
        new_quantity: 3,
      }],
    })

    expect(text).toContain('• Unknown item: added qty 3')
  })
})

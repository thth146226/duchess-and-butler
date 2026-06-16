import {
  buildIdempotencyKey,
  buildOperationalItemChangeEventRows,
  createOperationalItemChangeEvents,
  isOperationalChangeEventsEnabled,
} from '../../server-lib/operationalChangeEvents.js'

const JOB = {
  id: '11111111-1111-1111-1111-111111111111',
  crms_id: '9999',
  crms_ref: 'QDB7622',
  event_name: 'Test Event',
}

describe('operationalChangeEvents', () => {
  const originalEnabled = process.env.OPERATIONAL_CHANGE_EVENTS_ENABLED

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.OPERATIONAL_CHANGE_EVENTS_ENABLED
    } else {
      process.env.OPERATIONAL_CHANGE_EVENTS_ENABLED = originalEnabled
    }
  })

  test('feature flag disabled returns enabled:false and inserts nothing', async () => {
    delete process.env.OPERATIONAL_CHANGE_EVENTS_ENABLED

    expect(isOperationalChangeEventsEnabled()).toBe(false)

    const upsert = jest.fn()
    const supabase = { from: jest.fn(() => ({ upsert })) }

    const result = await createOperationalItemChangeEvents({
      supabase,
      job: JOB,
      diff: {
        added: [{ crms_item_id: '55', item_name: 'Plate', quantity: 10, category: 'crockery' }],
        changed: [],
        stale: [],
      },
      source: 'manual_rms_refresh',
    })

    expect(result).toEqual({
      enabled: false,
      attempted: 0,
      insertedOrUpserted: 0,
      skipped: 0,
      errors: [],
      insertedRows: [],
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  test('added item creates item_added event payload', () => {
    const rows = buildOperationalItemChangeEventRows({
      job: JOB,
      diff: {
        added: [{ crms_item_id: '55', item_name: 'Plate', quantity: 120, category: 'crockery' }],
        changed: [],
        stale: [],
      },
      source: 'manual_rms_refresh',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      job_id: JOB.id,
      crms_id: '9999',
      job_ref: 'QDB7622',
      event_name: 'Test Event',
      change_type: 'item_added',
      severity: 'high',
      source: 'manual_rms_refresh',
      item_key: '55',
      item_name: 'Plate',
      item_category: 'crockery',
      old_quantity: null,
      new_quantity: 120,
      quantity_delta: 120,
    })
    expect(rows[0].idempotency_key).toContain('item_added')
  })

  test('changed quantity creates item_quantity_changed with old/new/delta', () => {
    const rows = buildOperationalItemChangeEventRows({
      job: JOB,
      diff: {
        added: [],
        changed: [{
          crms_item_id: '55',
          local: { crms_item_id: '55', item_name: 'Plate', quantity: 120, category: 'crockery' },
          rms: { crms_item_id: '55', item_name: 'Plate', quantity: 80, category: 'crockery' },
        }],
        stale: [],
      },
      source: 'manual_rms_refresh',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      change_type: 'item_quantity_changed',
      severity: 'high',
      item_key: '55',
      old_value: '120',
      new_value: '80',
      old_quantity: 120,
      new_quantity: 80,
      quantity_delta: -40,
    })
  })

  test('changed name/category without quantity change creates item_changed', () => {
    const rows = buildOperationalItemChangeEventRows({
      job: JOB,
      diff: {
        added: [],
        changed: [{
          crms_item_id: '55',
          local: { crms_item_id: '55', item_name: 'Plate', quantity: 120, category: 'crockery' },
          rms: { crms_item_id: '55', item_name: 'Dinner Plate', quantity: 120, category: 'tableware' },
        }],
        stale: [],
      },
      source: 'manual_rms_refresh',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      change_type: 'item_changed',
      severity: 'medium',
      old_quantity: 120,
      new_quantity: 120,
      quantity_delta: 0,
    })
  })

  test('stale item creates item_removed', () => {
    const rows = buildOperationalItemChangeEventRows({
      job: JOB,
      diff: {
        added: [],
        changed: [],
        stale: [{ crms_item_id: '77', item_name: 'Saucer', quantity: 40, category: 'crockery' }],
      },
      source: 'manual_rms_refresh',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      change_type: 'item_removed',
      severity: 'high',
      item_key: '77',
      item_name: 'Saucer',
      old_quantity: 40,
      new_quantity: null,
      quantity_delta: -40,
    })
  })

  test('unchanged/no diff creates no events', () => {
    const rows = buildOperationalItemChangeEventRows({
      job: JOB,
      diff: {
        added: [],
        changed: [],
        stale: [],
        unchangedCount: 5,
      },
      source: 'manual_rms_refresh',
    })

    expect(rows).toHaveLength(0)
  })

  test('duplicate idempotency keys are stable and upsert ignores duplicates', async () => {
    process.env.OPERATIONAL_CHANGE_EVENTS_ENABLED = 'true'

    const diff = {
      added: [{ crms_item_id: '55', item_name: 'Plate', quantity: 120, category: 'crockery' }],
      changed: [],
      stale: [],
    }

    const rows = buildOperationalItemChangeEventRows({
      job: JOB,
      diff,
      source: 'manual_rms_refresh',
    })

    const keyOne = buildIdempotencyKey({
      source: 'manual_rms_refresh',
      jobId: JOB.id,
      changeType: 'item_added',
      itemKey: '55',
      oldQuantity: null,
      newQuantity: 120,
      oldValue: '',
      newValue: 'Plate',
    })

    expect(rows[0].idempotency_key).toBe(keyOne)

    const insertedRow = {
      id: 'existing-id',
      job_id: JOB.id,
      crms_id: '9999',
      job_ref: 'QDB7622',
      event_name: 'Test Event',
      change_type: 'item_added',
      severity: 'high',
      source: 'manual_rms_refresh',
      item_key: '55',
      item_name: 'Plate',
      payload: { crms_item_id: '55' },
      idempotency_key: keyOne,
    }

    const select = jest.fn().mockResolvedValue({ data: [insertedRow], error: null })
    const upsert = jest.fn(() => ({ select }))
    const from = jest.fn(() => ({ upsert }))
    const supabase = { from }

    const first = await createOperationalItemChangeEvents({
      supabase,
      job: JOB,
      diff,
      source: 'manual_rms_refresh',
    })

    expect(first).toMatchObject({
      enabled: true,
      attempted: 1,
      insertedOrUpserted: 1,
      skipped: 0,
      errors: [],
      insertedRows: [insertedRow],
    })

    select.mockResolvedValueOnce({ data: [], error: null })

    const second = await createOperationalItemChangeEvents({
      supabase,
      job: JOB,
      diff,
      source: 'manual_rms_refresh',
    })

    expect(second).toMatchObject({
      enabled: true,
      attempted: 1,
      insertedOrUpserted: 0,
      skipped: 1,
      errors: [],
      insertedRows: [],
    })

    expect(upsert).toHaveBeenCalledWith(
      rows,
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
  })
})

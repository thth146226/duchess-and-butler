import {
  HttpError,
  buildPortalRuns,
  getCompletionTarget,
  getDriverPortalRuns,
  getEffectiveColDate,
  getEffectiveDelDate,
  getLondonDateString,
  isColRunForDriver,
  isDelRunForDriver,
  jobHasVisiblePortalRunForDriver,
  markDriverPortalRunDone,
  normaliseRunDate,
  parseMarkDoneBody,
} from '../../server-lib/driverPortalRuns.js'

const TODAY = '2026-07-31'
const YESTERDAY = '2026-07-30'
const TOMORROW = '2026-08-01'

const ID_ORD_DEL = '11111111-1111-4111-8111-111111111101'
const ID_ORD_COL = '11111111-1111-4111-8111-111111111102'
const ID_RMS_DEL = '22222222-2222-4222-8222-222222222201'
const ID_RMS_COL = '22222222-2222-4222-8222-222222222202'
const ID_OTHER = '33333333-3333-4333-8333-333333333301'
const ID_FUTURE = '44444444-4444-4444-8444-444444444401'
const ID_ERR = '55555555-5555-4555-8555-555555555501'
const ID_ZERO = '66666666-6666-4666-8666-666666666601'
const ID_PENDING = '77777777-7777-4777-8777-777777777701'
const ID_HIST = '88888888-8888-4888-8888-888888888801'
const ID_DONE = '99999999-9999-4999-8999-999999999901'
const ID_MULTI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01'
const ID_MAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01'
const ID_HIST_ONLY = 'cccccccc-cccc-4ccc-8ccc-cccccccccc01'
const ID_VALID = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'
const ID_SPLIT = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'
const ID_LEGACY = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2'
const ID_DUAL_COL = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3'
const ID_WS_COL = 'f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4'

const DRIVER = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
  name: 'Alex Driver',
  colour: '#B8965A',
}

const ASSIF = {
  id: 'a1111111-a111-4111-8111-a11111111111',
  name: 'Assif',
  colour: '#B8965A',
}

const MARCEL = {
  id: 'a2222222-a222-4222-8222-a22222222222',
  name: 'Marcel',
  colour: '#3B6D11',
}

const COL_DRIVER_B = {
  id: 'a3333333-a333-4333-8333-a33333333333',
  name: 'Colette',
  colour: '#854F0B',
}

function baseJob(overrides = {}) {
  return {
    id: ID_RMS_DEL,
    crms_id: 100,
    status: 'confirmed',
    deleted: false,
    event_name: 'Test Event',
    venue: 'Venue',
    delivery_date: TODAY,
    collection_date: TODAY,
    delivery_done: false,
    collection_done: false,
    assigned_driver_name: DRIVER.name,
    assigned_driver_name_2: null,
    col_driver_name: DRIVER.name,
    col_driver_name_2: null,
    assigned_driver_id: DRIVER.id,
    assigned_driver_id_2: null,
    manual_delivery_date: null,
    manual_collection_date: null,
    delivery_time: '10:00',
    collection_time: '14:00',
    is_manual: false,
    ...overrides,
  }
}

function createMockSupabase({
  drivers = [],
  crmsJobs = [],
  orders = [],
  crmsItems = [],
  orderItems = [],
  updateResult,
} = {}) {
  const updateCalls = []
  const fromCalls = []
  const itemCalls = []

  function tableApi(table) {
    const state = {
      filters: {},
      mode: 'select',
      updatePayload: null,
      inFilter: null,
    }
    fromCalls.push(table)

    const api = {
      select() {
        return api
      },
      update(payload) {
        state.mode = 'update'
        state.updatePayload = payload
        return api
      },
      eq(col, val) {
        state.filters[col] = val
        return api
      },
      not() {
        return api
      },
      order() {
        return api
      },
      in(col, vals) {
        state.inFilter = { col, vals: [...vals] }
        if (table === 'crms_job_items' || table === 'order_items') {
          itemCalls.push({ table, col, vals: [...vals] })
        }
        return api
      },
      maybeSingle: async () => {
        if (table === 'drivers') {
          const row =
            drivers.find((d) => d.access_token === state.filters.access_token) || null
          return { data: row, error: null }
        }
        if (table === 'crms_jobs') {
          const row = crmsJobs.find((j) => j.id === state.filters.id) || null
          return { data: row, error: null }
        }
        if (table === 'orders') {
          let row = orders.find((j) => j.id === state.filters.id) || null
          if (row && state.filters.deleted === false && row.deleted) row = null
          return { data: row, error: null }
        }
        return { data: null, error: null }
      },
      then(resolve, reject) {
        if (state.mode === 'update') {
          updateCalls.push({
            table,
            payload: state.updatePayload,
            filters: { ...state.filters },
          })
          if (typeof updateResult === 'function') {
            return Promise.resolve(
              updateResult({
                table,
                payload: state.updatePayload,
                filters: { ...state.filters },
              }),
            ).then(resolve, reject)
          }
          if (updateResult) {
            return Promise.resolve(updateResult).then(resolve, reject)
          }
          return Promise.resolve({
            data: [{ id: state.filters.id }],
            error: null,
          }).then(resolve, reject)
        }

        if (table === 'crms_jobs' && state.filters.id == null) {
          return Promise.resolve({ data: crmsJobs, error: null }).then(resolve, reject)
        }
        if (table === 'orders' && state.filters.id == null) {
          return Promise.resolve({
            data: orders.filter((o) => !o.deleted),
            error: null,
          }).then(resolve, reject)
        }
        if (table === 'crms_job_items') {
          const ids = state.inFilter?.vals || []
          return Promise.resolve({
            data: crmsItems.filter((item) => ids.includes(item.job_id)),
            error: null,
          }).then(resolve, reject)
        }
        if (table === 'order_items') {
          const ids = state.inFilter?.vals || []
          return Promise.resolve({
            data: orderItems.filter((item) => ids.includes(item.order_id)),
            error: null,
          }).then(resolve, reject)
        }

        return Promise.resolve({ data: [], error: null }).then(resolve, reject)
      },
    }

    return api
  }

  return {
    from: (table) => tableApi(table),
    __updateCalls: updateCalls,
    __fromCalls: fromCalls,
    __itemCalls: itemCalls,
  }
}

const activeDriver = {
  id: DRIVER.id,
  name: DRIVER.name,
  colour: DRIVER.colour,
  active: true,
  access_token: 'portal-token',
  token_created_at: new Date().toISOString(),
}

describe('driverPortalRuns date helpers', () => {
  test('getLondonDateString returns YYYY-MM-DD for a fixed instant', () => {
    expect(getLondonDateString(new Date('2026-07-31T01:30:00.000Z'))).toBe('2026-07-31')
  })

  test('getLondonDateString uses BST midnight boundary', () => {
    // 2026-07-30 23:30 UTC == 2026-07-31 00:30 Europe/London (BST)
    expect(getLondonDateString(new Date('2026-07-30T23:30:00.000Z'))).toBe('2026-07-31')
  })

  test('normaliseRunDate accepts ISO date and valid date-time suffixes', () => {
    expect(normaliseRunDate('2026-07-31')).toBe('2026-07-31')
    expect(normaliseRunDate('2026-07-31T10:30')).toBe('2026-07-31')
    expect(normaliseRunDate('2026-07-31 10:30:00')).toBe('2026-07-31')
    expect(normaliseRunDate('2026-07-31T10:30:00Z')).toBe('2026-07-31')
    expect(normaliseRunDate('2026-07-31T10:30:00+01:00')).toBe('2026-07-31')
    expect(normaliseRunDate('2026-07-31T10:30:00-03:30')).toBe('2026-07-31')
    expect(normaliseRunDate('2026-07-31T10:30:00.123Z')).toBe('2026-07-31')
    expect(normaliseRunDate('2026-07-31T14:00:00+14:00')).toBe('2026-07-31')
  })

  test('normaliseRunDate rejects malformed and impossible dates', () => {
    expect(normaliseRunDate('31/07/2026')).toBe(null)
    expect(normaliseRunDate(null)).toBe(null)
    expect(normaliseRunDate('2026-99-99')).toBe(null)
    expect(normaliseRunDate('2026-02-31')).toBe(null)
    expect(normaliseRunDate('2026-07-31garbage')).toBe(null)
  })

  test('normaliseRunDate rejects invalid time suffixes and offsets', () => {
    expect(normaliseRunDate('2026-07-31Tbanana')).toBe(null)
    expect(normaliseRunDate('2026-07-31T99:99:99')).toBe(null)
    expect(normaliseRunDate('2026-07-31 invalid-time')).toBe(null)
    expect(normaliseRunDate('2026-07-31T10:00:00+99:99')).toBe(null)
    expect(normaliseRunDate('2026-07-31T10:00:00+24:00')).toBe(null)
    expect(normaliseRunDate('2026-07-31T10:00:00+14:01')).toBe(null)
    expect(normaliseRunDate('2026-07-31T10:00:00+0100')).toBe(null)
    expect(normaliseRunDate('2026-07-31T25:00:00Z')).toBe(null)
    expect(normaliseRunDate('2026-07-31T10:00:00X')).toBe(null)
    expect(normaliseRunDate('2026-07-31\t10:30:00')).toBe(null)
    expect(normaliseRunDate('2026-07-31\n10:30:00')).toBe(null)
  })
})

describe('driverPortalRuns date filtering', () => {
  test('1. Historical DEL run is excluded', () => {
    const job = baseJob({
      delivery_date: YESTERDAY,
      collection_date: null,
      collection_done: true,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => r.type)).toEqual([])
    expect(jobHasVisiblePortalRunForDriver(job, DRIVER, TODAY)).toBe(false)
  })

  test('2. Historical COL run is excluded', () => {
    const job = baseJob({
      delivery_date: null,
      delivery_done: true,
      collection_date: YESTERDAY,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => r.type)).toEqual([])
    expect(jobHasVisiblePortalRunForDriver(job, DRIVER, TODAY)).toBe(false)
  })

  test("3. Today's DEL run is included", () => {
    const job = baseJob({
      delivery_date: TODAY,
      collection_date: null,
      collection_done: true,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => r.type)).toEqual(['DEL'])
  })

  test("4. Today's COL run is included", () => {
    const job = baseJob({
      delivery_date: null,
      delivery_done: true,
      collection_date: TODAY,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => r.type)).toEqual(['COL'])
  })

  test('5. Future DEL run is included', () => {
    const job = baseJob({
      delivery_date: TOMORROW,
      collection_date: null,
      collection_done: true,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => r.type)).toEqual(['DEL'])
    expect(runs[0].date).toBe(TOMORROW)
  })

  test('6. Future COL run is included', () => {
    const job = baseJob({
      delivery_date: null,
      delivery_done: true,
      collection_date: TOMORROW,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => r.type)).toEqual(['COL'])
  })

  test('7. Past DEL and future COL returns only COL', () => {
    const job = baseJob({
      delivery_date: YESTERDAY,
      collection_date: TOMORROW,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => r.type)).toEqual(['COL'])
    expect(jobHasVisiblePortalRunForDriver(job, DRIVER, TODAY)).toBe(true)
  })

  test('8. Future DEL and past COL returns only DEL', () => {
    const job = baseJob({
      delivery_date: TOMORROW,
      collection_date: YESTERDAY,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => r.type)).toEqual(['DEL'])
  })

  test('9. Completed runs remain excluded', () => {
    const job = baseJob({
      delivery_date: TODAY,
      collection_date: TODAY,
      delivery_done: true,
      collection_done: true,
    })
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs).toEqual([])
    expect(jobHasVisiblePortalRunForDriver(job, DRIVER, TODAY)).toBe(false)
  })

  test('10. Cancelled/deleted jobs remain excluded', () => {
    const cancelled = baseJob({ status: 'cancelled' })
    const deleted = baseJob({ deleted: true })
    expect(buildPortalRuns([cancelled, deleted], DRIVER, TODAY)).toEqual([])
    expect(jobHasVisiblePortalRunForDriver(cancelled, DRIVER, TODAY)).toBe(false)
    expect(jobHasVisiblePortalRunForDriver(deleted, DRIVER, TODAY)).toBe(false)
  })

  test('11. Manual date override keeps existing precedence', () => {
    const job = baseJob({
      delivery_date: YESTERDAY,
      manual_delivery_date: TOMORROW,
      collection_date: TODAY,
      manual_collection_date: YESTERDAY,
    })
    expect(getEffectiveDelDate(job)).toBe(TOMORROW)
    expect(getEffectiveColDate(job)).toBe(YESTERDAY)
    const runs = buildPortalRuns([job], DRIVER, TODAY)
    expect(runs.map((r) => `${r.type}:${r.date}`)).toEqual([`DEL:${TOMORROW}`])
  })

  test('historical-only job is filtered before item loading', async () => {
    const historicalJob = baseJob({
      id: ID_HIST_ONLY,
      delivery_date: YESTERDAY,
      collection_date: YESTERDAY,
      delivery_done: false,
      collection_done: false,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [historicalJob],
      crmsItems: [{ id: 'item-1', job_id: ID_HIST_ONLY, name: 'Chair' }],
    })

    const result = await getDriverPortalRuns('portal-token', {
      now: new Date('2026-07-31T12:00:00.000Z'),
      supabase,
    })

    expect(result.runs).toEqual([])
    expect(supabase.__itemCalls).toEqual([])
    expect(supabase.__fromCalls).not.toContain('crms_job_items')
    expect(supabase.__fromCalls).not.toContain('order_items')
  })
})

describe('driverPortalRuns collection driver precedence', () => {
  function splitAssignmentJob(overrides = {}) {
    return baseJob({
      id: ID_SPLIT,
      event_name: 'Graziela',
      assigned_driver_name: ASSIF.name,
      assigned_driver_name_2: null,
      assigned_driver_id: ASSIF.id,
      assigned_driver_id_2: null,
      col_driver_name: MARCEL.name,
      col_driver_name_2: null,
      delivery_date: TODAY,
      collection_date: TODAY,
      delivery_done: false,
      collection_done: false,
      ...overrides,
    })
  }

  test('1-4. Assif gets DEL only; Marcel gets COL only', () => {
    const job = splitAssignmentJob()

    expect(isDelRunForDriver(job, ASSIF)).toBe(true)
    expect(isColRunForDriver(job, ASSIF)).toBe(false)
    expect(buildPortalRuns([job], ASSIF, TODAY).map((r) => r.type)).toEqual(['DEL'])

    expect(isDelRunForDriver(job, MARCEL)).toBe(false)
    expect(isColRunForDriver(job, MARCEL)).toBe(true)
    expect(buildPortalRuns([job], MARCEL, TODAY).map((r) => r.type)).toEqual(['COL'])
  })

  test('5. jobHasVisiblePortalRunForDriver is correct per driver', () => {
    const job = splitAssignmentJob()
    expect(jobHasVisiblePortalRunForDriver(job, ASSIF, TODAY)).toBe(true)
    expect(jobHasVisiblePortalRunForDriver(job, MARCEL, TODAY)).toBe(true)

    const assifDelDone = splitAssignmentJob({ delivery_done: true })
    expect(jobHasVisiblePortalRunForDriver(assifDelDone, ASSIF, TODAY)).toBe(false)
    expect(jobHasVisiblePortalRunForDriver(assifDelDone, MARCEL, TODAY)).toBe(true)
  })

  test('6. Assif marking COL done is rejected with 404 and no update', async () => {
    const job = splitAssignmentJob()
    const assifDriverRow = {
      id: ASSIF.id,
      name: ASSIF.name,
      colour: ASSIF.colour,
      active: true,
      access_token: 'assif-token',
      token_created_at: new Date().toISOString(),
    }
    const supabase = createMockSupabase({
      drivers: [assifDriverRow],
      crmsJobs: [job],
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'assif-token', jobId: ID_SPLIT, type: 'COL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Run not found.' })
    expect(supabase.__updateCalls).toEqual([])
  })

  test('7-8. Marcel may mark COL done; updates only collection_done', async () => {
    const job = splitAssignmentJob()
    const marcelDriverRow = {
      id: MARCEL.id,
      name: MARCEL.name,
      colour: MARCEL.colour,
      active: true,
      access_token: 'marcel-token',
      token_created_at: new Date().toISOString(),
    }
    const supabase = createMockSupabase({
      drivers: [marcelDriverRow],
      crmsJobs: [job],
    })

    const result = await markDriverPortalRunDone(
      { token: 'marcel-token', jobId: ID_SPLIT, type: 'COL' },
      { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
    )

    expect(result).toEqual({ ok: true, jobId: ID_SPLIT, type: 'COL' })
    expect(supabase.__updateCalls).toEqual([
      {
        table: 'crms_jobs',
        payload: { collection_done: true },
        filters: { id: ID_SPLIT, collection_done: false },
      },
    ])
  })

  test('9. Both explicit collection drivers may receive COL', () => {
    const job = splitAssignmentJob({
      id: ID_DUAL_COL,
      col_driver_name: MARCEL.name,
      col_driver_name_2: COL_DRIVER_B.name,
      delivery_done: true,
    })

    expect(isColRunForDriver(job, MARCEL)).toBe(true)
    expect(isColRunForDriver(job, COL_DRIVER_B)).toBe(true)
    expect(isColRunForDriver(job, ASSIF)).toBe(false)
    expect(buildPortalRuns([job], MARCEL, TODAY).map((r) => r.type)).toEqual(['COL'])
    expect(buildPortalRuns([job], COL_DRIVER_B, TODAY).map((r) => r.type)).toEqual(['COL'])
    expect(buildPortalRuns([job], ASSIF, TODAY).map((r) => r.type)).toEqual([])
  })

  test('10. Absent collection drivers keep legacy assigned-driver fallback', () => {
    const job = baseJob({
      id: ID_LEGACY,
      assigned_driver_name: ASSIF.name,
      assigned_driver_id: ASSIF.id,
      col_driver_name: null,
      col_driver_name_2: null,
      delivery_done: true,
      collection_done: false,
      collection_date: TODAY,
    })

    expect(isColRunForDriver(job, ASSIF)).toBe(true)
    expect(buildPortalRuns([job], ASSIF, TODAY).map((r) => r.type)).toEqual(['COL'])
    expect(isColRunForDriver(job, MARCEL)).toBe(false)
  })

  test('11. Whitespace-only col_driver_name does not disable legacy fallback', () => {
    const job = baseJob({
      id: ID_WS_COL,
      assigned_driver_name: ASSIF.name,
      assigned_driver_id: ASSIF.id,
      col_driver_name: '   ',
      col_driver_name_2: '\t',
      delivery_done: true,
      collection_done: false,
      collection_date: TODAY,
    })

    expect(isColRunForDriver(job, ASSIF)).toBe(true)
    expect(buildPortalRuns([job], ASSIF, TODAY).map((r) => r.type)).toEqual(['COL'])
    expect(isColRunForDriver(job, MARCEL)).toBe(false)
  })

  test('empty string and undefined collection drivers keep legacy fallback', () => {
    const job = baseJob({
      id: ID_LEGACY,
      assigned_driver_name: ASSIF.name,
      assigned_driver_id: ASSIF.id,
      col_driver_name: '',
      col_driver_name_2: undefined,
      delivery_done: true,
      collection_done: false,
      collection_date: TODAY,
    })

    expect(isColRunForDriver(job, ASSIF)).toBe(true)
    expect(isColRunForDriver(job, MARCEL)).toBe(false)
    expect(buildPortalRuns([job], ASSIF, TODAY).map((r) => r.type)).toEqual(['COL'])
  })
})

describe('driverPortalRuns completion mutation', () => {
  test('12. Manual-order DEL updates public.orders.delivery_done', async () => {
    const order = {
      ...baseJob({
        id: ID_ORD_DEL,
        delivery_date: TODAY,
        collection_done: true,
      }),
      deleted: false,
      ref: 'MAN-1',
    }
    delete order.is_manual
    delete order.crms_id

    const supabase = createMockSupabase({
      drivers: [activeDriver],
      orders: [order],
      crmsJobs: [],
    })

    const result = await markDriverPortalRunDone(
      { token: 'portal-token', jobId: ID_ORD_DEL, type: 'DEL' },
      { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
    )

    expect(result).toEqual({ ok: true, jobId: ID_ORD_DEL, type: 'DEL' })
    expect(supabase.__updateCalls).toEqual([
      {
        table: 'orders',
        payload: { delivery_done: true },
        filters: { id: ID_ORD_DEL, delivery_done: false },
      },
    ])
  })

  test('13. Manual-order COL updates public.orders.collection_done', async () => {
    const order = {
      ...baseJob({
        id: ID_ORD_COL,
        delivery_done: true,
        collection_date: TODAY,
      }),
      deleted: false,
      ref: 'MAN-2',
    }
    delete order.is_manual
    delete order.crms_id

    const supabase = createMockSupabase({
      drivers: [activeDriver],
      orders: [order],
    })

    await markDriverPortalRunDone(
      { token: 'portal-token', jobId: ID_ORD_COL, type: 'COL' },
      { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
    )

    expect(supabase.__updateCalls[0]).toEqual({
      table: 'orders',
      payload: { collection_done: true },
      filters: { id: ID_ORD_COL, collection_done: false },
    })
  })

  test('14. RMS DEL updates public.crms_jobs.delivery_done', async () => {
    const job = baseJob({
      id: ID_RMS_DEL,
      delivery_date: TODAY,
      collection_done: true,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
    })

    await markDriverPortalRunDone(
      { token: 'portal-token', jobId: ID_RMS_DEL, type: 'DEL' },
      { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
    )

    expect(supabase.__updateCalls[0]).toEqual({
      table: 'crms_jobs',
      payload: { delivery_done: true },
      filters: { id: ID_RMS_DEL, delivery_done: false },
    })
  })

  test('15. RMS COL updates public.crms_jobs.collection_done', async () => {
    const job = baseJob({
      id: ID_RMS_COL,
      delivery_done: true,
      collection_date: TODAY,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
    })

    await markDriverPortalRunDone(
      { token: 'portal-token', jobId: ID_RMS_COL, type: 'COL' },
      { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
    )

    expect(supabase.__updateCalls[0]).toEqual({
      table: 'crms_jobs',
      payload: { collection_done: true },
      filters: { id: ID_RMS_COL, collection_done: false },
    })
  })

  test('16. Client cannot choose the table', () => {
    const manual = baseJob({ is_manual: true })
    const rms = baseJob({ is_manual: false })
    expect(getCompletionTarget(manual, 'DEL').table).toBe('orders')
    expect(getCompletionTarget(rms, 'DEL').table).toBe('crms_jobs')
    expect(getCompletionTarget(manual, 'DEL')).toEqual({
      table: 'orders',
      field: 'delivery_done',
    })
  })

  test('17. Client cannot choose the field', () => {
    expect(getCompletionTarget(baseJob(), 'DEL').field).toBe('delivery_done')
    expect(getCompletionTarget(baseJob(), 'COL').field).toBe('collection_done')
  })

  test('18. Run not assigned to token driver is rejected', async () => {
    const job = baseJob({
      id: ID_OTHER,
      assigned_driver_name: 'Someone Else',
      col_driver_name: 'Someone Else',
      assigned_driver_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_OTHER, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Run not found.' })
    expect(supabase.__updateCalls).toEqual([])
  })

  test('19. Future run cannot be marked done', async () => {
    const job = baseJob({
      id: ID_FUTURE,
      delivery_date: TOMORROW,
      collection_done: true,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_FUTURE, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Cannot mark future runs as done.',
    })
    expect(supabase.__updateCalls).toEqual([])
  })

  test('20. Invalid type is rejected', () => {
    expect(() =>
      parseMarkDoneBody({ token: 't', jobId: ID_VALID, type: 'PICKUP' }),
    ).toThrow(HttpError)
    try {
      parseMarkDoneBody({ token: 't', jobId: ID_VALID, type: 'PICKUP' })
    } catch (err) {
      expect(err.statusCode).toBe(400)
    }
  })

  test('21. Database update errors are surfaced by the mutation helper', async () => {
    const job = baseJob({
      id: ID_ERR,
      delivery_date: TODAY,
      collection_done: true,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
      updateResult: { data: null, error: { message: 'update failed hard' } },
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_ERR, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toThrow('update failed hard')
  })

  test('22. Zero updated rows from conditional update are a 409 conflict', async () => {
    const job = baseJob({
      id: ID_ZERO,
      delivery_date: TODAY,
      collection_done: true,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
      updateResult: { data: [], error: null },
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_ZERO, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Run is already completed.',
    })
    expect(supabase.__updateCalls[0]).toEqual({
      table: 'crms_jobs',
      payload: { delivery_done: true },
      filters: { id: ID_ZERO, delivery_done: false },
    })
  })

  test('race/already-changed conditional update returns 409', async () => {
    const job = baseJob({
      id: ID_ZERO,
      delivery_date: TODAY,
      collection_done: true,
      delivery_done: false,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
      updateResult: { data: [], error: null },
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_ZERO, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Run is already completed.',
    })
    expect(supabase.__updateCalls).toHaveLength(1)
    expect(supabase.__updateCalls[0].filters).toEqual({
      id: ID_ZERO,
      delivery_done: false,
    })
  })

  test('pending manual order is rejected with 404 and no update', async () => {
    const order = {
      id: ID_PENDING,
      status: 'pending',
      deleted: false,
      ref: 'MAN-PENDING',
      event_name: 'Pending Manual',
      venue: 'Venue',
      delivery_date: TODAY,
      collection_date: null,
      delivery_done: false,
      collection_done: false,
      assigned_driver_name: DRIVER.name,
      assigned_driver_name_2: null,
      col_driver_name: null,
      col_driver_name_2: null,
      assigned_driver_id: DRIVER.id,
      assigned_driver_id_2: null,
    }
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      orders: [order],
      crmsJobs: [],
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_PENDING, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Run not found.' })
    expect(supabase.__updateCalls).toEqual([])
  })

  test('invalid UUID jobId is rejected with 400 and no database call', async () => {
    const supabase = createMockSupabase({ drivers: [activeDriver] })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: 'not-a-uuid', type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Invalid jobId.' })
    expect(supabase.__fromCalls).toEqual([])
    expect(supabase.__updateCalls).toEqual([])
  })

  test('historical run completion is rejected', async () => {
    const job = baseJob({
      id: ID_HIST,
      delivery_date: YESTERDAY,
      collection_done: true,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_HIST, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Cannot mark historical runs as done.',
    })
    expect(supabase.__updateCalls).toEqual([])
  })

  test('already completed run is rejected', async () => {
    const job = baseJob({
      id: ID_DONE,
      delivery_date: TODAY,
      delivery_done: true,
      collection_done: true,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_DONE, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Run is already completed.',
    })
    expect(supabase.__updateCalls).toEqual([])
  })

  test('more than one updated row is treated as failure', async () => {
    const job = baseJob({
      id: ID_MULTI,
      delivery_date: TODAY,
      collection_done: true,
    })
    const supabase = createMockSupabase({
      drivers: [activeDriver],
      crmsJobs: [job],
      updateResult: {
        data: [{ id: ID_MULTI }, { id: ID_MULTI }],
        error: null,
      },
    })

    await expect(
      markDriverPortalRunDone(
        { token: 'portal-token', jobId: ID_MULTI, type: 'DEL' },
        { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
      ),
    ).rejects.toThrow('Unexpected number of rows updated.')
  })

  test('malicious client table/field values are ignored by the real mutation', async () => {
    const order = {
      ...baseJob({
        id: ID_MAL,
        delivery_date: TODAY,
        collection_done: true,
      }),
      deleted: false,
      ref: 'MAN-MAL',
    }
    delete order.is_manual
    delete order.crms_id

    const supabase = createMockSupabase({
      drivers: [activeDriver],
      orders: [order],
    })

    await markDriverPortalRunDone(
      {
        token: 'portal-token',
        jobId: ID_MAL,
        type: 'DEL',
        table: 'crms_jobs',
        field: 'collection_done',
        is_manual: false,
      },
      { now: new Date('2026-07-31T12:00:00.000Z'), supabase },
    )

    expect(supabase.__updateCalls).toEqual([
      {
        table: 'orders',
        payload: { delivery_done: true },
        filters: { id: ID_MAL, delivery_done: false },
      },
    ])
  })

  test('missing token and jobId are rejected', () => {
    expect(() => parseMarkDoneBody({ jobId: ID_VALID, type: 'DEL' })).toThrow(
      HttpError,
    )
    expect(() => parseMarkDoneBody({ token: 'portal-token', type: 'DEL' })).toThrow(
      HttpError,
    )
    try {
      parseMarkDoneBody({ jobId: ID_VALID, type: 'DEL' })
    } catch (err) {
      expect(err.statusCode).toBe(400)
      expect(err.message).toBe('Missing access token.')
    }
    try {
      parseMarkDoneBody({ token: 'portal-token', type: 'DEL' })
    } catch (err) {
      expect(err.statusCode).toBe(400)
      expect(err.message).toBe('Missing jobId.')
    }
  })
})

describe('driver-portal-runs endpoint', () => {
  function mockRes() {
    const res = {
      statusCode: null,
      body: null,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        this.body = payload
        return this
      },
    }
    return res
  }

  test('23. Existing GET remains supported', async () => {
    jest.resetModules()
    jest.doMock('../../server-lib/driverPortalRuns', () => {
      const actual = jest.requireActual('../../server-lib/driverPortalRuns')
      return {
        ...actual,
        getDriverPortalRuns: jest.fn().mockResolvedValue({
          ok: true,
          driver: DRIVER,
          runs: [],
        }),
        markDriverPortalRunDone: jest.fn(),
      }
    })
    const handler = require('../../api/driver-portal-runs')
    const { getDriverPortalRuns: getRuns } = require('../../server-lib/driverPortalRuns')
    const res = mockRes()
    await handler({ method: 'GET', query: { token: 'abc' } }, res)
    expect(getRuns).toHaveBeenCalledWith('abc')
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  test('24. PATCH accepts valid input', async () => {
    jest.resetModules()
    jest.doMock('../../server-lib/driverPortalRuns', () => {
      const actual = jest.requireActual('../../server-lib/driverPortalRuns')
      return {
        ...actual,
        getDriverPortalRuns: jest.fn(),
        markDriverPortalRunDone: jest.fn().mockResolvedValue({
          ok: true,
          jobId: ID_VALID,
          type: 'DEL',
        }),
      }
    })
    const handler = require('../../api/driver-portal-runs')
    const { markDriverPortalRunDone: markDone } = require('../../server-lib/driverPortalRuns')
    const res = mockRes()
    const body = { token: 'abc', jobId: ID_VALID, type: 'DEL' }
    await handler({ method: 'PATCH', body }, res)
    expect(markDone).toHaveBeenCalledWith(body)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, jobId: ID_VALID, type: 'DEL' })
  })

  test('25. Unsupported methods return 405 with Allow header', async () => {
    jest.resetModules()
    jest.doMock('../../server-lib/driverPortalRuns', () => {
      const actual = jest.requireActual('../../server-lib/driverPortalRuns')
      return {
        ...actual,
        getDriverPortalRuns: jest.fn(),
        markDriverPortalRunDone: jest.fn(),
      }
    })
    const handler = require('../../api/driver-portal-runs')
    const res = mockRes()
    await handler({ method: 'POST', query: {}, body: {} }, res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.Allow).toBe('GET, PATCH')
    expect(res.body).toEqual({ error: 'Method not allowed' })
  })

  test('unexpected database errors are sanitized in the HTTP response', async () => {
    jest.resetModules()
    jest.doMock('../../server-lib/driverPortalRuns', () => {
      const actual = jest.requireActual('../../server-lib/driverPortalRuns')
      return {
        ...actual,
        getDriverPortalRuns: jest.fn(),
        markDriverPortalRunDone: jest
          .fn()
          .mockRejectedValue(new Error('secret db detail: relation "orders" boom')),
      }
    })
    const handler = require('../../api/driver-portal-runs')
    const res = mockRes()
    await handler(
      {
        method: 'PATCH',
        body: { token: 'abc', jobId: ID_VALID, type: 'DEL' },
      },
      res,
    )
    expect(res.statusCode).toBe(502)
    expect(res.body).toEqual({ error: 'Failed to complete driver portal run.' })
    expect(JSON.stringify(res.body)).not.toContain('secret db detail')
    expect(JSON.stringify(res.body)).not.toContain('relation "orders" boom')
  })
})

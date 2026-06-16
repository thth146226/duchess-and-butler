import {
  AUTO_POLL_MAX_CONCURRENCY,
  AUTO_POLL_MAX_JOBS_CAP,
  countItemChangesFromDiff,
  estimateOperationalNotifications,
  fetchAutoPollScopedJobs,
  isAutoPollMode,
  isCronAuthorized,
  jobInForwardWindow,
  parseAutoPollOptions,
  runAutoPollRms,
} from '../../server-lib/autoPollRms.js'
import { reconcileJobItemsFromRms } from '../../server-lib/crmsItemReconcile.js'
import { isAllowedOperationalEventSource } from '../../server-lib/operationalChangeEvents.js'
import { sendOperationalTelegramAlerts } from '../../server-lib/telegramAlerts.js'

jest.mock('../../server-lib/crmsItemReconcile.js', () => ({
  reconcileJobItemsFromRms: jest.fn(),
}))

jest.mock('../../server-lib/telegramAlerts.js', () => {
  const actual = jest.requireActual('../../server-lib/telegramAlerts.js')
  return {
    ...actual,
    sendOperationalTelegramAlerts: jest.fn(),
  }
})

const JOB_IN_WINDOW = {
  id: 'job-1',
  crms_id: '999',
  crms_ref: 'QDB07915',
  event_name: 'Test Event',
  delivery_date: '2026-06-20',
  event_date: null,
  collection_date: null,
  status: 'confirmed',
  hidden_from_schedule: false,
  rms_visibility_status: 'active',
}

describe('autoPollRms', () => {
  const originalCronSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret'
    jest.clearAllMocks()
  })

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET
    } else {
      process.env.CRON_SECRET = originalCronSecret
    }
  })

  test('isAutoPollMode detects auto_poll_rms', () => {
    expect(isAutoPollMode({ mode: 'auto_poll_rms' })).toBe(true)
    expect(isAutoPollMode({ mode: 'inventory' })).toBe(false)
  })

  test('isCronAuthorized accepts Bearer CRON_SECRET only', () => {
    expect(isCronAuthorized({ headers: { authorization: 'Bearer test-cron-secret' } })).toBe(true)
    expect(isCronAuthorized({ headers: { authorization: 'Bearer admin-jwt-token' } })).toBe(false)
    expect(isCronAuthorized({ headers: {} })).toBe(false)
  })

  test('parseAutoPollOptions defaults apply to false and caps limits', () => {
    const options = parseAutoPollOptions({
      apply: false,
      windowDays: 14,
      maxJobs: 99,
      concurrency: 9,
    })

    expect(options.apply).toBe(false)
    expect(options.dryRun).toBe(true)
    expect(options.windowDays).toBe(14)
    expect(options.maxJobs).toBe(AUTO_POLL_MAX_JOBS_CAP)
    expect(options.concurrency).toBe(AUTO_POLL_MAX_CONCURRENCY)
  })

  test('jobInForwardWindow uses event/delivery/collection dates', () => {
    expect(jobInForwardWindow(JOB_IN_WINDOW, '2026-06-16', '2026-06-30')).toBe(true)
    expect(jobInForwardWindow({
      ...JOB_IN_WINDOW,
      delivery_date: '2026-01-01',
    }, '2026-06-16', '2026-06-30')).toBe(false)
  })

  test('fetchAutoPollScopedJobs excludes hidden, cancelled, and non-active RMS visibility', async () => {
    const supabase = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          not: jest.fn(() => ({
            eq: jest.fn(() => ({
              neq: jest.fn().mockResolvedValue({
                data: [
                  JOB_IN_WINDOW,
                  { ...JOB_IN_WINDOW, id: 'job-hidden', hidden_from_schedule: true },
                  { ...JOB_IN_WINDOW, id: 'job-cancelled', status: 'cancelled' },
                  { ...JOB_IN_WINDOW, id: 'job-missing', rms_visibility_status: 'missing_from_rms' },
                  { ...JOB_IN_WINDOW, id: 'job-no-crms', crms_id: null },
                ],
                error: null,
              }),
            })),
          })),
        })),
      })),
    }

    const { jobs } = await fetchAutoPollScopedJobs(supabase, {
      windowStart: '2026-06-16',
      windowEnd: '2026-06-30',
      maxJobs: 25,
    })

    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe('job-1')
  })

  test('countItemChangesFromDiff totals added/changed/stale', () => {
    expect(countItemChangesFromDiff({
      added: [{ id: 1 }],
      changed: [{ id: 2 }, { id: 3 }],
      stale: [],
    })).toBe(3)
  })

  test('estimateOperationalNotifications counts telegram-eligible high events', () => {
    const estimates = estimateOperationalNotifications({
      job: JOB_IN_WINDOW,
      diff: {
        added: [],
        changed: [{
          crms_item_id: '55',
          local: { crms_item_id: '55', item_name: 'Plate', quantity: 60, category: 'crockery' },
          rms: { crms_item_id: '55', item_name: 'Plate', quantity: 55, category: 'crockery' },
        }],
        stale: [],
      },
      source: 'global_sync',
    })

    expect(estimates.eventsWouldCreate).toBe(1)
    expect(estimates.telegramWouldSend).toBe(1)
  })

  test('isAllowedOperationalEventSource accepts global_sync for future apply mode', () => {
    expect(isAllowedOperationalEventSource('global_sync')).toBe(true)
    expect(isAllowedOperationalEventSource('manual_rms_refresh')).toBe(true)
    expect(isAllowedOperationalEventSource('unknown')).toBe(false)
  })

  test('runAutoPollRms report-only does not create events or send Telegram', async () => {
    reconcileJobItemsFromRms.mockResolvedValue({
      ok: true,
      stats: { addedFound: 0, changedFound: 1, staleFound: 0 },
      diff: {
        added: [],
        changed: [{
          crms_item_id: '55',
          local: { crms_item_id: '55', item_name: 'Plate', quantity: 60, category: 'crockery' },
          rms: { crms_item_id: '55', item_name: 'Plate', quantity: 55, category: 'crockery' },
        }],
        stale: [],
      },
      warnings: [],
      operationalEvents: null,
      telegramAlerts: null,
    })

    const supabase = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          not: jest.fn(() => ({
            eq: jest.fn(() => ({
              neq: jest.fn().mockResolvedValue({ data: [JOB_IN_WINDOW], error: null }),
            })),
          })),
        })),
      })),
    }

    const result = await runAutoPollRms({
      supabase,
      body: { mode: 'auto_poll_rms', apply: false },
    })

    expect(reconcileJobItemsFromRms).toHaveBeenCalledWith({
      supabase,
      oppId: JOB_IN_WINDOW.crms_id,
      jobUuid: JOB_IN_WINDOW.id,
      dryRun: true,
      operationalEventSource: null,
    })
    expect(sendOperationalTelegramAlerts).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      mode: 'auto_poll_rms',
      dryRun: true,
      apply: false,
      jobsScanned: 1,
      jobsSucceeded: 1,
      jobsFailed: 0,
      jobsChanged: 1,
      itemChangesDetected: 1,
      eventsWouldCreate: 1,
      telegramWouldSend: 1,
      eventsCreated: 0,
      telegramSent: 0,
    })
  })

  test('runAutoPollRms per-job failure does not fail full run', async () => {
    reconcileJobItemsFromRms
      .mockRejectedValueOnce(new Error('RMS timeout'))
      .mockResolvedValueOnce({
        ok: true,
        stats: { addedFound: 0, changedFound: 0, staleFound: 0 },
        diff: { added: [], changed: [], stale: [] },
        warnings: [],
        operationalEvents: null,
        telegramAlerts: null,
      })

    const supabase = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          not: jest.fn(() => ({
            eq: jest.fn(() => ({
              neq: jest.fn().mockResolvedValue({
                data: [JOB_IN_WINDOW, { ...JOB_IN_WINDOW, id: 'job-2', crms_id: '1000' }],
                error: null,
              }),
            })),
          })),
        })),
      })),
    }

    const result = await runAutoPollRms({
      supabase,
      body: { mode: 'auto_poll_rms' },
    })

    expect(result.ok).toBe(true)
    expect(result.jobsFailed).toBe(1)
    expect(result.jobsSucceeded).toBe(1)
    expect(result.errors).toEqual([
      expect.objectContaining({ job_id: JOB_IN_WINDOW.id, message: 'RMS timeout' }),
    ])
  })

  test('runAutoPollRms rejects apply mode in Phase 1F.1A', async () => {
    const supabase = { from: jest.fn() }

    await expect(runAutoPollRms({
      supabase,
      body: { mode: 'auto_poll_rms', apply: true },
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})

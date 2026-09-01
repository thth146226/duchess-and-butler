import { createRoot } from 'react-dom/client'
import { act } from 'react'
import {
  OFFICE_REPORT_ACTOR_SCOPE_TYPE,
  OFFICE_REPORT_DONE_OBSERVER_POLL_MS,
  OFFICE_REPORT_ENTITY_TYPE,
  OFFICE_REPORT_QUEUE_ERROR_CODES,
  OFFICE_REPORT_SOURCE_SURFACES,
  buildOfficeReportStoragePath,
  createOfficeReportPhotoUploadQueueController,
  useOfficeReportPhotoUploadQueue,
} from './useOfficeReportPhotoUploadQueue'
import { PHOTO_UPLOAD_STATUSES } from '../lib/photoUploadDomain'

const SENTINEL_TOKEN = 'p9-sentinel-token-SECRET-never-persist'
const USER_ID = 'office-user-uuid-9'
const DIFFERENT_PROFILE_UUID = 'profile-uuid-NOT-session'
const REPORT_ID = 'report-44'
const FIXED_NOW = 1_910_000_000_000
const liveControllers = []

function makeFile(name, type, bytes = [1, 2, 3, 4]) {
  return new File([Uint8Array.from(bytes)], name, { type })
}

function collectStrings(value, out, seen) {
  if (value == null) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (typeof value !== 'object') return
  if (typeof Blob === 'function' && value instanceof Blob) return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, out, seen))
    return
  }
  Object.keys(value).forEach((key) => {
    collectStrings(key, out, seen)
    collectStrings(value[key], out, seen)
  })
}

function assertNoToken(value) {
  const strings = []
  collectStrings(value, strings, new Set())
  expect(strings.join('\n')).not.toContain(SENTINEL_TOKEN)
}

function createSessionClient({ userId = USER_ID, accessToken = SENTINEL_TOKEN } = {}) {
  return {
    auth: {
      getSession: jest.fn(async () => ({
        data: {
          session: userId
            ? { access_token: accessToken, refresh_token: 'refresh-SECRET', user: { id: userId } }
            : null,
        },
      })),
    },
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn(),
      })),
    },
    from: jest.fn(() => ({
      insert: jest.fn(),
    })),
  }
}

function createFakeTimers() {
  const scheduled = []
  let nextId = 0
  return {
    scheduled,
    setTimeoutImpl: (fn, ms) => {
      const id = (nextId += 1)
      scheduled.push({ id, fn, ms })
      return id
    },
    clearTimeoutImpl: (id) => {
      const index = scheduled.findIndex((row) => row.id === id)
      if (index >= 0) {
        scheduled.splice(index, 1)
      }
    },
    async flush() {
      const due = scheduled.splice(0)
      for (const row of due) {
        await row.fn()
      }
    },
  }
}

function createDeps(overrides = {}) {
  const events = []
  const putRecords = []
  const startCalls = []
  const stopCalls = []
  const closeCalls = []
  const remoteDone = []
  const transportUploads = []
  const recordsById = new Map()
  const timers = overrides.timers || createFakeTimers()
  const storeApi = {
    start: jest.fn(() => {
      events.push('start')
      startCalls.push(Date.now())
    }),
    stop: jest.fn(async () => {
      events.push('stop')
      stopCalls.push(true)
    }),
  }
  let capturedGetAccessToken = null
  const db = {
    putRecord: overrides.putRecord || (async (record) => {
      events.push('put')
      putRecords.push(record)
      recordsById.set(record.queue_id, { ...record, blob: record.blob, metadata_payload: { ...record.metadata_payload } })
    }),
    getRecord: overrides.getRecord || (async ({ queueId, actorScopeType, actorScopeId }) => {
      const record = recordsById.get(queueId)
      if (!record) return null
      if (record.actor_scope_type !== actorScopeType || record.actor_scope_id !== actorScopeId) {
        return null
      }
      return record
    }),
    listRecordsForActor: overrides.listRecordsForActor || (async ({ actorScopeType, actorScopeId }) => (
      Array.from(recordsById.values()).filter((record) => (
        record.actor_scope_type === actorScopeType && record.actor_scope_id === actorScopeId
      ))
    )),
    close: jest.fn(async () => {
      events.push('close')
      closeCalls.push(true)
    }),
  }
  const supabaseClient = overrides.supabaseClient || createSessionClient()
  const controller = createOfficeReportPhotoUploadQueueController({
    sourceSurface: overrides.sourceSurface || OFFICE_REPORT_SOURCE_SURFACES.OFFICE_REPORTS,
    supabaseClient,
    createDb: () => db,
    createTransport: overrides.createTransport || (() => ({
      upload: async (...args) => {
        transportUploads.push(args)
        return { ok: true }
      },
    })),
    createReconciler: () => ({}),
    createStore: overrides.createStore || ((opts) => {
      capturedGetAccessToken = opts.getAccessToken
      return storeApi
    }),
    now: overrides.now || (() => FIXED_NOW),
    randomUUID: overrides.randomUUID || (() => 'qid-1'),
    createLeaseOwner: () => 'lease-p9',
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    onRemoteDone: (payload) => { remoteDone.push(payload) },
  })
  liveControllers.push(controller)
  return {
    controller,
    events,
    putRecords,
    startCalls,
    stopCalls,
    closeCalls,
    remoteDone,
    transportUploads,
    recordsById,
    timers,
    supabaseClient,
    getAccessToken: () => capturedGetAccessToken,
  }
}

async function enqueueModeA(deps, extra = {}) {
  return deps.controller.enqueueFiles({
    files: extra.files || [makeFile('shot.jpg', 'image/jpeg')],
    reportId: extra.reportId === undefined ? REPORT_ID : extra.reportId,
    crmsRef: extra.crmsRef === undefined ? 'CRMS-9' : extra.crmsRef,
    eventName: extra.eventName === undefined ? 'Gala' : extra.eventName,
    profile: extra.profile === undefined ? { id: DIFFERENT_PROFILE_UUID, name: 'Admin Ada' } : extra.profile,
  })
}

afterEach(async () => {
  while (liveControllers.length) {
    const controller = liveControllers.pop()
    await controller.dispose()
  }
})

describe('useOfficeReportPhotoUploadQueue', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
  })

  test('controller does not expose MODE_B APIs', () => {
    const deps = createDeps()
    expect(deps.controller).not.toHaveProperty('proveReportId')
    expect(deps.controller).not.toHaveProperty('markReportResultAmbiguous')
    expect(typeof deps.controller.enqueueFiles).toBe('function')
    expect(typeof deps.controller.boot).toBe('function')
  })

  test('actor remains office_user and session.user.id', async () => {
    const deps = createDeps()
    await enqueueModeA(deps)
    expect(deps.putRecords[0].actor_scope_type).toBe(OFFICE_REPORT_ACTOR_SCOPE_TYPE)
    expect(deps.putRecords[0].actor_scope_id).toBe(USER_ID)
    expect(deps.putRecords[0].actor_scope_id).not.toBe(DIFFERENT_PROFILE_UUID)
  })

  test('missing session rejects before any DB write', async () => {
    const deps = createDeps({ supabaseClient: createSessionClient({ userId: null }) })
    const result = await enqueueModeA(deps)
    expect(result.rejected[0].code).toBe(OFFICE_REPORT_QUEUE_ERROR_CODES.AUTH_REQUIRED)
    expect(deps.putRecords).toHaveLength(0)
    expect(deps.startCalls).toHaveLength(0)
  })

  test('missing reportId rejects before DB write and does not wake runtime', async () => {
    const deps = createDeps()
    const result = await enqueueModeA(deps, { reportId: null })
    expect(result.accepted).toEqual([])
    expect(result.rejected[0].code).toBe(OFFICE_REPORT_QUEUE_ERROR_CODES.REPORT_ID_REQUIRED)
    expect(deps.putRecords).toHaveLength(0)
    expect(deps.startCalls).toHaveLength(0)
    expect(deps.transportUploads).toHaveLength(0)
  })

  test('empty reportId rejects before DB write', async () => {
    const deps = createDeps()
    const result = await enqueueModeA(deps, { reportId: '' })
    expect(result.rejected[0].code).toBe(OFFICE_REPORT_QUEUE_ERROR_CODES.REPORT_ID_REQUIRED)
    expect(deps.putRecords).toHaveLength(0)
    expect(deps.startCalls).toHaveLength(0)
  })

  test('source office_reports is accepted', async () => {
    const deps = createDeps({ sourceSurface: OFFICE_REPORT_SOURCE_SURFACES.OFFICE_REPORTS })
    const result = await enqueueModeA(deps)
    expect(result.accepted).toHaveLength(1)
    expect(deps.putRecords[0].source_surface).toBe('office_reports')
  })

  test('source office_schedule_report is accepted', async () => {
    const deps = createDeps({ sourceSurface: OFFICE_REPORT_SOURCE_SURFACES.OFFICE_SCHEDULE_REPORT })
    const result = await enqueueModeA(deps)
    expect(result.accepted).toHaveLength(1)
    expect(deps.putRecords[0].source_surface).toBe('office_schedule_report')
  })

  test('unsupported source is rejected before DB write', async () => {
    const deps = createDeps({ sourceSurface: 'office_evidence' })
    const result = await enqueueModeA(deps)
    expect(result.rejected[0].code).toBe(OFFICE_REPORT_QUEUE_ERROR_CODES.INVALID_SOURCE_SURFACE)
    expect(deps.putRecords).toHaveLength(0)
  })

  test('driver_evidence source is rejected', async () => {
    const deps = createDeps({ sourceSurface: 'driver_evidence' })
    const result = await enqueueModeA(deps)
    expect(result.rejected[0].code).toBe(OFFICE_REPORT_QUEUE_ERROR_CODES.INVALID_SOURCE_SURFACE)
    expect(deps.putRecords).toHaveLength(0)
  })

  test('exact reportId produces QUEUED with report entity_id and null provisional_id', async () => {
    const deps = createDeps()
    const result = await enqueueModeA(deps)
    expect(result.accepted[0].status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(deps.putRecords[0].status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(deps.putRecords[0].entity_type).toBe(OFFICE_REPORT_ENTITY_TYPE)
    expect(deps.putRecords[0].entity_id).toBe(REPORT_ID)
    expect(deps.putRecords[0].provisional_id).toBeNull()
    expect(deps.putRecords[0].storage_path).toBe(`reports/${REPORT_ID}/qid-1.jpg`)
    expect(buildOfficeReportStoragePath({
      reportId: REPORT_ID,
      queueId: 'qid-1',
      mimeType: 'image/jpeg',
    })).toBe(`reports/${REPORT_ID}/qid-1.jpg`)
  })

  test('putRecord happens before runtime wake', async () => {
    const deps = createDeps()
    await enqueueModeA(deps)
    expect(deps.events[0]).toBe('put')
    expect(deps.events[1]).toBe('start')
    expect(deps.startCalls).toHaveLength(1)
  })

  test('JPEG PNG and WebP are accepted', async () => {
    let n = 0
    const deps = createDeps({ randomUUID: () => `qid-${(n += 1)}` })
    const result = await enqueueModeA(deps, {
      files: [
        makeFile('a.jpg', 'image/jpeg'),
        makeFile('b.png', 'image/png'),
        makeFile('c.webp', 'image/webp'),
      ],
    })
    expect(result.accepted).toHaveLength(3)
  })

  test('HEIC HEIF and unknown MIME are rejected', async () => {
    const deps = createDeps()
    const result = await enqueueModeA(deps, {
      files: [
        makeFile('a.heic', 'image/heic'),
        makeFile('b.heif', 'image/heif'),
        makeFile('c.bin', ''),
      ],
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toHaveLength(3)
    expect(deps.putRecords).toHaveLength(0)
  })

  test('MIME controls extension and original filename is not path authority', async () => {
    const deps = createDeps()
    await enqueueModeA(deps, { files: [makeFile('pretty photo.JPEG', 'image/jpeg')] })
    expect(deps.putRecords[0].storage_path).toBe(`reports/${REPORT_ID}/qid-1.jpg`)
    expect(deps.putRecords[0].storage_path).not.toContain('pretty')
  })

  test('access token is retrieved just in time and never persisted on the record', async () => {
    const deps = createDeps()
    await enqueueModeA(deps)
    assertNoToken(deps.putRecords[0])
    assertNoToken(deps.putRecords[0].metadata_payload)
    const token = await deps.getAccessToken()()
    expect(token).toBe(SENTINEL_TOKEN)
  })

  test('metadata omits secrets uploaded_by file_path photo_url and provisional_id', async () => {
    const deps = createDeps()
    await enqueueModeA(deps)
    const meta = deps.putRecords[0].metadata_payload
    expect(meta.order_id).toBe(REPORT_ID)
    expect(meta.run_type).toBe('after_col')
    expect(meta.uploaded_by_name).toBe('Admin Ada')
    expect(meta).not.toHaveProperty('uploaded_by')
    expect(meta).not.toHaveProperty('provisional_id')
    expect(meta).not.toHaveProperty('access_token')
  })

  test('partial queue write failure preserves accepted records and has no legacy fallback', async () => {
    let n = 0
    const deps = createDeps({
      randomUUID: () => `qid-${(n += 1)}`,
      putRecord: async (record) => {
        if (record.queue_id === 'qid-2') {
          throw new Error('idb full')
        }
        deps.putRecords.push(record)
        deps.recordsById.set(record.queue_id, record)
      },
    })
    const result = await enqueueModeA(deps, {
      files: [
        makeFile('a.jpg', 'image/jpeg'),
        makeFile('b.png', 'image/png'),
        makeFile('c.webp', 'image/webp'),
      ],
    })
    expect(result.accepted.map((row) => row.queueId)).toEqual(['qid-1', 'qid-3'])
    expect(result.rejected).toHaveLength(1)
    expect(deps.supabaseClient.storage.from).not.toHaveBeenCalled()
    expect(deps.supabaseClient.from).not.toHaveBeenCalled()
  })

  test('DONE observer is read-only and emits exactly once per queue id', async () => {
    const deps = createDeps()
    await enqueueModeA(deps)
    expect(deps.remoteDone).toHaveLength(0)
    deps.recordsById.get('qid-1').status = PHOTO_UPLOAD_STATUSES.QUEUED
    await deps.controller.inspectPending()
    expect(deps.remoteDone).toHaveLength(0)
    deps.recordsById.get('qid-1').status = PHOTO_UPLOAD_STATUSES.DONE
    await deps.controller.inspectPending()
    expect(deps.remoteDone).toEqual([{
      queue_id: 'qid-1',
      entity_id: REPORT_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }])
    await deps.controller.inspectPending()
    expect(deps.remoteDone).toHaveLength(1)
  })

  test('observer does not emit DONE for a different source surface', async () => {
    const deps = createDeps()
    await enqueueModeA(deps)
    deps.recordsById.get('qid-1').source_surface = 'office_evidence'
    deps.recordsById.get('qid-1').status = PHOTO_UPLOAD_STATUSES.DONE
    await deps.controller.inspectPending()
    expect(deps.remoteDone).toHaveLength(0)
  })

  test('unrelated queue id does not notify current caller', async () => {
    const deps = createDeps()
    await enqueueModeA(deps)
    const tracked = deps.recordsById.get('qid-1')
    deps.recordsById.set('qid-other', {
      ...tracked,
      queue_id: 'qid-other',
      entity_id: 'report-OTHER',
      status: PHOTO_UPLOAD_STATUSES.DONE,
    })
    await deps.controller.inspectPending()
    expect(deps.remoteDone).toHaveLength(0)
  })

  test('runtime stops and observer timers clear on dispose', async () => {
    const deps = createDeps()
    await enqueueModeA(deps)
    expect(deps.timers.scheduled.some((row) => row.ms === OFFICE_REPORT_DONE_OBSERVER_POLL_MS)).toBe(true)
    await deps.controller.dispose()
    expect(deps.stopCalls).toHaveLength(1)
    expect(deps.closeCalls).toHaveLength(1)
    expect(deps.timers.scheduled).toHaveLength(0)
    expect(deps.controller.getObserverTimerPending()).toBe(false)
  })

  test('hook enqueueFiles uses current reportId and clears timers on unmount', async () => {
    const timers = createFakeTimers()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const results = []
    const enqueueFilesRef = { current: null }
    function Probe() {
      const api = useOfficeReportPhotoUploadQueue({
        sourceSurface: OFFICE_REPORT_SOURCE_SURFACES.OFFICE_REPORTS,
        reportId: REPORT_ID,
        crmsRef: 'CRMS-9',
        eventName: 'Gala',
        profile: { id: DIFFERENT_PROFILE_UUID, name: 'Admin Ada' },
        supabaseClient: createSessionClient(),
        createDb: () => ({
          putRecord: async (record) => { results.push(record) },
          getRecord: async () => null,
          listRecordsForActor: async () => [],
          close: async () => {},
        }),
        createTransport: () => ({}),
        createReconciler: () => ({}),
        createStore: () => ({
          start: jest.fn(),
          stop: jest.fn(async () => {}),
        }),
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-hook',
        createLeaseOwner: () => 'lease-hook',
        setTimeoutImpl: timers.setTimeoutImpl,
        clearTimeoutImpl: timers.clearTimeoutImpl,
      })
      expect(api).not.toHaveProperty('proveReportId')
      expect(api).not.toHaveProperty('markReportResultAmbiguous')
      enqueueFilesRef.current = api.enqueueFiles
      return null
    }
    await act(async () => {
      root.render(<Probe />)
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      await enqueueFilesRef.current([makeFile('a.jpg', 'image/jpeg')])
    })
    expect(results[0].entity_id).toBe(REPORT_ID)
    expect(results[0].provisional_id).toBeNull()
    await act(async () => {
      root.unmount()
    })
    await act(async () => { await Promise.resolve() })
    expect(timers.scheduled).toHaveLength(0)
  })
})

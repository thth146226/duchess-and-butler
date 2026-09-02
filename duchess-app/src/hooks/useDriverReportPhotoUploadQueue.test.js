import { createRoot } from 'react-dom/client'
import { act } from 'react'
import {
  DRIVER_REPORT_ACTOR_SCOPE_TYPE,
  DRIVER_REPORT_DONE_OBSERVER_POLL_MS,
  DRIVER_REPORT_ENTITY_TYPE,
  DRIVER_REPORT_QUEUE_ERROR_CODES,
  DRIVER_REPORT_SOURCE_SURFACES,
  buildDriverReportStoragePath,
  createDriverReportPhotoUploadQueueController,
  useDriverReportPhotoUploadQueue,
} from './useDriverReportPhotoUploadQueue'
import { PHOTO_UPLOAD_EVENTS, PHOTO_UPLOAD_STATUSES, transitionPhotoUpload } from '../lib/photoUploadDomain'

const SENTINEL_TOKEN = 'p10-sentinel-token-SECRET-never-persist'
const PORTAL_TOKEN = 'p10-portal-token-SECRET'
const DRIVER_ID = 'driver-id-aaa'
const REPORT_ID = 'report-99'
const PROVISIONAL_ID = 'prov-report-1'
const FIXED_NOW = 1_920_000_000_000
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

function assertNoSecret(value) {
  const strings = []
  collectStrings(value, strings, new Set())
  const joined = strings.join('\n')
  expect(joined).not.toContain(SENTINEL_TOKEN)
  expect(joined).not.toContain(PORTAL_TOKEN)
}

function createSessionClient({ accessToken = SENTINEL_TOKEN } = {}) {
  const unsubscribe = jest.fn()
  return {
    supabaseKey: 'anon-key-SENTINEL',
    auth: {
      getSession: jest.fn(async () => ({
        data: {
          session: accessToken
            ? { access_token: accessToken, refresh_token: 'refresh-SECRET', user: { id: 'session-user' } }
            : null,
        },
      })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe } },
      })),
    },
    storage: { from: jest.fn(() => ({ upload: jest.fn() })) },
    from: jest.fn(() => ({ insert: jest.fn() })),
    _authUnsubscribe: unsubscribe,
  }
}

async function flushWake(times = 40) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
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
      if (index >= 0) scheduled.splice(index, 1)
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
    resumePausedUploads: jest.fn(async () => ({ resumed: 0 })),
  }
  let capturedGetAccessToken = null
  const deleteCalls = []
  const listCalls = []
  const db = {
    putRecord: overrides.putRecord || (async (record) => {
      events.push('put')
      putRecords.push(record)
      recordsById.set(record.queue_id, {
        ...record,
        blob: record.blob,
        metadata_payload: { ...record.metadata_payload },
      })
    }),
    getRecord: overrides.getRecord || (async ({ queueId, actorScopeType, actorScopeId }) => {
      const record = recordsById.get(queueId)
      if (!record) return null
      if (record.actor_scope_type !== actorScopeType || record.actor_scope_id !== actorScopeId) {
        return null
      }
      return record
    }),
    listRecordsForActor: overrides.listRecordsForActor || (async ({ actorScopeType, actorScopeId }) => {
      listCalls.push({ actorScopeType, actorScopeId })
      return Array.from(recordsById.values()).filter((record) => (
        record.actor_scope_type === actorScopeType && record.actor_scope_id === actorScopeId
      ))
    }),
    deleteLocalRecord: overrides.deleteLocalRecord || (async ({ queueId, actorScopeType, actorScopeId }) => {
      deleteCalls.push({ queueId, actorScopeType, actorScopeId })
      const record = recordsById.get(queueId)
      if (!record) return
      if (record.actor_scope_type !== actorScopeType || record.actor_scope_id !== actorScopeId) {
        throw new Error('actor conflict')
      }
      recordsById.delete(queueId)
    }),
    close: jest.fn(async () => {
      events.push('close')
      closeCalls.push(true)
    }),
  }
  const supabaseClient = overrides.supabaseClient || createSessionClient()
  const controller = createDriverReportPhotoUploadQueueController({
    sourceSurface: overrides.sourceSurface || DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_TAB,
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
    createLeaseOwner: () => 'lease-p10',
    isOnline: overrides.isOnline || (() => true),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    onRemoteDone: (payload) => { remoteDone.push(payload) },
  })
  liveControllers.push(controller)
  return {
    controller,
    storeApi,
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
    db,
    deleteCalls,
    listCalls,
  }
}

async function enqueueTab(deps, extra = {}) {
  return deps.controller.enqueueFiles({
    files: extra.files || [makeFile('shot.jpg', 'image/jpeg')],
    driverId: extra.driverId === undefined ? DRIVER_ID : extra.driverId,
    reportId: extra.reportId === undefined ? REPORT_ID : extra.reportId,
    driverName: extra.driverName === undefined ? 'Pat' : extra.driverName,
    eventName: extra.eventName === undefined ? 'Gala' : extra.eventName,
  })
}

async function enqueueModeB(deps, extra = {}) {
  return deps.controller.enqueueFiles({
    files: extra.files || [makeFile('shot.jpg', 'image/jpeg')],
    driverId: extra.driverId === undefined ? DRIVER_ID : extra.driverId,
    provisionalId: extra.provisionalId === undefined ? PROVISIONAL_ID : extra.provisionalId,
    driverName: extra.driverName === undefined ? 'Pat' : extra.driverName,
    eventName: extra.eventName === undefined ? 'Gala' : extra.eventName,
    crmsRef: extra.crmsRef === undefined ? 'CRMS-9' : extra.crmsRef,
  })
}

afterEach(async () => {
  while (liveControllers.length) {
    const controller = liveControllers.pop()
    await controller.dispose()
  }
})

describe('useDriverReportPhotoUploadQueue', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
  })

  test('actor remains driver_portal and driver.id', async () => {
    const deps = createDeps()
    await enqueueTab(deps)
    expect(deps.putRecords[0].actor_scope_type).toBe(DRIVER_REPORT_ACTOR_SCOPE_TYPE)
    expect(deps.putRecords[0].actor_scope_id).toBe(DRIVER_ID)
    expect(deps.putRecords[0].actor_scope_id).not.toBe(REPORT_ID)
  })

  test('missing driver.id rejects before any DB write', async () => {
    const deps = createDeps()
    const result = await enqueueTab(deps, { driverId: null })
    expect(result.rejected[0].code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED)
    expect(deps.putRecords).toHaveLength(0)
    expect(deps.startCalls).toHaveLength(0)
  })

  test('entity_type is report', async () => {
    const deps = createDeps()
    await enqueueTab(deps)
    expect(deps.putRecords[0].entity_type).toBe(DRIVER_REPORT_ENTITY_TYPE)
  })

  test('source driver_report_tab is accepted', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_TAB })
    const result = await enqueueTab(deps)
    expect(result.accepted).toHaveLength(1)
    expect(deps.putRecords[0].source_surface).toBe('driver_report_tab')
  })

  test('source driver_report_mode is accepted', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    const result = await enqueueModeB(deps)
    expect(result.accepted).toHaveLength(1)
    expect(deps.putRecords[0].source_surface).toBe('driver_report_mode')
  })

  test('unsupported source is rejected before DB write', async () => {
    const deps = createDeps({ sourceSurface: 'driver_evidence' })
    const result = await enqueueTab(deps)
    expect(result.rejected[0].code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.INVALID_SOURCE_SURFACE)
    expect(deps.putRecords).toHaveLength(0)
  })

  test('JPEG PNG and WebP are accepted', async () => {
    let n = 0
    const deps = createDeps({ randomUUID: () => `qid-${(n += 1)}` })
    const result = await enqueueTab(deps, {
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
    const result = await enqueueTab(deps, {
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

  test('original filename is not path authority', async () => {
    const deps = createDeps()
    await enqueueTab(deps, { files: [makeFile('pretty photo.JPEG', 'image/jpeg')] })
    expect(deps.putRecords[0].storage_path).toBe(`reports/${REPORT_ID}/qid-1.jpg`)
    expect(deps.putRecords[0].storage_path).not.toContain('pretty')
  })

  test('access token is retrieved just in time and never persisted', async () => {
    const deps = createDeps()
    await enqueueTab(deps)
    assertNoSecret(deps.putRecords[0])
    assertNoSecret(deps.putRecords[0].metadata_payload)
    const token = await deps.getAccessToken()()
    expect(token).toBe(SENTINEL_TOKEN)
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
    const result = await enqueueTab(deps, {
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

  test('MODE_A putRecord happens before runtime wake', async () => {
    const deps = createDeps()
    await enqueueTab(deps)
    expect(deps.events[0]).toBe('put')
    expect(deps.events[1]).toBe('start')
  })

  test('DONE observer is read-only and emits exactly once per queue id', async () => {
    const deps = createDeps()
    await enqueueTab(deps)
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

  test('runtime stops and observer timers clear on dispose', async () => {
    const deps = createDeps()
    await enqueueTab(deps)
    expect(deps.timers.scheduled.some((row) => row.ms === DRIVER_REPORT_DONE_OBSERVER_POLL_MS)).toBe(true)
    await deps.controller.dispose()
    expect(deps.stopCalls).toHaveLength(1)
    expect(deps.closeCalls).toHaveLength(1)
    expect(deps.timers.scheduled).toHaveLength(0)
  })

  test('MODE_B draft enqueue writes DRAFT_QUEUED with null entity and path and zero transport', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    const result = await enqueueModeB(deps)
    expect(result.accepted[0].status).toBe(PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED)
    expect(deps.putRecords[0].status).toBe(PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED)
    expect(deps.putRecords[0].entity_id).toBeNull()
    expect(deps.putRecords[0].storage_path).toBeNull()
    expect(deps.putRecords[0].provisional_id).toBe(PROVISIONAL_ID)
    expect(deps.putRecords[0].upload_attempt_count).toBe(0)
    expect(deps.putRecords[0].db_attempt_count).toBe(0)
    expect(deps.startCalls).toHaveLength(0)
    expect(deps.transportUploads).toHaveLength(0)
  })

  test('MODE_B missing provisional id rejects before DB write', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    const result = await enqueueModeB(deps, { provisionalId: null })
    expect(result.rejected[0].code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.PROVISIONAL_ID_REQUIRED)
    expect(deps.putRecords).toHaveLength(0)
    expect(deps.startCalls).toHaveLength(0)
  })

  test('multiple draft photos share provisional id with distinct queue ids', async () => {
    let n = 0
    const deps = createDeps({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      randomUUID: () => `qid-${(n += 1)}`,
    })
    await enqueueModeB(deps, {
      files: [
        makeFile('a.jpg', 'image/jpeg'),
        makeFile('b.png', 'image/png'),
      ],
    })
    expect(deps.putRecords).toHaveLength(2)
    expect(deps.putRecords[0].provisional_id).toBe(PROVISIONAL_ID)
    expect(deps.putRecords[1].provisional_id).toBe(PROVISIONAL_ID)
    expect(deps.putRecords[0].queue_id).toBe('qid-1')
    expect(deps.putRecords[1].queue_id).toBe('qid-2')
    expect(deps.putRecords[0].queue_id).not.toBe(PROVISIONAL_ID)
  })

  test('REPORT_ID_PROVEN links drafts to QUEUED exact path before runtime wake', async () => {
    let n = 0
    const deps = createDeps({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      randomUUID: () => `qid-${(n += 1)}`,
    })
    await enqueueModeB(deps, {
      files: [makeFile('a.jpg', 'image/jpeg'), makeFile('b.png', 'image/png')],
    })
    const blobs = deps.putRecords.map((row) => row.blob)
    const result = await deps.controller.proveReportId({
      driverId: DRIVER_ID,
      provisionalId: PROVISIONAL_ID,
      reportId: REPORT_ID,
    })
    expect(result.linked).toHaveLength(2)
    expect(deps.putRecords[2].status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(deps.putRecords[2].entity_id).toBe(REPORT_ID)
    expect(deps.putRecords[2].storage_path).toBe(`reports/${REPORT_ID}/qid-1.jpg`)
    expect(deps.putRecords[2].queue_id).toBe('qid-1')
    expect(deps.putRecords[2].blob).toBe(blobs[0])
    expect(buildDriverReportStoragePath({
      reportId: REPORT_ID,
      queueId: 'qid-2',
      mimeType: 'image/png',
    })).toBe(`reports/${REPORT_ID}/qid-2.png`)
    const startIndex = deps.events.indexOf('start')
    const lastPutIndex = deps.events.lastIndexOf('put')
    expect(startIndex).toBeGreaterThan(lastPutIndex - 2)
    expect(deps.events.filter((row) => row === 'put').length).toBeGreaterThan(0)
    expect(deps.events.indexOf('start')).toBeGreaterThan(deps.events.indexOf('put'))
    expect(deps.transportUploads).toHaveLength(0)
  })

  test('partial link failure preserves failed draft and linked QUEUED records', async () => {
    let n = 0
    const recordsById = new Map()
    const putRecords = []
    const deps = createDeps({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      randomUUID: () => `qid-${(n += 1)}`,
      putRecord: async (record) => {
        if (record.queue_id === 'qid-2' && record.status === PHOTO_UPLOAD_STATUSES.QUEUED) {
          throw new Error('link fail')
        }
        putRecords.push(record)
        recordsById.set(record.queue_id, record)
      },
      getRecord: async ({ queueId }) => recordsById.get(queueId) || null,
      listRecordsForActor: async () => Array.from(recordsById.values()),
    })
    await enqueueModeB(deps, {
      files: [
        makeFile('a.jpg', 'image/jpeg'),
        makeFile('b.png', 'image/png'),
        makeFile('c.webp', 'image/webp'),
      ],
    })
    const result = await deps.controller.proveReportId({
      driverId: DRIVER_ID,
      provisionalId: PROVISIONAL_ID,
      reportId: REPORT_ID,
    })
    expect(result.linked.map((row) => row.queueId)).toEqual(['qid-1', 'qid-3'])
    expect(result.failed).toHaveLength(1)
    expect(recordsById.get('qid-2').status).toBe(PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED)
    expect(recordsById.get('qid-1').status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(deps.transportUploads).toHaveLength(0)
  })

  test('ambiguous result moves drafts to REPORT_LINK_UNKNOWN with zero transport', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    const result = await deps.controller.markReportResultAmbiguous({
      driverId: DRIVER_ID,
      provisionalId: PROVISIONAL_ID,
    })
    expect(result.updated[0].status).toBe(PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN)
    expect(deps.recordsById.get('qid-1').status).toBe(PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN)
    expect(deps.recordsById.get('qid-1').entity_id).toBeNull()
    expect(deps.recordsById.get('qid-1').storage_path).toBeNull()
    expect(deps.startCalls).toHaveLength(0)
    expect(deps.transportUploads).toHaveLength(0)
  })

  test('later proven id recovers REPORT_LINK_UNKNOWN to QUEUED', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    await deps.controller.markReportResultAmbiguous({
      driverId: DRIVER_ID,
      provisionalId: PROVISIONAL_ID,
    })
    const result = await deps.controller.proveReportId({
      driverId: DRIVER_ID,
      provisionalId: PROVISIONAL_ID,
      reportId: REPORT_ID,
    })
    expect(result.linked[0].status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(deps.recordsById.get('qid-1').entity_id).toBe(REPORT_ID)
    expect(deps.recordsById.get('qid-1').storage_path).toBe(`reports/${REPORT_ID}/qid-1.jpg`)
  })

  test('controller never creates a business report', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    await deps.controller.proveReportId({
      driverId: DRIVER_ID,
      provisionalId: PROVISIONAL_ID,
      reportId: REPORT_ID,
    })
    expect(deps.supabaseClient.from).not.toHaveBeenCalled()
  })

  test('P11A actor is driver.id and resume is additive', async () => {
    const deps = createDeps()
    await deps.controller.boot({ driverId: DRIVER_ID })
    expect(deps.controller.getActorScopeId()).toBe(DRIVER_ID)
    expect(deps.storeApi.start).toHaveBeenCalled()
    expect(deps.storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
    const result = await enqueueTab(deps)
    expect(result.accepted).toHaveLength(1)
    expect(deps.putRecords[0].actor_scope_id).toBe(DRIVER_ID)
  })

  test('P11A online listener is registered and removed on cleanup', async () => {
    const addSpy = jest.spyOn(window, 'addEventListener')
    const removeSpy = jest.spyOn(window, 'removeEventListener')
    const deps = createDeps()
    await deps.controller.boot({ driverId: DRIVER_ID })
    expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function))
    await deps.controller.dispose()
    expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function))
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  test('P11A online event calls guarded resume', async () => {
    const deps = createDeps()
    await deps.controller.boot({ driverId: DRIVER_ID })
    deps.storeApi.resumePausedUploads.mockClear()
    window.dispatchEvent(new Event('online'))
    await flushWake()
    expect(deps.storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
  })

  test('P11A offline boot does not resume', async () => {
    const deps = createDeps({ isOnline: () => false })
    await deps.controller.boot({ driverId: DRIVER_ID })
    expect(deps.storeApi.start).toHaveBeenCalled()
    expect(deps.storeApi.resumePausedUploads).not.toHaveBeenCalled()
  })

  test('P11A online boot resumes when credentials are ready', async () => {
    const deps = createDeps()
    await deps.controller.boot({ driverId: DRIVER_ID })
    expect(deps.storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
  })

  test('P11A credential failure leaves paused state and does not reject', async () => {
    const supabaseClient = createSessionClient({ accessToken: null })
    supabaseClient.supabaseKey = ''
    const deps = createDeps({ supabaseClient })
    await expect(deps.controller.boot({ driverId: DRIVER_ID })).resolves.toBeUndefined()
    expect(deps.storeApi.resumePausedUploads).not.toHaveBeenCalled()
  })

  test('P11A resume rejection does not become an unhandled rejection', async () => {
    const deps = createDeps()
    deps.storeApi.resumePausedUploads.mockImplementation(async () => {
      throw new Error('resume failed')
    })
    await expect(deps.controller.boot({ driverId: DRIVER_ID })).resolves.toBeUndefined()
  })

  test('P11A auth-change wake is subscribed and cleaned up', async () => {
    const deps = createDeps()
    await deps.controller.boot({ driverId: DRIVER_ID })
    expect(deps.supabaseClient.auth.onAuthStateChange).toHaveBeenCalled()
    deps.storeApi.resumePausedUploads.mockClear()
    const onChange = deps.supabaseClient.auth.onAuthStateChange.mock.calls[0][0]
    onChange('SIGNED_IN')
    await flushWake()
    expect(deps.storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
    await deps.controller.dispose()
    expect(deps.supabaseClient._authUnsubscribe).toHaveBeenCalled()
  })

  test('P11A old driver actor is not resumed after identity change', async () => {
    const deps = createDeps()
    await deps.controller.boot({ driverId: DRIVER_ID })
    await deps.controller.boot({ driverId: 'driver-id-bbb' })
    expect(deps.controller.getActorScopeId()).toBe('driver-id-bbb')
    expect(deps.storeApi.stop).toHaveBeenCalled()
    deps.storeApi.resumePausedUploads.mockClear()
    window.dispatchEvent(new Event('online'))
    await flushWake()
    expect(deps.storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
    expect(deps.controller.getActorScopeId()).not.toBe(DRIVER_ID)
  })

  test('P11A portal token is not TUS bearer and no token is persisted', async () => {
    const deps = createDeps()
    await deps.controller.boot({ driverId: DRIVER_ID })
    const token = await deps.getAccessToken()()
    expect(token).toBe(SENTINEL_TOKEN)
    expect(token).not.toBe(PORTAL_TOKEN)
    assertNoSecret(deps.storeApi)
    assertNoSecret(deps.controller.getActorScopeId())
  })

  test('hook enqueueFiles uses driver.id and clears timers on unmount', async () => {
    const timers = createFakeTimers()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const results = []
    const enqueueFilesRef = { current: null }
    function Probe() {
      const api = useDriverReportPhotoUploadQueue({
        sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_TAB,
        driverId: DRIVER_ID,
        reportId: REPORT_ID,
        driverName: 'Pat',
        eventName: 'Gala',
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
    expect(results[0].actor_scope_id).toBe(DRIVER_ID)
    expect(results[0].entity_id).toBe(REPORT_ID)
    expect(results[0].entity_id).not.toBe(DRIVER_ID)
    await act(async () => {
      root.unmount()
    })
    await act(async () => { await Promise.resolve() })
    expect(timers.scheduled).toHaveLength(0)
  })

  test('discardNeverUploadedDrafts is exposed on controller and hook', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    expect(typeof deps.controller.discardNeverUploadedDrafts).toBe('function')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const apiRef = { current: null }
    function Probe() {
      apiRef.current = useDriverReportPhotoUploadQueue({
        sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
        driverId: DRIVER_ID,
        provisionalId: PROVISIONAL_ID,
        supabaseClient: createSessionClient(),
        createDb: () => ({
          putRecord: async () => {},
          getRecord: async () => null,
          listRecordsForActor: async () => [],
          deleteLocalRecord: async () => {},
          close: async () => {},
        }),
        createTransport: () => ({}),
        createReconciler: () => ({}),
        createStore: () => ({ start: jest.fn(), stop: jest.fn(async () => {}) }),
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-hook-discard',
        createLeaseOwner: () => 'lease-hook-discard',
      })
      return null
    }
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await Promise.resolve() })
    expect(typeof apiRef.current.discardNeverUploadedDrafts).toBe('function')
    await act(async () => { root.unmount() })
  })

  test('discard missing driver.id lists and deletes zero records', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED)
    expect(result.deleted).toEqual([])
    expect(deps.listCalls).toHaveLength(0)
    expect(deps.deleteCalls).toHaveLength(0)
    expect(deps.transportUploads).toHaveLength(0)
  })

  test('discard missing driver.id on hook does not list or delete', async () => {
    const listRecordsForActor = jest.fn(async () => [])
    const deleteLocalRecord = jest.fn(async () => {})
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const apiRef = { current: null }
    function Probe() {
      apiRef.current = useDriverReportPhotoUploadQueue({
        sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
        driverId: null,
        provisionalId: PROVISIONAL_ID,
        supabaseClient: createSessionClient(),
        createDb: () => ({
          putRecord: async () => {},
          getRecord: async () => null,
          listRecordsForActor,
          deleteLocalRecord,
          close: async () => {},
        }),
        createTransport: () => ({}),
        createReconciler: () => ({}),
        createStore: () => ({ start: jest.fn(), stop: jest.fn(async () => {}) }),
      })
      return null
    }
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await Promise.resolve() })
    const result = await apiRef.current.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED)
    expect(listRecordsForActor).not.toHaveBeenCalled()
    expect(deleteLocalRecord).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })

  test('discard invalid provisionalId deletes zero records', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    const startDeletes = deps.deleteCalls.length
    const missing = await deps.controller.discardNeverUploadedDrafts({ provisionalId: null })
    const empty = await deps.controller.discardNeverUploadedDrafts({ provisionalId: '' })
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.PROVISIONAL_ID_REQUIRED)
    expect(empty.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.PROVISIONAL_ID_REQUIRED)
    expect(missing.deleted).toEqual([])
    expect(deps.deleteCalls).toHaveLength(startDeletes)
    expect(deps.transportUploads).toHaveLength(0)
    expect(deps.recordsById.has('qid-1')).toBe(true)
  })

  test('discard lists only actor-scoped driver_portal records', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    deps.recordsById.set('other-actor', {
      ...deps.recordsById.get('qid-1'),
      queue_id: 'other-actor',
      actor_scope_id: 'driver-id-bbb',
    })
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(true)
    expect(result.deleted).toEqual(['qid-1'])
    expect(deps.listCalls[0]).toEqual({
      actorScopeType: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
      actorScopeId: DRIVER_ID,
    })
    expect(deps.deleteCalls[0]).toEqual({
      queueId: 'qid-1',
      actorScopeType: 'driver_portal',
      actorScopeId: DRIVER_ID,
    })
    expect(deps.recordsById.has('other-actor')).toBe(true)
    expect(deps.recordsById.has('qid-1')).toBe(false)
  })

  test('discard deletes only exact never-uploaded driver_report_mode drafts', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(true)
    expect(result.deleted).toEqual(['qid-1'])
    expect(deps.recordsById.has('qid-1')).toBe(false)
    expect(deps.startCalls).toHaveLength(0)
    expect(deps.transportUploads).toHaveLength(0)
    expect(deps.supabaseClient.from).not.toHaveBeenCalled()
    expect(deps.supabaseClient.storage.from).not.toHaveBeenCalled()
    expect(transitionPhotoUpload(
      PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED,
      PHOTO_UPLOAD_EVENTS.DISCARD_REQUESTED,
    )).toEqual({ kind: 'DELETE_LOCAL' })
  })

  test('discard deletes two safe drafts under the same provisional id', async () => {
    let n = 0
    const deps = createDeps({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      randomUUID: () => `qid-${(n += 1)}`,
    })
    await enqueueModeB(deps, {
      files: [makeFile('a.jpg', 'image/jpeg'), makeFile('b.png', 'image/png')],
    })
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(true)
    expect(result.deleted).toEqual(['qid-1', 'qid-2'])
    expect(deps.recordsById.size).toBe(0)
    expect(deps.deleteCalls).toHaveLength(2)
  })

  test('discard leaves a different provisional id untouched', async () => {
    let n = 0
    const deps = createDeps({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      randomUUID: () => `qid-${(n += 1)}`,
    })
    await enqueueModeB(deps, { files: [makeFile('a.jpg', 'image/jpeg')] })
    await enqueueModeB(deps, {
      files: [makeFile('b.png', 'image/png')],
      provisionalId: 'prov-other',
    })
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.deleted).toEqual(['qid-1'])
    expect(deps.recordsById.has('qid-2')).toBe(true)
    expect(deps.recordsById.get('qid-2').provisional_id).toBe('prov-other')
  })

  test('discard leaves another source surface untouched', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    deps.recordsById.set('tab-1', {
      ...deps.recordsById.get('qid-1'),
      queue_id: 'tab-1',
      source_surface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_TAB,
    })
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(true)
    expect(result.deleted).toEqual(['qid-1'])
    expect(deps.recordsById.has('tab-1')).toBe(true)
    expect(deps.deleteCalls.every((row) => row.queueId !== 'tab-1')).toBe(true)
  })

  test('zero same-provisional rows is a successful no-op', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await deps.controller.boot({ driverId: DRIVER_ID })
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(true)
    expect(result.deleted).toEqual([])
    expect(deps.deleteCalls).toHaveLength(0)
  })
})

describe('useDriverReportPhotoUploadQueue discard never-uploaded drafts', () => {
  function expectNoRemoteMutation(deps) {
    expect(deps.transportUploads).toHaveLength(0)
    expect(deps.supabaseClient.from).not.toHaveBeenCalled()
    expect(deps.supabaseClient.storage.from).not.toHaveBeenCalled()
    expect(deps.startCalls).toHaveLength(0)
  }

  async function draftDeps(mutate) {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    if (mutate) mutate(deps.recordsById.get('qid-1'))
    return deps
  }

  const unsafeFieldCases = [
    ['entity_id non-null', (record) => { record.entity_id = REPORT_ID }],
    ['storage_path non-null', (record) => { record.storage_path = 'reports/x/qid-1.jpg' }],
    ['upload_attempt_count > 0', (record) => { record.upload_attempt_count = 1 }],
    ['tus_upload_url non-null', (record) => { record.tus_upload_url = 'https://tus.example/u' }],
    ['remote_public_url non-null', (record) => { record.remote_public_url = 'https://cdn.example/p.jpg' }],
    ['db_row_id non-null', (record) => { record.db_row_id = 'row-1' }],
  ]

  test.each(unsafeFieldCases)('unsafe field %s blocks the entire composition', async (_name, mutate) => {
    const deps = await draftDeps(mutate)
    const before = { ...deps.recordsById.get('qid-1') }
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.UNSAFE_COMPOSITION)
    expect(result.deleted).toEqual([])
    expect(deps.deleteCalls).toHaveLength(0)
    expect(deps.recordsById.get('qid-1')).toEqual(before)
    expectNoRemoteMutation(deps)
  })

  const unsafeStatusCases = [
    PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN,
    PHOTO_UPLOAD_STATUSES.QUEUED,
    PHOTO_UPLOAD_STATUSES.UPLOADING,
    PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED,
    PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD,
    PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE,
    PHOTO_UPLOAD_STATUSES.DB_PENDING,
    PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT,
    PHOTO_UPLOAD_STATUSES.FAILED_DB,
    PHOTO_UPLOAD_STATUSES.DONE,
  ]

  test.each(unsafeStatusCases)('status %s blocks the entire composition', async (status) => {
    const deps = await draftDeps((record) => { record.status = status })
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.UNSAFE_COMPOSITION)
    expect(result.deleted).toEqual([])
    expect(deps.deleteCalls).toHaveLength(0)
    expect(deps.recordsById.get('qid-1').status).toBe(status)
    expectNoRemoteMutation(deps)
  })

  test('mixed safe and unsafe composition deletes zero rows', async () => {
    let n = 0
    const deps = createDeps({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      randomUUID: () => `qid-${(n += 1)}`,
    })
    await enqueueModeB(deps, {
      files: [makeFile('a.jpg', 'image/jpeg'), makeFile('b.png', 'image/png')],
    })
    deps.recordsById.get('qid-2').status = PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.UNSAFE_COMPOSITION)
    expect(result.deleted).toEqual([])
    expect(deps.deleteCalls).toHaveLength(0)
    expect(deps.recordsById.get('qid-1').status).toBe(PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED)
    expect(deps.recordsById.get('qid-2').status).toBe(PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN)
    expectNoRemoteMutation(deps)
  })

  test('does not write DISCARD_PENDING or mutate attempt counters', async () => {
    const deps = await draftDeps()
    const attemptsBefore = deps.recordsById.get('qid-1').upload_attempt_count
    const dbAttemptsBefore = deps.recordsById.get('qid-1').db_attempt_count
    await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(deps.putRecords.every((row) => row.status !== PHOTO_UPLOAD_STATUSES.DISCARD_PENDING)).toBe(true)
    expect(attemptsBefore).toBe(0)
    expect(dbAttemptsBefore).toBe(0)
    expect(deps.putRecords[0].upload_attempt_count).toBe(0)
    expect(deps.putRecords[0].db_attempt_count).toBe(0)
    expectNoRemoteMutation(deps)
  })

  test('local delete failure is returned and undeleted rows remain durable', async () => {
    const deps = createDeps({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      deleteLocalRecord: async () => {
        throw new Error('idb delete failed')
      },
    })
    await enqueueModeB(deps)
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED)
    expect(result.deleted).toEqual([])
    expect(deps.recordsById.has('qid-1')).toBe(true)
    expect(deps.recordsById.get('qid-1').status).toBe(PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED)
    expect(deps.recordsById.get('qid-1').blob).toBeTruthy()
    expectNoRemoteMutation(deps)
  })

  test('local delete failure after a prior success keeps remaining rows durable', async () => {
    let n = 0
    let deletes = 0
    const deps = createDeps({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      randomUUID: () => `qid-${(n += 1)}`,
      deleteLocalRecord: async ({ queueId, actorScopeType, actorScopeId }) => {
        deletes += 1
        deps.deleteCalls.push({ queueId, actorScopeType, actorScopeId })
        if (deletes > 1) {
          throw new Error('second delete failed')
        }
        deps.recordsById.delete(queueId)
      },
    })
    await enqueueModeB(deps, {
      files: [makeFile('a.jpg', 'image/jpeg'), makeFile('b.png', 'image/png')],
    })
    const result = await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(DRIVER_REPORT_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED)
    expect(result.deleted).toEqual(['qid-1'])
    expect(deps.recordsById.has('qid-1')).toBe(false)
    expect(deps.recordsById.has('qid-2')).toBe(true)
    expectNoRemoteMutation(deps)
  })

  test('portal token is not used or persisted during discard', async () => {
    const deps = createDeps({ sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE })
    await enqueueModeB(deps)
    await deps.controller.discardNeverUploadedDrafts({ provisionalId: PROVISIONAL_ID })
    assertNoSecret(deps.recordsById)
    assertNoSecret(deps.deleteCalls)
    assertNoSecret(deps.listCalls)
    assertNoSecret(deps.controller.getActorScopeId())
  })
})

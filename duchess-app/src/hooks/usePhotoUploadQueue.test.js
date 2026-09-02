import { createRoot } from 'react-dom/client'
import { act } from 'react'
import {
  DONE_OBSERVER_POLL_MS,
  OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
  OFFICE_EVIDENCE_ENTITY_TYPE,
  OFFICE_EVIDENCE_QUEUE_ERROR_CODES,
  OFFICE_EVIDENCE_SOURCE_SURFACE,
  buildOfficeEvidenceStoragePath,
  createPhotoUploadQueueController,
  usePhotoUploadQueue,
} from './usePhotoUploadQueue'
import { PHOTO_UPLOAD_STATUSES } from '../lib/photoUploadDomain'

const SENTINEL_TOKEN = 'p7-sentinel-token-SECRET-never-persist'
const USER_ID = 'office-user-uuid-1'
const SESSION_UUID = USER_ID
const DIFFERENT_PROFILE_UUID = 'profile-uuid-NOT-session'
const JOB_ID = 'job-77'
const FIXED_NOW = 1_900_000_000_000
const fetchCalls = []
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
  const unsubscribe = jest.fn()
  return {
    auth: {
      getSession: jest.fn(async () => ({
        data: {
          session: userId
            ? { access_token: accessToken, refresh_token: 'refresh-SECRET', user: { id: userId } }
            : null,
        },
      })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe } },
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
  const recordsById = new Map()
  const writeOps = []
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
  const db = {
    putRecord: overrides.putRecord || (async (record) => {
      events.push('put')
      writeOps.push('putRecord')
      putRecords.push(record)
      recordsById.set(record.queue_id, record)
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
  const controller = createPhotoUploadQueueController({
    supabaseClient,
    createDb: () => db,
    createTransport: () => ({ startUpload: jest.fn() }),
    createReconciler: () => ({
      inspectRemoteObject: jest.fn(),
      reconcileEvidencePhotoRow: jest.fn(),
    }),
    createStore: (input) => {
      capturedGetAccessToken = input.getAccessToken
      return storeApi
    },
    now: () => FIXED_NOW,
    randomUUID: overrides.randomUUID || (() => {
      overrides._n = (overrides._n || 0) + 1
      return `queue-${overrides._n}`
    }),
    createLeaseOwner: () => 'lease-owner-1',
    isOnline: () => true,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    onRemoteDone: overrides.onRemoteDone || ((payload) => { remoteDone.push(payload) }),
    ...overrides.controller,
  })
  liveControllers.push(controller)
  return {
    controller,
    db,
    storeApi,
    events,
    putRecords,
    recordsById,
    writeOps,
    startCalls,
    stopCalls,
    closeCalls,
    remoteDone,
    timers,
    supabaseClient,
    getCapturedGetAccessToken: () => capturedGetAccessToken,
  }
}

describe('usePhotoUploadQueue / office evidence queue controller', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    fetchCalls.length = 0
    global.fetch = (...args) => {
      fetchCalls.push(args)
      return Promise.reject(new Error('LIVE_NETWORK_FORBIDDEN'))
    }
  })

  afterEach(async () => {
    expect(fetchCalls).toEqual([])
    while (liveControllers.length) {
      const controller = liveControllers.pop()
      await controller.dispose()
    }
  })

  test('authenticated user UUID becomes office actor scope', async () => {
    const { controller, putRecords } = createDeps()
    const file = makeFile('a.jpg', 'image/jpeg')
    await controller.enqueueFiles({
      files: [file],
      jobId: JOB_ID,
      runType: 'after_del',
      profile: { name: 'Alex' },
    })
    expect(putRecords[0].actor_scope_type).toBe(OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE)
    expect(putRecords[0].actor_scope_id).toBe(USER_ID)
  })

  test('no session rejects before DB write', async () => {
    const { controller, putRecords, storeApi, supabaseClient } = createDeps({
      supabaseClient: createSessionClient({ userId: null, accessToken: null }),
    })
    const result = await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted).toEqual([])
    expect(result.rejected[0].code).toBe(OFFICE_EVIDENCE_QUEUE_ERROR_CODES.AUTH_REQUIRED)
    expect(putRecords).toHaveLength(0)
    expect(storeApi.start).not.toHaveBeenCalled()
    expect(supabaseClient.storage.from).not.toHaveBeenCalled()
  })

  test.each([
    ['image/jpeg', 'photo.jpg'],
    ['image/png', 'photo.png'],
    ['image/webp', 'photo.webp'],
  ])('%s is accepted', async (mime, name) => {
    const { controller, putRecords } = createDeps()
    const result = await controller.enqueueFiles({
      files: [makeFile(name, mime)],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted).toHaveLength(1)
    expect(putRecords[0].mime_type).toBe(mime)
    expect(putRecords[0].status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
  })

  test.each([
    ['image/heic'],
    ['image/heif'],
    ['application/pdf'],
    [''],
  ])('%s is rejected', async (mime) => {
    const { controller, putRecords } = createDeps()
    const result = await controller.enqueueFiles({
      files: [makeFile('nope', mime)],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.rejected[0].code).toBe(OFFICE_EVIDENCE_QUEUE_ERROR_CODES.UNSUPPORTED_MIME)
    expect(putRecords).toHaveLength(0)
  })

  test('stable storage path uses jobId, runType, queueId and MIME extension', async () => {
    const { controller, putRecords } = createDeps({
      randomUUID: () => 'qid-exact',
    })
    await controller.enqueueFiles({
      files: [makeFile('original.JPEG', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'pre_col',
    })
    expect(putRecords[0].storage_path).toBe('job-77/pre_col_qid-exact.jpg')
    expect(putRecords[0].file_name).toBe('original.JPEG')
    expect(putRecords[0].storage_path).not.toContain('original')
    expect(putRecords[0].storage_path).not.toContain(String(FIXED_NOW))
    expect(buildOfficeEvidenceStoragePath({
      jobId: JOB_ID,
      runType: 'pre_col',
      queueId: 'qid-exact',
      mimeType: 'image/jpeg',
    })).toBe('job-77/pre_col_qid-exact.jpg')
  })

  test('queue record starts QUEUED with zero attempts and diagnostic bytes', async () => {
    const file = makeFile('a.png', 'image/png', [9, 8, 7])
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [file],
      jobId: JOB_ID,
      runType: 'after_col',
    })
    const record = putRecords[0]
    expect(record.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(record.upload_attempt_count).toBe(0)
    expect(record.db_attempt_count).toBe(0)
    expect(record.bytes_uploaded).toBe(0)
    expect(record.bytes_total).toBe(file.size)
    expect(record.source_surface).toBe(OFFICE_EVIDENCE_SOURCE_SURFACE)
    expect(record.entity_type).toBe(OFFICE_EVIDENCE_ENTITY_TYPE)
    expect(record.entity_id).toBe(JOB_ID)
    expect(record.tus_upload_url).toBeNull()
  })

  test('metadata preserves legacy business fields and omits file_path/photo_url', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      jobTable: 'crms_jobs',
      crmsRef: 'CRMS-1',
      eventName: 'Wedding',
      runType: 'after_del',
      profile: { name: 'Alex' },
    })
    const payload = putRecords[0].metadata_payload
    expect(payload).toEqual({
      order_id: JOB_ID,
      job_table: 'crms_jobs',
      crms_ref: 'CRMS-1',
      event_name: 'Wedding',
      run_type: 'after_del',
      uploaded_by: null,
      uploaded_by_name: 'Alex',
      driver_name: 'Alex',
    })
    expect(payload).not.toHaveProperty('file_path')
    expect(payload).not.toHaveProperty('photo_url')
    expect(payload).not.toHaveProperty('id')
    expect(payload).not.toHaveProperty('created_at')
    expect(payload).not.toHaveProperty('job_id')
  })

  test('durable putRecord completes before accepted result and runtime wake', async () => {
    const { controller, events, putRecords } = createDeps()
    const result = await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(events).toEqual(['put', 'start'])
    expect(result.accepted[0].queueId).toBe(putRecords[0].queue_id)
  })

  test('runtime does not wake when putRecord fails', async () => {
    const { controller, storeApi } = createDeps({
      putRecord: async () => {
        throw new Error('idb down')
      },
    })
    const result = await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0].code).toBe(OFFICE_EVIDENCE_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED)
    expect(storeApi.start).not.toHaveBeenCalled()
  })

  test('multiple files get distinct queue IDs', async () => {
    let n = 0
    const { controller, putRecords } = createDeps({
      randomUUID: () => `qid-${(n += 1)}`,
    })
    const result = await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg'), makeFile('b.png', 'image/png')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted.map((row) => row.queueId)).toEqual(['qid-1', 'qid-2'])
    expect(putRecords.map((row) => row.queue_id)).toEqual(['qid-1', 'qid-2'])
  })

  test('partial batch failure preserves already accepted records', async () => {
    let calls = 0
    const kept = []
    const { controller, storeApi } = createDeps({
      putRecord: async (record) => {
        calls += 1
        if (calls === 3) {
          throw new Error('third fails')
        }
        kept.push(record.queue_id)
      },
    })
    const result = await controller.enqueueFiles({
      files: [
        makeFile('a.jpg', 'image/jpeg'),
        makeFile('b.jpg', 'image/jpeg'),
        makeFile('c.jpg', 'image/jpeg'),
      ],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(1)
    expect(kept).toEqual(result.accepted.map((row) => row.queueId))
    expect(storeApi.start).toHaveBeenCalled()
  })

  test('queue write failure does not fall back to legacy upload', async () => {
    const supabaseClient = createSessionClient()
    const transport = { startUpload: jest.fn() }
    const { controller } = createDeps({
      supabaseClient,
      putRecord: async () => {
        throw new Error('idb down')
      },
      controller: {
        createTransport: () => transport,
      },
    })
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(supabaseClient.storage.from).not.toHaveBeenCalled()
    expect(supabaseClient.from).not.toHaveBeenCalled()
    expect(transport.startUpload).not.toHaveBeenCalled()
  })

  test('access token is absent from persisted record', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
      profile: { name: 'Alex' },
    })
    const persisted = { ...putRecords[0], blob: null }
    expect(JSON.stringify(persisted)).not.toContain(SENTINEL_TOKEN)
    assertNoToken(persisted)
    expect(persisted.metadata_payload).not.toHaveProperty('access_token')
  })

  test('getAccessToken reads the current session just in time', async () => {
    const { controller, supabaseClient, getCapturedGetAccessToken } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    const token = await getCapturedGetAccessToken()()
    expect(token).toBe(SENTINEL_TOKEN)
    expect(supabaseClient.auth.getSession).toHaveBeenCalled()
  })

  test('boot starts recovery runtime for the office actor', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot()
    expect(storeApi.start).toHaveBeenCalled()
  })

  test('dispose stops runtime then closes DB', async () => {
    const { controller, events } = createDeps()
    await controller.boot()
    await controller.dispose()
    expect(events).toEqual(['start', 'stop', 'close'])
  })

  test('profile null preserves legacy uploaded_by while actor remains session UUID', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
      profile: null,
    })
    expect(putRecords[0].actor_scope_id).toBe(SESSION_UUID)
    expect(putRecords[0].metadata_payload.uploaded_by).toBeNull()
    expect(putRecords[0].metadata_payload.uploaded_by_name).toBe('Team')
    expect(putRecords[0].metadata_payload.driver_name).toBeNull()
    assertNoToken(putRecords[0])
    expect(JSON.stringify(putRecords[0].metadata_payload)).not.toContain('Authorization')
    expect(JSON.stringify(putRecords[0])).not.toContain('refresh_token')
  })

  test('profile id different from session id is preserved exactly in uploaded_by', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
      profile: { id: DIFFERENT_PROFILE_UUID, name: 'Alice' },
    })
    expect(putRecords[0].actor_scope_id).toBe(SESSION_UUID)
    expect(putRecords[0].metadata_payload.uploaded_by).toBe(DIFFERENT_PROFILE_UUID)
    expect(putRecords[0].metadata_payload.uploaded_by).not.toBe(SESSION_UUID)
    expect(putRecords[0].metadata_payload.uploaded_by_name).toBe('Alice')
    expect(putRecords[0].metadata_payload.driver_name).toBe('Alice')
    assertNoToken(putRecords[0])
    expect(JSON.stringify(putRecords[0])).not.toContain(SENTINEL_TOKEN)
    expect(JSON.stringify(putRecords[0])).not.toContain('Authorization')
  })

  test('newly accepted queue id is registered for DONE observation', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(controller.getPendingObservationQueueIds()).toEqual([putRecords[0].queue_id])
  })

  test('newly accepted record that is DONE on first observer read still notifies', async () => {
    const { controller, recordsById, remoteDone, db } = createDeps()
    db.getRecord = async ({ queueId, actorScopeType, actorScopeId }) => {
      const record = recordsById.get(queueId)
      if (!record) return null
      if (record.actor_scope_type !== actorScopeType || record.actor_scope_id !== actorScopeId) {
        return null
      }
      return { ...record, status: PHOTO_UPLOAD_STATUSES.DONE }
    }
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(remoteDone).toEqual([{
      queue_id: 'queue-1',
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }])
    expect(controller.getPendingObservationQueueIds()).toEqual([])
  })

  test('pre-existing non-DONE office evidence record is observed', async () => {
    const preexisting = {
      queue_id: 'pre-queued',
      actor_scope_type: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: USER_ID,
      source_surface: OFFICE_EVIDENCE_SOURCE_SURFACE,
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.QUEUED,
    }
    const { controller, remoteDone, writeOps } = createDeps({
      listRecordsForActor: async () => [preexisting],
      getRecord: async ({ queueId }) => (queueId === preexisting.queue_id ? preexisting : null),
    })
    await controller.boot()
    expect(controller.getPendingObservationQueueIds()).toEqual(['pre-queued'])
    expect(remoteDone).toHaveLength(0)
    preexisting.status = PHOTO_UPLOAD_STATUSES.DONE
    await controller.inspectPending()
    expect(remoteDone).toEqual([{
      queue_id: 'pre-queued',
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }])
    expect(writeOps).toEqual([])
  })

  test('pre-existing already-DONE record does not synthesize a callback', async () => {
    const preexisting = {
      queue_id: 'pre-done',
      actor_scope_type: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: USER_ID,
      source_surface: OFFICE_EVIDENCE_SOURCE_SURFACE,
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }
    const { controller, remoteDone } = createDeps({
      listRecordsForActor: async () => [preexisting],
      getRecord: async () => preexisting,
    })
    await controller.boot()
    expect(remoteDone).toHaveLength(0)
    expect(controller.getPendingObservationQueueIds()).toEqual([])
  })

  test.each([
    ['QUEUED', PHOTO_UPLOAD_STATUSES.QUEUED],
    ['UPLOADING', PHOTO_UPLOAD_STATUSES.UPLOADING],
    ['STORAGE_COMPLETE', PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE],
    ['DB_PENDING', PHOTO_UPLOAD_STATUSES.DB_PENDING],
    ['DB_RETRY_WAIT', PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT],
  ])('%s does not notify remote DONE', async (_label, status) => {
    const { controller, recordsById, remoteDone, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    recordsById.get(putRecords[0].queue_id).status = status
    await controller.inspectPending()
    expect(remoteDone).toHaveLength(0)
    expect(controller.getPendingObservationQueueIds()).toEqual([putRecords[0].queue_id])
  })

  test('DONE notifies exactly once', async () => {
    const { controller, recordsById, remoteDone, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    recordsById.get(putRecords[0].queue_id).status = PHOTO_UPLOAD_STATUSES.DONE
    await controller.inspectPending()
    await controller.inspectPending()
    expect(remoteDone).toHaveLength(1)
    expect(remoteDone[0]).toEqual({
      queue_id: putRecords[0].queue_id,
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    })
    expect(Object.keys(remoteDone[0]).sort()).toEqual(['entity_id', 'queue_id', 'status'])
  })

  test('unrelated actor record does not notify', async () => {
    const foreign = {
      queue_id: 'foreign-1',
      actor_scope_type: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: 'other-user',
      source_surface: OFFICE_EVIDENCE_SOURCE_SURFACE,
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }
    const { controller, remoteDone } = createDeps({
      listRecordsForActor: async () => [foreign],
      getRecord: async () => foreign,
    })
    await controller.boot()
    await controller.inspectPending()
    expect(remoteDone).toHaveLength(0)
    expect(controller.getPendingObservationQueueIds()).toEqual([])
  })

  test('non-office_evidence source does not notify', async () => {
    const otherSurface = {
      queue_id: 'driver-1',
      actor_scope_type: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: USER_ID,
      source_surface: 'driver_evidence',
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }
    const { controller, remoteDone } = createDeps({
      listRecordsForActor: async () => [otherSurface],
      getRecord: async () => otherSurface,
    })
    await controller.boot()
    await controller.inspectPending()
    expect(remoteDone).toHaveLength(0)
    expect(controller.getPendingObservationQueueIds()).toEqual([])
  })

  test('observer performs zero queue writes', async () => {
    const { controller, writeOps, recordsById, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(writeOps).toEqual(['putRecord'])
    recordsById.get(putRecords[0].queue_id).status = PHOTO_UPLOAD_STATUSES.DONE
    await controller.inspectPending()
    expect(writeOps).toEqual(['putRecord'])
  })

  test('observer timer stops when no pending records remain', async () => {
    const { controller, recordsById, putRecords, timers } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(controller.getObserverTimerPending()).toBe(true)
    expect(timers.scheduled).toHaveLength(1)
    expect(timers.scheduled[0].ms).toBe(DONE_OBSERVER_POLL_MS)
    recordsById.get(putRecords[0].queue_id).status = PHOTO_UPLOAD_STATUSES.DONE
    await timers.flush()
    expect(controller.getPendingObservationQueueIds()).toEqual([])
    expect(controller.getObserverTimerPending()).toBe(false)
    expect(timers.scheduled).toHaveLength(0)
  })

  test('unmount clears observer timer and does not callback after dispose', async () => {
    const { controller, recordsById, putRecords, remoteDone, timers } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(timers.scheduled).toHaveLength(1)
    await controller.dispose()
    expect(timers.scheduled).toHaveLength(0)
    expect(controller.getObserverTimerPending()).toBe(false)
    recordsById.get(putRecords[0].queue_id).status = PHOTO_UPLOAD_STATUSES.DONE
    await controller.inspectPending()
    await timers.flush()
    expect(remoteDone).toHaveLength(0)
  })
})

describe('usePhotoUploadQueue hook lifecycle', () => {
  let container
  let root

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  test('mount starts runtime and unmount stops then closes DB', async () => {
    const events = []
    const storeApi = {
      start: jest.fn(() => { events.push('start') }),
      stop: jest.fn(async () => { events.push('stop') }),
    }
    const db = {
      putRecord: jest.fn(),
      getRecord: jest.fn(async () => null),
      listRecordsForActor: jest.fn(async () => []),
      close: jest.fn(async () => { events.push('close') }),
    }
    function Probe() {
      usePhotoUploadQueue({
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient: createSessionClient(),
        createDb: () => db,
        createTransport: () => ({ startUpload: jest.fn() }),
        createReconciler: () => ({
          inspectRemoteObject: jest.fn(),
          reconcileEvidencePhotoRow: jest.fn(),
        }),
        createStore: () => storeApi,
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-hook',
        createLeaseOwner: () => 'lease-hook',
      })
      return null
    }
    await act(async () => {
      root.render(<Probe />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(storeApi.start).toHaveBeenCalled()
    await act(async () => {
      root.unmount()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(events.indexOf('start')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('stop')).toBeGreaterThan(events.indexOf('start'))
    expect(events.indexOf('close')).toBeGreaterThan(events.indexOf('stop'))
  })

  test('hook unmount clears observer timer and stops DONE callbacks', async () => {
    const timers = createFakeTimers()
    const callbacks = []
    const pending = {
      queue_id: 'hook-pending',
      actor_scope_type: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: USER_ID,
      source_surface: OFFICE_EVIDENCE_SOURCE_SURFACE,
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.QUEUED,
    }
    const db = {
      putRecord: jest.fn(),
      getRecord: jest.fn(async () => pending),
      listRecordsForActor: jest.fn(async () => [pending]),
      close: jest.fn(async () => {}),
    }
    function Probe() {
      usePhotoUploadQueue({
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient: createSessionClient(),
        createDb: () => db,
        createTransport: () => ({ startUpload: jest.fn() }),
        createReconciler: () => ({
          inspectRemoteObject: jest.fn(),
          reconcileEvidencePhotoRow: jest.fn(),
        }),
        createStore: () => ({
          start: jest.fn(),
          stop: jest.fn(async () => {}),
        }),
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-hook',
        createLeaseOwner: () => 'lease-hook',
        setTimeoutImpl: timers.setTimeoutImpl,
        clearTimeoutImpl: timers.clearTimeoutImpl,
        onRemoteDone: (payload) => { callbacks.push(payload) },
      })
      return null
    }
    await act(async () => {
      root.render(<Probe />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(timers.scheduled).toHaveLength(1)
    await act(async () => {
      root.unmount()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(timers.scheduled).toHaveLength(0)
    pending.status = PHOTO_UPLOAD_STATUSES.DONE
    await timers.flush()
    expect(callbacks).toHaveLength(0)
  })
})

describe('usePhotoUploadQueue P11A environmental wake', () => {
  afterEach(async () => {
    while (liveControllers.length) {
      const controller = liveControllers.pop()
      await controller.dispose()
    }
  })

  test('authoritative actor boot and enqueue remain unchanged while resume is additive', async () => {
    const { controller, putRecords, storeApi } = createDeps()
    await controller.boot()
    expect(controller.getActorScopeId()).toBe(USER_ID)
    expect(controller.getActorScopeId()).not.toBe(DIFFERENT_PROFILE_UUID)
    expect(storeApi.start).toHaveBeenCalled()
    expect(storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
    const result = await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      jobId: JOB_ID,
      runType: 'after_del',
      profile: { id: DIFFERENT_PROFILE_UUID, name: 'Alex' },
    })
    expect(result.accepted).toHaveLength(1)
    expect(putRecords[0].actor_scope_id).toBe(USER_ID)
    expect(putRecords[0].actor_scope_id).not.toBe(DIFFERENT_PROFILE_UUID)
  })

  test('online listener is registered and removed on cleanup', async () => {
    const addSpy = jest.spyOn(window, 'addEventListener')
    const removeSpy = jest.spyOn(window, 'removeEventListener')
    const { controller } = createDeps()
    await controller.boot()
    expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function))
    await controller.dispose()
    expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function))
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  test('online event calls guarded resume', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot()
    storeApi.resumePausedUploads.mockClear()
    window.dispatchEvent(new Event('online'))
    await flushWake()
    expect(storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
  })

  test('offline boot does not resume', async () => {
    const { controller, storeApi } = createDeps({
      controller: { isOnline: () => false },
    })
    await controller.boot()
    expect(storeApi.start).toHaveBeenCalled()
    expect(storeApi.resumePausedUploads).not.toHaveBeenCalled()
  })

  test('online boot resumes when credentials are ready', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot()
    expect(storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
  })

  test('credential readiness failure leaves paused state and does not reject', async () => {
    const { controller, storeApi } = createDeps({
      supabaseClient: createSessionClient({ userId: USER_ID, accessToken: null }),
    })
    await expect(controller.boot()).resolves.toBeUndefined()
    expect(storeApi.resumePausedUploads).not.toHaveBeenCalled()
  })

  test('resume rejection does not become an unhandled rejection', async () => {
    const { controller, storeApi } = createDeps()
    storeApi.resumePausedUploads.mockImplementation(async () => {
      throw new Error('resume failed')
    })
    await expect(controller.boot()).resolves.toBeUndefined()
  })

  test('auth-change wake is subscribed and cleaned up', async () => {
    const { controller, storeApi, supabaseClient } = createDeps()
    await controller.boot()
    expect(supabaseClient.auth.onAuthStateChange).toHaveBeenCalled()
    storeApi.resumePausedUploads.mockClear()
    const onChange = supabaseClient.auth.onAuthStateChange.mock.calls[0][0]
    onChange('SIGNED_IN')
    await flushWake()
    expect(storeApi.resumePausedUploads).toHaveBeenCalledTimes(1)
    await controller.dispose()
    expect(supabaseClient._authUnsubscribe).toHaveBeenCalled()
  })

  test('SESSION_USER_ID_CHANGED does not resume the old actor queue', async () => {
    const { controller, storeApi, supabaseClient } = createDeps()
    await controller.boot()
    storeApi.resumePausedUploads.mockClear()
    supabaseClient.auth.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: SENTINEL_TOKEN,
          user: { id: 'other-office-user' },
        },
      },
    })
    window.dispatchEvent(new Event('online'))
    await flushWake()
    expect(storeApi.resumePausedUploads).not.toHaveBeenCalled()
    expect(controller.getActorScopeId()).toBe(USER_ID)
  })

  test('no token is persisted by boot resume', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot()
    assertNoToken(storeApi)
    assertNoToken(controller.getActorScopeId())
  })
})

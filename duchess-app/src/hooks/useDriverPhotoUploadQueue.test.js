import { createRoot } from 'react-dom/client'
import { act } from 'react'
import {
  DRIVER_DONE_OBSERVER_POLL_MS,
  DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
  DRIVER_EVIDENCE_ENTITY_TYPE,
  DRIVER_EVIDENCE_QUEUE_ERROR_CODES,
  DRIVER_EVIDENCE_SOURCE_SURFACE,
  buildDriverEvidenceStoragePath,
  createDriverPhotoUploadQueueController,
  resolveDriverSupabaseBearer,
  useDriverPhotoUploadQueue,
} from './useDriverPhotoUploadQueue'
import { PHOTO_UPLOAD_STATUSES } from '../lib/photoUploadDomain'
import {
  acquirePhotoUploadRuntime,
  releasePhotoUploadRuntime,
  resetPhotoUploadRuntimeRegistryForTests,
} from '../lib/photoUploadRuntime'
import {
  DRIVER_REPORT_SOURCE_SURFACES,
  useDriverReportPhotoUploadQueue,
} from './useDriverReportPhotoUploadQueue'

const BEARER_SENTINEL = 'DRIVER_SUPABASE_BEARER_SENTINEL'
const PORTAL_TOKEN_SENTINEL = 'p8-portal-token-SECRET-never-persist'
const ANON_SENTINEL = 'DRIVER_ANON_BEARER_SENTINEL'
const DRIVER_ID = 'driver-id-aaa'
const OTHER_DRIVER_ID = 'driver-id-bbb'
const JOB_ID = 'job-88'
const OTHER_JOB_ID = 'job-99'
const FIXED_NOW = 1_910_000_000_000
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

function assertNoSecret(value, secret) {
  const strings = []
  collectStrings(value, strings, new Set())
  expect(strings.join('\n')).not.toContain(secret)
}

function createSessionClient({
  accessToken = BEARER_SENTINEL,
  supabaseKey = ANON_SENTINEL,
  session = true,
} = {}) {
  const unsubscribe = jest.fn()
  return {
    supabaseKey,
    auth: {
      getSession: jest.fn(async () => ({
        data: {
          session: session
            ? { access_token: accessToken, user: { id: 'auth-user-not-driver' } }
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
  const remoteDone = []
  const recordsById = new Map()
  const writeOps = []
  const startCalls = []
  const timers = overrides.timers || createFakeTimers()
  const storeApi = {
    start: jest.fn(() => {
      events.push('start')
      startCalls.push(true)
    }),
    stop: jest.fn(async () => {
      events.push('stop')
    }),
    resumePausedUploads: jest.fn(async () => ({ resumed: 0 })),
    manualUploadRetry: jest.fn(async () => ({ ok: true, status: PHOTO_UPLOAD_STATUSES.QUEUED })),
    manualDbRetry: jest.fn(async () => ({ ok: true, status: PHOTO_UPLOAD_STATUSES.DB_PENDING })),
  }
  let capturedGetAccessToken = null
  let capturedStoreActor = null
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
    }),
  }
  const supabaseClient = overrides.supabaseClient || createSessionClient()
  const controller = createDriverPhotoUploadQueueController({
    supabaseClient,
    createDb: () => db,
    createTransport: () => ({ startUpload: jest.fn() }),
    createReconciler: () => ({
      inspectRemoteObject: jest.fn(),
      reconcileEvidencePhotoRow: jest.fn(),
    }),
    createStore: (input) => {
      capturedGetAccessToken = input.getAccessToken
      capturedStoreActor = {
        actorScopeType: input.actorScopeType,
        actorScopeId: input.actorScopeId,
      }
      return storeApi
    },
    now: () => FIXED_NOW,
    randomUUID: overrides.randomUUID || (() => {
      overrides._n = (overrides._n || 0) + 1
      return `dqueue-${overrides._n}`
    }),
    createLeaseOwner: () => 'driver-lease-1',
    isOnline: () => true,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    onRemoteDone: overrides.onRemoteDone || ((payload) => { remoteDone.push(payload) }),
    ...overrides.controller,
    getRuntime: () => ({
      wake: async () => {
        events.push('wake')
      },
      getStore: () => storeApi,
    }),
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
    remoteDone,
    timers,
    supabaseClient,
    getCapturedGetAccessToken: () => capturedGetAccessToken,
    getCapturedStoreActor: () => capturedStoreActor,
  }
}

describe('useDriverPhotoUploadQueue / driver evidence queue controller', () => {
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

  test('actor_scope_type is driver_portal and actor_scope_id is driver.id', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
      driverName: 'Pat',
    })
    expect(putRecords[0].actor_scope_type).toBe(DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE)
    expect(putRecords[0].actor_scope_id).toBe(DRIVER_ID)
    expect(putRecords[0].entity_id).toBe(JOB_ID)
    expect(putRecords[0].entity_id).not.toBe(DRIVER_ID)
  })

  test('missing driver.id rejects before DB write', async () => {
    const { controller, putRecords, storeApi } = createDeps()
    const result = await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: null,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted).toEqual([])
    expect(result.rejected[0].code).toBe(DRIVER_EVIDENCE_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED)
    expect(putRecords).toHaveLength(0)
    expect(storeApi.start).not.toHaveBeenCalled()
  })

  test('different drivers produce isolated actor scopes', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    await controller.enqueueFiles({
      files: [makeFile('b.jpg', 'image/jpeg')],
      driverId: OTHER_DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(putRecords[0].actor_scope_id).toBe(DRIVER_ID)
    expect(putRecords[1].actor_scope_id).toBe(OTHER_DRIVER_ID)
    expect(putRecords[0].entity_id).toBe(JOB_ID)
    expect(putRecords[1].entity_id).toBe(JOB_ID)
  })

  test('legacy metadata is preserved and omits file_path/photo_url/uploaded_by', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      jobTable: 'crms_jobs',
      crmsRef: 'CRMS-9',
      eventName: 'Gala',
      runType: 'pre_col',
      driverName: 'Pat',
    })
    const payload = putRecords[0].metadata_payload
    expect(payload).toEqual({
      order_id: JOB_ID,
      job_table: 'crms_jobs',
      crms_ref: 'CRMS-9',
      event_name: 'Gala',
      run_type: 'pre_col',
      uploaded_by_name: 'Pat',
      driver_name: 'Pat',
    })
    expect(payload).not.toHaveProperty('uploaded_by')
    expect(payload).not.toHaveProperty('user_id')
    expect(payload).not.toHaveProperty('file_path')
    expect(payload).not.toHaveProperty('photo_url')
    expect(payload).not.toHaveProperty('job_id')
    expect(putRecords[0].source_surface).toBe(DRIVER_EVIDENCE_SOURCE_SURFACE)
    expect(putRecords[0].entity_type).toBe(DRIVER_EVIDENCE_ENTITY_TYPE)
  })

  test.each([
    ['image/jpeg', 'photo.jpg'],
    ['image/png', 'photo.png'],
    ['image/webp', 'photo.webp'],
  ])('%s is accepted', async (mime, name) => {
    const { controller, putRecords } = createDeps()
    const result = await controller.enqueueFiles({
      files: [makeFile(name, mime)],
      driverId: DRIVER_ID,
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
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.rejected[0].code).toBe(DRIVER_EVIDENCE_QUEUE_ERROR_CODES.UNSUPPORTED_MIME)
    expect(putRecords).toHaveLength(0)
  })

  test('stable storage path uses job id, run type, queue id and MIME extension', async () => {
    const { controller, putRecords } = createDeps({
      randomUUID: () => 'dqid-exact',
    })
    await controller.enqueueFiles({
      files: [makeFile('original.JPEG', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_col',
    })
    expect(putRecords[0].storage_path).toBe('job-88/after_col_dqid-exact.jpg')
    expect(putRecords[0].file_name).toBe('original.JPEG')
    expect(putRecords[0].storage_path).not.toContain('original')
    expect(putRecords[0].storage_path).not.toContain(DRIVER_ID)
    expect(putRecords[0].storage_path).not.toContain(String(FIXED_NOW))
    expect(putRecords[0].storage_path).not.toContain(PORTAL_TOKEN_SENTINEL)
    expect(buildDriverEvidenceStoragePath({
      jobId: JOB_ID,
      runType: 'after_col',
      queueId: 'dqid-exact',
      mimeType: 'image/jpeg',
    })).toBe('job-88/after_col_dqid-exact.jpg')
  })

  test('queue record starts QUEUED with zero attempts and diagnostic bytes', async () => {
    const file = makeFile('a.png', 'image/png', [9, 8, 7])
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [file],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    const record = putRecords[0]
    expect(record.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(record.upload_attempt_count).toBe(0)
    expect(record.db_attempt_count).toBe(0)
    expect(record.bytes_uploaded).toBe(0)
    expect(record.bytes_total).toBe(file.size)
    expect(record.queue_id).toBe('dqueue-1')
  })

  test('durable putRecord completes before accepted result and runtime wake', async () => {
    const { controller, events, putRecords } = createDeps()
    const result = await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(events).toEqual(['put', 'wake'])
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
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0].code).toBe(DRIVER_EVIDENCE_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED)
    expect(storeApi.start).not.toHaveBeenCalled()
  })

  test('partial batch failure preserves already accepted records', async () => {
    let calls = 0
    const kept = []
    const { controller, storeApi, events } = createDeps({
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
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(1)
    expect(kept).toEqual(result.accepted.map((row) => row.queueId))
    expect(storeApi.start).not.toHaveBeenCalled()
    expect(events).toContain('wake')
  })

  test('queue write failure does not fall back to legacy upload or report flows', async () => {
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
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(supabaseClient.storage.from).not.toHaveBeenCalled()
    expect(supabaseClient.from).not.toHaveBeenCalled()
    expect(transport.startUpload).not.toHaveBeenCalled()
  })

  test('actor scope is set only after driver identity is proven', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot({ driverId: null })
    expect(storeApi.start).not.toHaveBeenCalled()
    expect(controller.getActorScopeId()).toBeNull()
    await controller.boot({ driverId: DRIVER_ID })
    expect(storeApi.start).not.toHaveBeenCalled()
    expect(controller.getActorScopeId()).toBe(DRIVER_ID)
  })

  test('runtime recovers existing current-driver queue on boot', async () => {
    const preexisting = {
      queue_id: 'pre-driver',
      actor_scope_type: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: DRIVER_ID,
      source_surface: DRIVER_EVIDENCE_SOURCE_SURFACE,
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.QUEUED,
    }
    const { controller, storeApi } = createDeps({
      listRecordsForActor: async () => [preexisting],
      getRecord: async ({ queueId }) => (queueId === preexisting.queue_id ? preexisting : null),
    })
    await controller.boot({ driverId: DRIVER_ID })
    expect(storeApi.start).not.toHaveBeenCalled()
    expect(controller.getPendingObservationQueueIds()).toEqual(['pre-driver'])
  })

  test('dispose closes the surface DB and does not stop shared transport', async () => {
    const { controller, events, storeApi } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    await controller.dispose()
    expect(events).toEqual(['close'])
    expect(storeApi.stop).not.toHaveBeenCalled()
  })

  test('getAccessToken uses session bearer just in time and does not persist it', async () => {
    const { controller, putRecords, supabaseClient } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
      driverName: 'Pat',
    })
    const token = await controller.getAccessToken()
    expect(token).toBe(BEARER_SENTINEL)
    expect(supabaseClient.auth.getSession).toHaveBeenCalled()
    assertNoSecret(putRecords[0], BEARER_SENTINEL)
    assertNoSecret(putRecords[0], PORTAL_TOKEN_SENTINEL)
    assertNoSecret(putRecords[0], ANON_SENTINEL)
    expect(JSON.stringify({ ...putRecords[0], blob: null })).not.toContain('Authorization')
  })

  test('anon supabaseKey is used when no session exists', async () => {
    const supabaseClient = createSessionClient({ session: false, supabaseKey: ANON_SENTINEL })
    const token = await resolveDriverSupabaseBearer(supabaseClient)
    expect(token).toBe(ANON_SENTINEL)
  })

  test('portal token is never used as TUS bearer', async () => {
    const supabaseClient = createSessionClient({ session: false, supabaseKey: ANON_SENTINEL })
    const token = await resolveDriverSupabaseBearer(supabaseClient)
    expect(token).not.toBe(PORTAL_TOKEN_SENTINEL)
    expect(token).toBe(ANON_SENTINEL)
  })

  test('newly accepted queue is registered for DONE observation', async () => {
    const { controller, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(controller.getPendingObservationQueueIds()).toEqual([putRecords[0].queue_id])
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
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    recordsById.get(putRecords[0].queue_id).status = status
    await controller.inspectPending()
    expect(remoteDone).toHaveLength(0)
  })

  test('DONE notifies exactly once with job entity_id not driver.id', async () => {
    const { controller, recordsById, remoteDone, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
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
    expect(remoteDone[0].entity_id).not.toBe(DRIVER_ID)
    expect(remoteDone[0].entity_id).not.toBe(OTHER_JOB_ID)
  })

  test('unrelated driver does not notify', async () => {
    const foreign = {
      queue_id: 'foreign-d',
      actor_scope_type: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: OTHER_DRIVER_ID,
      source_surface: DRIVER_EVIDENCE_SOURCE_SURFACE,
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }
    const { controller, remoteDone } = createDeps({
      listRecordsForActor: async () => [foreign],
      getRecord: async () => foreign,
    })
    await controller.boot({ driverId: DRIVER_ID })
    await controller.inspectPending()
    expect(remoteDone).toHaveLength(0)
  })

  test('unrelated source_surface does not notify', async () => {
    const otherSurface = {
      queue_id: 'office-1',
      actor_scope_type: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: DRIVER_ID,
      source_surface: 'office_evidence',
      entity_id: JOB_ID,
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }
    const { controller, remoteDone } = createDeps({
      listRecordsForActor: async () => [otherSurface],
      getRecord: async () => otherSurface,
    })
    await controller.boot({ driverId: DRIVER_ID })
    await controller.inspectPending()
    expect(remoteDone).toHaveLength(0)
  })

  test('observer performs zero queue writes', async () => {
    const { controller, writeOps, recordsById, putRecords } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(writeOps).toEqual(['putRecord'])
    recordsById.get(putRecords[0].queue_id).status = PHOTO_UPLOAD_STATUSES.DONE
    await controller.inspectPending()
    expect(writeOps).toEqual(['putRecord'])
  })

  test('observer timer stops when no pending remain and dispose clears it', async () => {
    const { controller, recordsById, putRecords, timers, remoteDone } = createDeps()
    await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(timers.scheduled[0].ms).toBe(DRIVER_DONE_OBSERVER_POLL_MS)
    recordsById.get(putRecords[0].queue_id).status = PHOTO_UPLOAD_STATUSES.DONE
    await timers.flush()
    expect(controller.getPendingObservationQueueIds()).toEqual([])
    expect(controller.getObserverTimerPending()).toBe(false)
    await controller.dispose()
    expect(timers.scheduled).toHaveLength(0)
    await controller.inspectPending()
    expect(remoteDone).toHaveLength(1)
  })
})

describe('useDriverPhotoUploadQueue hook lifecycle', () => {
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

  test('mount with driver id starts runtime; driver change stops old runtime; unmount closes DB', async () => {
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
    function Probe({ driverId }) {
      useDriverPhotoUploadQueue({
        driverId,
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
      root.render(<Probe driverId={null} />)
    })
    await act(async () => { await Promise.resolve() })
    expect(storeApi.start).not.toHaveBeenCalled()
    await act(async () => {
      root.render(<Probe driverId={DRIVER_ID} />)
    })
    await act(async () => { await Promise.resolve() })
    expect(storeApi.start).not.toHaveBeenCalled()
    await act(async () => {
      root.render(<Probe driverId={OTHER_DRIVER_ID} />)
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      root.unmount()
    })
    await act(async () => { await Promise.resolve() })
    expect(storeApi.stop).not.toHaveBeenCalled()
    expect(events.filter((event) => event === 'close').length).toBeGreaterThanOrEqual(1)
    expect(events).not.toContain('start')
    expect(events).not.toContain('stop')
  })
})

describe('useDriverPhotoUploadQueue surface does not own transport', () => {
  afterEach(async () => {
    while (liveControllers.length) {
      const controller = liveControllers.pop()
      await controller.dispose()
    }
  })

  test('authoritative driver actor boot and enqueue remain unchanged without a private runtime', async () => {
    const { controller, putRecords, storeApi, events } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    expect(controller.getActorScopeId()).toBe(DRIVER_ID)
    expect(storeApi.start).not.toHaveBeenCalled()
    expect(storeApi.resumePausedUploads).not.toHaveBeenCalled()
    const result = await controller.enqueueFiles({
      files: [makeFile('a.jpg', 'image/jpeg')],
      driverId: DRIVER_ID,
      jobId: JOB_ID,
      runType: 'after_del',
    })
    expect(result.accepted).toHaveLength(1)
    expect(events).toContain('wake')
    expect(putRecords[0].actor_scope_id).toBe(DRIVER_ID)
  })

  test('surface boot does not register an online listener', async () => {
    const addSpy = jest.spyOn(window, 'addEventListener')
    const { controller } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    expect(addSpy).not.toHaveBeenCalledWith('online', expect.any(Function))
    await controller.dispose()
    addSpy.mockRestore()
  })

  test('surface does not resume when the window goes online', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    window.dispatchEvent(new Event('online'))
    await flushWake()
    expect(storeApi.resumePausedUploads).not.toHaveBeenCalled()
    expect(storeApi.start).not.toHaveBeenCalled()
  })

  test('offline boot does not start a private runtime', async () => {
    const { controller, storeApi } = createDeps({
      controller: { isOnline: () => false },
    })
    await controller.boot({ driverId: DRIVER_ID })
    expect(storeApi.start).not.toHaveBeenCalled()
    expect(storeApi.resumePausedUploads).not.toHaveBeenCalled()
  })

  test('credential readiness failure does not reject boot', async () => {
    const { controller, storeApi } = createDeps({
      supabaseClient: createSessionClient({ session: false, supabaseKey: '' }),
    })
    await expect(controller.boot({ driverId: DRIVER_ID })).resolves.toBeUndefined()
    expect(storeApi.resumePausedUploads).not.toHaveBeenCalled()
    expect(storeApi.start).not.toHaveBeenCalled()
  })

  test('surface boot does not subscribe to auth changes', async () => {
    const { controller, supabaseClient } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    expect(supabaseClient.auth.onAuthStateChange).not.toHaveBeenCalled()
    await controller.dispose()
    expect(supabaseClient._authUnsubscribe).not.toHaveBeenCalled()
  })

  test('driver identity change updates the surface actor and does not stop shared transport', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    expect(controller.getActorScopeId()).toBe(DRIVER_ID)
    await controller.boot({ driverId: OTHER_DRIVER_ID })
    expect(controller.getActorScopeId()).toBe(OTHER_DRIVER_ID)
    expect(storeApi.stop).not.toHaveBeenCalled()
    expect(storeApi.start).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('online'))
    await flushWake()
    expect(storeApi.resumePausedUploads).not.toHaveBeenCalled()
    expect(controller.getActorScopeId()).not.toBe(DRIVER_ID)
  })

  test('portal token is not used as TUS bearer and no token is persisted', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    const token = await controller.getAccessToken()
    expect(token).toBe(BEARER_SENTINEL)
    expect(token).not.toBe(PORTAL_TOKEN_SENTINEL)
    assertNoSecret(storeApi, BEARER_SENTINEL)
    assertNoSecret(storeApi, PORTAL_TOKEN_SENTINEL)
    assertNoSecret(controller.getActorScopeId(), BEARER_SENTINEL)
  })
})

describe('useDriverPhotoUploadQueue P11B manual retry', () => {
  afterEach(async () => {
    while (liveControllers.length) {
      const controller = liveControllers.pop()
      await controller.dispose()
    }
  })

  test('controller exposes manualUploadRetry and manualDbRetry', async () => {
    const { controller } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    expect(typeof controller.manualUploadRetry).toBe('function')
    expect(typeof controller.manualDbRetry).toBe('function')
  })

  test('manualUploadRetry delegates queueId to store scoped to driver.id', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    const result = await controller.manualUploadRetry({ queueId: 'dq-1' })
    expect(storeApi.manualUploadRetry).toHaveBeenCalledWith({ queueId: 'dq-1' })
    expect(result).toEqual({ ok: true, status: PHOTO_UPLOAD_STATUSES.QUEUED })
  })

  test('manualDbRetry delegates queueId to store scoped to driver.id', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    const result = await controller.manualDbRetry({ queueId: 'dq-1' })
    expect(storeApi.manualDbRetry).toHaveBeenCalledWith({ queueId: 'dq-1' })
    expect(result).toEqual({ ok: true, status: PHOTO_UPLOAD_STATUSES.DB_PENDING })
  })

  test('missing driver.id returns DRIVER_ID_REQUIRED before store call', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot({ driverId: null })
    const upload = await controller.manualUploadRetry({ queueId: 'dq-1' })
    const db = await controller.manualDbRetry({ queueId: 'dq-1' })
    expect(upload.code).toBe(DRIVER_EVIDENCE_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED)
    expect(db.code).toBe(DRIVER_EVIDENCE_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED)
    expect(storeApi.manualUploadRetry).not.toHaveBeenCalled()
    expect(storeApi.manualDbRetry).not.toHaveBeenCalled()
  })

  test('missing queueId returns error before store call', async () => {
    const { controller, storeApi } = createDeps()
    await controller.boot({ driverId: DRIVER_ID })
    const upload = await controller.manualUploadRetry({ queueId: null })
    const db = await controller.manualDbRetry({ queueId: '' })
    expect(upload.code).toBe(DRIVER_EVIDENCE_QUEUE_ERROR_CODES.QUEUE_ID_REQUIRED)
    expect(db.code).toBe(DRIVER_EVIDENCE_QUEUE_ERROR_CODES.QUEUE_ID_REQUIRED)
    expect(storeApi.manualUploadRetry).not.toHaveBeenCalled()
    expect(storeApi.manualDbRetry).not.toHaveBeenCalled()
  })

  test('hook exposes manualUploadRetry and manualDbRetry', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const apiRef = { current: null }
    function Probe() {
      apiRef.current = useDriverPhotoUploadQueue({
        driverId: DRIVER_ID,
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient: createSessionClient(),
        createDb: () => ({
          putRecord: async () => {},
          getRecord: async () => null,
          listRecordsForActor: async () => [],
          close: async () => {},
        }),
        createTransport: () => ({ startUpload: jest.fn() }),
        createReconciler: () => ({}),
        createStore: () => ({
          start: jest.fn(),
          stop: jest.fn(async () => {}),
          manualUploadRetry: jest.fn(async () => ({ ok: true })),
          manualDbRetry: jest.fn(async () => ({ ok: true })),
        }),
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-hook',
        createLeaseOwner: () => 'lease-hook',
      })
      return null
    }
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await Promise.resolve() })
    expect(typeof apiRef.current.manualUploadRetry).toBe('function')
    expect(typeof apiRef.current.manualDbRetry).toBe('function')
    await act(async () => { root.unmount() })
    container.remove()
  })
})

describe('useDriverPhotoUploadQueue P11D observation', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
  })

  async function flushMicrotasks() {
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
  }

  async function waitForPolling(ms = 1100) {
    await act(async () => { await new Promise((r) => { setTimeout(r, ms) }) })
  }

  function createRecord({
    queueId,
    status,
    actorScopeId = DRIVER_ID,
    entityId = JOB_ID,
    sourceSurface = DRIVER_EVIDENCE_SOURCE_SURFACE,
    extra = {},
  }) {
    return {
      queue_id: queueId,
      status,
      actor_scope_type: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
      actor_scope_id: actorScopeId,
      source_surface: sourceSurface,
      entity_type: DRIVER_EVIDENCE_ENTITY_TYPE,
      entity_id: entityId,
      provisional_id: null,
      bytes_uploaded: 50,
      bytes_total: 100,
      blob: new Blob(['x']),
      tus_upload_url: 'https://tus.example.com/secret',
      remote_public_url: 'https://storage.example.com/photo.jpg',
      metadata_payload: { secret: 'x' },
      last_error: { code: 'HTTP_500', message: 'leak' },
      created_at: FIXED_NOW,
      ...extra,
    }
  }

  test('queueRecords filters actor, source surface, and entity', async () => {
    const recordsById = new Map()
    recordsById.set('q-current', createRecord({ queueId: 'q-current', status: PHOTO_UPLOAD_STATUSES.QUEUED }))
    recordsById.set('q-wrong-actor', createRecord({ queueId: 'q-wrong-actor', status: PHOTO_UPLOAD_STATUSES.QUEUED, actorScopeId: OTHER_DRIVER_ID }))
    recordsById.set('q-wrong-entity', createRecord({ queueId: 'q-wrong-entity', status: PHOTO_UPLOAD_STATUSES.QUEUED, entityId: OTHER_JOB_ID }))
    recordsById.set('q-wrong-source', createRecord({ queueId: 'q-wrong-source', status: PHOTO_UPLOAD_STATUSES.QUEUED, sourceSurface: 'other_surface' }))
    recordsById.set('q-done', createRecord({ queueId: 'q-done', status: PHOTO_UPLOAD_STATUSES.DONE }))
    let listCallCount = 0
    const db = {
      putRecord: jest.fn(),
      getRecord: jest.fn(async () => null),
      listRecordsForActor: jest.fn(async () => {
        listCallCount += 1
        return Array.from(recordsById.values())
      }),
      close: jest.fn(),
    }
    const supabaseClient = createSessionClient()
    const createDb = () => db
    const createTransport = () => ({ startUpload: jest.fn() })
    const createReconciler = () => ({})
    const createStore = () => ({ start: jest.fn(), stop: jest.fn(async () => {}), resumePausedUploads: jest.fn(async () => ({ resumed: 0 })) })
    const apiRef = { current: null }
    function Probe() {
      apiRef.current = useDriverPhotoUploadQueue({
        driverId: DRIVER_ID,
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient,
        createDb,
        createTransport,
        createReconciler,
        createStore,
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-hook',
        createLeaseOwner: () => 'lease-hook',
      })
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await flushMicrotasks() })
    expect(apiRef.current.queueRecords.map((r) => r.queue_id)).toEqual(['q-current'])
    expect(listCallCount).toBeGreaterThanOrEqual(1)
    await act(async () => { root.unmount() })
    container.remove()
  })

  test('queueRecords DTO excludes blob, URLs, metadata, and raw error', async () => {
    const recordsById = new Map()
    recordsById.set('q-1', createRecord({ queueId: 'q-1', status: PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD }))
    const db = {
      putRecord: jest.fn(),
      getRecord: jest.fn(async () => null),
      listRecordsForActor: jest.fn(async () => Array.from(recordsById.values())),
      close: jest.fn(),
    }
    const supabaseClient = createSessionClient()
    const createDb = () => db
    const createTransport = () => ({ startUpload: jest.fn() })
    const createReconciler = () => ({})
    const createStore = () => ({ start: jest.fn(), stop: jest.fn(async () => {}), resumePausedUploads: jest.fn(async () => ({ resumed: 0 })) })
    const apiRef = { current: null }
    function Probe() {
      apiRef.current = useDriverPhotoUploadQueue({
        driverId: DRIVER_ID,
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient,
        createDb,
        createTransport,
        createReconciler,
        createStore,
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-hook',
        createLeaseOwner: () => 'lease-hook',
      })
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await flushMicrotasks() })
    const dto = apiRef.current.queueRecords[0]
    expect(dto.queue_id).toBe('q-1')
    expect(dto.status).toBe(PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD)
    expect(dto.source_surface).toBe(DRIVER_EVIDENCE_SOURCE_SURFACE)
    expect(dto.entity_type).toBe(DRIVER_EVIDENCE_ENTITY_TYPE)
    expect(dto.entity_id).toBe(JOB_ID)
    expect(dto.blob).toBeUndefined()
    expect(dto.tus_upload_url).toBeUndefined()
    expect(dto.remote_public_url).toBeUndefined()
    expect(dto.metadata_payload).toBeUndefined()
    expect(dto.last_error).toBeUndefined()
    const json = JSON.stringify(dto)
    expect(json).not.toContain('tus.example')
    expect(json).not.toContain('storage.example')
    expect(json).not.toContain('HTTP_500')
    expect(json).not.toContain('leak')
    await act(async () => { root.unmount() })
    container.remove()
  })

  test('queueRecords refreshes periodically and after enqueue', async () => {
    const recordsById = new Map()
    const db = {
      putRecord: jest.fn(async (record) => { recordsById.set(record.queue_id, record) }),
      getRecord: jest.fn(async () => null),
      listRecordsForActor: jest.fn(async () => Array.from(recordsById.values())),
      close: jest.fn(),
    }
    const supabaseClient = createSessionClient()
    const createDb = () => db
    const createTransport = () => ({ startUpload: jest.fn() })
    const createReconciler = () => ({})
    const createStore = () => ({ start: jest.fn(), stop: jest.fn(async () => {}), resumePausedUploads: jest.fn(async () => ({ resumed: 0 })) })
    const apiRef = { current: null }
    function Probe() {
      apiRef.current = useDriverPhotoUploadQueue({
        driverId: DRIVER_ID,
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient,
        createDb,
        createTransport,
        createReconciler,
        createStore,
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-obs',
        createLeaseOwner: () => 'lease-obs',
      })
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await flushMicrotasks() })
    expect(apiRef.current.queueRecords).toEqual([])

    await act(async () => { await apiRef.current.enqueueFiles([makeFile('a.jpg', 'image/jpeg')]) })
    await act(async () => { await flushMicrotasks() })
    expect(apiRef.current.queueRecords.map((r) => r.queue_id)).toContain('qid-obs')
    expect(apiRef.current.queueRecords[0].status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)

    recordsById.set('qid-obs', createRecord({ queueId: 'qid-obs', status: PHOTO_UPLOAD_STATUSES.UPLOADING }))
    await waitForPolling(1100)
    expect(apiRef.current.queueRecords.map((r) => r.queue_id)).toContain('qid-obs')
    expect(apiRef.current.queueRecords.find((r) => r.queue_id === 'qid-obs').status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(apiRef.current.queueRecords.find((r) => r.queue_id === 'qid-obs').progress_pct).toBe(50)

    await act(async () => { root.unmount() })
    container.remove()
  })

  test('queueRecords refreshes after manual retry and timers stop on unmount', async () => {
    const recordsById = new Map()
    recordsById.set('q-1', createRecord({ queueId: 'q-1', status: PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD }))
    const db = {
      putRecord: jest.fn(),
      getRecord: jest.fn(async () => null),
      listRecordsForActor: jest.fn(async () => Array.from(recordsById.values())),
      close: jest.fn(),
    }
    const storeApi = {
      start: jest.fn(),
      stop: jest.fn(async () => {}),
      resumePausedUploads: jest.fn(async () => ({ resumed: 0 })),
      manualUploadRetry: jest.fn(async () => ({ ok: true, status: PHOTO_UPLOAD_STATUSES.QUEUED })),
    }
    const supabaseClient = createSessionClient()
    const createDb = () => db
    const createTransport = () => ({ startUpload: jest.fn() })
    const createReconciler = () => ({})
    const createStore = () => storeApi
    const getRuntime = () => ({
      wake: async () => {},
      getStore: () => storeApi,
    })
    const apiRef = { current: null }
    function Probe() {
      apiRef.current = useDriverPhotoUploadQueue({
        driverId: DRIVER_ID,
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient,
        createDb,
        createTransport,
        createReconciler,
        createStore,
        getRuntime,
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-obs',
        createLeaseOwner: () => 'lease-obs',
      })
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await flushMicrotasks() })
    expect(apiRef.current.queueRecords[0].status).toBe(PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD)

    recordsById.set('q-1', createRecord({ queueId: 'q-1', status: PHOTO_UPLOAD_STATUSES.QUEUED }))
    await act(async () => { await apiRef.current.manualUploadRetry('q-1') })
    await act(async () => { await flushMicrotasks() })
    expect(apiRef.current.queueRecords[0].status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(storeApi.manualUploadRetry).toHaveBeenCalledWith({ queueId: 'q-1' })

    await act(async () => { root.unmount() })
    container.remove()
  })

  test('observation does not write to the queue or emit domain events', async () => {
    const recordsById = new Map()
    recordsById.set('q-1', createRecord({ queueId: 'q-1', status: PHOTO_UPLOAD_STATUSES.QUEUED }))
    const db = {
      putRecord: jest.fn(),
      getRecord: jest.fn(async () => null),
      listRecordsForActor: jest.fn(async () => Array.from(recordsById.values())),
      close: jest.fn(),
    }
    const supabaseClient = createSessionClient()
    const createDb = () => db
    const createTransport = () => ({ startUpload: jest.fn() })
    const createReconciler = () => ({})
    const createStore = () => ({ start: jest.fn(), stop: jest.fn(async () => {}), resumePausedUploads: jest.fn(async () => ({ resumed: 0 })) })
    const apiRef = { current: null }
    function Probe() {
      apiRef.current = useDriverPhotoUploadQueue({
        driverId: DRIVER_ID,
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient,
        createDb,
        createTransport,
        createReconciler,
        createStore,
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-obs',
        createLeaseOwner: () => 'lease-obs',
      })
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await waitForPolling(1100) })
    await act(async () => { await flushMicrotasks() })
    expect(db.putRecord).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
    container.remove()
  })
})

describe('driver app-wide foreground recovery host', () => {
  afterEach(async () => {
    await resetPhotoUploadRuntimeRegistryForTests()
  })

  test('SURFACE_UNMOUNT_DOES_NOT_STOP_GLOBAL_TRANSPORT and driver surfaces share one runtime', async () => {
    const stop = jest.fn(async () => {})
    const runtimeStores = []
    const hookStores = []
    const runtime = acquirePhotoUploadRuntime({
      actorScopeType: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
      actorScopeId: DRIVER_ID,
      supabaseClient: createSessionClient(),
      createDb: () => ({
        putRecord: jest.fn(),
        getRecord: jest.fn(async () => null),
        listRecordsForActor: jest.fn(async () => []),
        close: jest.fn(async () => {}),
      }),
      createTransport: () => ({ startUpload: jest.fn() }),
      createReconciler: () => ({}),
      createStore: () => {
        runtimeStores.push('runtime')
        return {
          start: jest.fn(),
          stop,
          wake: jest.fn(async () => ({ woke: true, resumed: 0 })),
          resumePausedUploads: jest.fn(async () => ({ resumed: 0 })),
        }
      },
      getAccessToken: async () => BEARER_SENTINEL,
      now: () => FIXED_NOW,
    })
    await runtime.ready
    const hookDb = {
      putRecord: jest.fn(),
      getRecord: jest.fn(async () => null),
      listRecordsForActor: jest.fn(async () => []),
      close: jest.fn(async () => {}),
    }
    function EvidenceProbe() {
      useDriverPhotoUploadQueue({
        driverId: DRIVER_ID,
        jobId: JOB_ID,
        runType: 'after_del',
        supabaseClient: createSessionClient(),
        createDb: () => hookDb,
        createStore: () => {
          hookStores.push('evidence')
          return { start: jest.fn(), stop: jest.fn(async () => {}) }
        },
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-evidence',
        createLeaseOwner: () => 'lease-evidence',
      })
      return null
    }
    function ReportProbe() {
      useDriverReportPhotoUploadQueue({
        sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_TAB,
        driverId: DRIVER_ID,
        reportId: 'report-9',
        supabaseClient: createSessionClient(),
        createDb: () => hookDb,
        createStore: () => {
          hookStores.push('report')
          return { start: jest.fn(), stop: jest.fn(async () => {}) }
        },
        now: () => FIXED_NOW,
        randomUUID: () => 'qid-report',
        createLeaseOwner: () => 'lease-report',
      })
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<><EvidenceProbe /><ReportProbe /></>) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { root.render(<ReportProbe />) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { root.unmount() })
    await act(async () => { await Promise.resolve() })
    expect(runtimeStores).toEqual(['runtime'])
    expect(hookStores).toEqual([])
    expect(stop).not.toHaveBeenCalled()
    expect(hookDb.close).toHaveBeenCalled()
    await releasePhotoUploadRuntime(DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE, DRIVER_ID)
    expect(stop).toHaveBeenCalledTimes(1)
    container.remove()
  })
})

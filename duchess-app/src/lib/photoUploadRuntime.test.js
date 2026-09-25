/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_ACTOR_SCOPE_TYPES,
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  createPhotoUploadDb,
} from './photoUploadDb'
import {
  LEASE_TTL_MS,
  createPhotoUploadManager,
} from './photoUploadManager'
import {
  acquirePhotoUploadRuntime,
  getPhotoUploadRuntime,
  releasePhotoUploadRuntime,
  resetPhotoUploadRuntimeRegistryForTests,
} from './photoUploadRuntime'

const SOURCE_BYTES = [1, 2, 3, 4, 5, 250, 251, 252]
const TUS_URL = 'https://tus.example/uploads/same-resource'
const FIXED_CREATED_AT = 1_700_000_000_000
const FIXED_UPDATED_AT = 1_700_000_000_500
const FIXED_NOW = 1_900_000_000_000

let testSeq = 0

function jpegBlob() {
  return new Blob([Uint8Array.from(SOURCE_BYTES)], { type: 'image/jpeg' })
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function flushMany(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await flushPromises()
  }
}

async function waitFor(predicate, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) {
      return
    }
    await flushPromises()
  }
  throw new Error('waitFor timeout')
}

function makeRecord(overrides = {}) {
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: 'queue-office-a-1',
    blob: jpegBlob(),
    file_name: 'evidence.jpg',
    mime_type: 'image/jpeg',
    file_size: SOURCE_BYTES.length,
    source_surface: 'office_evidence',
    entity_type: 'job',
    entity_id: 'job-a',
    provisional_id: null,
    actor_scope_type: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
    actor_scope_id: 'office-a',
    run_type: 'after_del',
    storage_path: 'job-a/after_del_queue-office-a-1.jpg',
    status: PHOTO_UPLOAD_STATUSES.QUEUED,
    upload_attempt_count: 0,
    db_attempt_count: 0,
    next_retry_at: null,
    retry_phase: null,
    discard_requested: false,
    discard_requested_at: null,
    failure_stage: null,
    last_error: null,
    last_http_status: null,
    tus_upload_url: null,
    tus_created_at: null,
    bytes_uploaded: 0,
    bytes_total: SOURCE_BYTES.length,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: { order_id: 'job-a' },
    lease_owner: null,
    lease_generation: 0,
    lease_expires_at: null,
    remote_reconciliation_status: null,
    remote_cleanup_attempt_count: 0,
    remote_cleanup_last_error: null,
    created_at: FIXED_CREATED_AT,
    updated_at: FIXED_UPDATED_AT,
    completed_at: null,
    ...overrides,
  }
}

function createClock(startMs) {
  let nowMs = startMs
  let nextId = 1
  const timeouts = new Map()
  return {
    now: () => nowMs,
    setTimeoutImpl(fn, ms) {
      const id = nextId
      nextId += 1
      timeouts.set(id, { fn, due: nowMs + ms })
      return id
    },
    clearTimeoutImpl(id) {
      timeouts.delete(id)
    },
    jump(ms) {
      nowMs += ms
    },
  }
}

function createTarget() {
  const listeners = new Map()
  return {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      const list = listeners.get(type) || []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = (listeners.get(type) || []).filter((item) => item !== fn)
      listeners.set(type, list)
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn(event)
      }
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length
    },
  }
}

function createTransport({ failReclaim = false } = {}) {
  const startCalls = []
  const abortCalls = []
  const liveByPath = new Map()
  let maxLiveForPath = 0
  return {
    startCalls,
    abortCalls,
    maxLiveForPath: () => maxLiveForPath,
    startUpload(input) {
      const path = input.storagePath
      const attempt = startCalls.filter((call) => call.storagePath === path).length + 1
      startCalls.push({
        storagePath: path,
        tusUploadUrl: input.tusUploadUrl == null ? null : input.tusUploadUrl,
      })
      const live = (liveByPath.get(path) || 0) + 1
      liveByPath.set(path, live)
      maxLiveForPath = Math.max(maxLiveForPath, live)
      let settled = false
      let rejectDone = () => {}
      const done = new Promise((resolve, reject) => {
        rejectDone = reject
        void resolve
      })
      const finish = () => {
        if (settled) {
          return false
        }
        settled = true
        liveByPath.set(path, Math.max(0, (liveByPath.get(path) || 1) - 1))
        return true
      }
      const handle = {
        abort() {
          abortCalls.push(path)
          if (finish()) {
            rejectDone({ code: 'ABORTED', message: 'ABORTED' })
          }
        },
        done,
      }
      if (failReclaim && attempt > 1) {
        queueMicrotask(() => {
          if (finish()) {
            rejectDone({ code: 'RETRYABLE_TRANSPORT', message: 'RETRYABLE_TRANSPORT' })
          }
        })
      }
      return handle
    },
  }
}

async function createHarness(overrides = {}) {
  const dbName = `photo-upload-runtime-${testSeq += 1}`
  const clock = overrides.clock || createClock(FIXED_NOW)
  const transport = overrides.transport || createTransport()
  const windowTarget = overrides.windowTarget || createTarget()
  const documentTarget = overrides.documentTarget || createTarget()
  const managerConstructions = []
  const db = createPhotoUploadDb({ dbName })
  for (const record of overrides.records || []) {
    await db.putRecord(record)
  }
  const actorScopeType = overrides.actorScopeType || PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER
  const actorScopeId = overrides.actorScopeId || 'office-a'
  const runtime = acquirePhotoUploadRuntime({
    actorScopeType,
    actorScopeId,
    createDb: () => db,
    createTransport: () => transport,
    createReconciler: () => ({
      inspectRemoteObject: async () => ({ kind: 'REMOTE_INCOMPLETE' }),
      reconcileEvidencePhotoRow: async () => ({ kind: 'DB_ROW_FOUND', id: 'row-1' }),
    }),
    managerFactory: (options) => {
      managerConstructions.push(options.actorScopeId)
      return createPhotoUploadManager(options)
    },
    getAccessToken: async () => 'runtime-token',
    isOnline: () => true,
    now: clock.now,
    random: overrides.random || (() => 1),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    leaseOwner: overrides.leaseOwner || 'runtime-lease',
    windowTarget,
    documentTarget,
    supabaseClient: overrides.supabaseClient,
  })
  return {
    dbName,
    db,
    clock,
    transport,
    windowTarget,
    documentTarget,
    runtime,
    managerConstructions,
    actorScopeType,
    actorScopeId,
  }
}

describe('photo upload app-wide foreground recovery', () => {
  afterEach(async () => {
    await resetPhotoUploadRuntimeRegistryForTests()
  })

  test('APP_ROOT_BOOTSTRAP_RECOVERY claims persisted QUEUED work without an upload surface', async () => {
    const record = makeRecord({
      queue_id: 'queue-job-a',
      entity_id: 'job-a',
      storage_path: 'job-a/after_del_queue-job-a.jpg',
    })
    const harness = await createHarness({ records: [record] })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 1)
    expect(harness.transport.startCalls[0].storagePath).toBe(record.storage_path)
    expect(harness.managerConstructions).toEqual(['office-a'])
  })

  test('CROSS_SURFACE_PENDING_JOB_RECOVERY processes another order for the same actor', async () => {
    const harness = await createHarness({
      records: [
        makeRecord({
          queue_id: 'queue-job-a',
          entity_id: 'job-a',
          storage_path: 'job-a/after_del_queue-job-a.jpg',
          created_at: FIXED_CREATED_AT,
        }),
        makeRecord({
          queue_id: 'queue-job-b',
          entity_id: 'job-b',
          storage_path: 'job-b/after_del_queue-job-b.jpg',
          created_at: FIXED_CREATED_AT + 1,
        }),
      ],
    })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 2)
    const paths = harness.transport.startCalls.map((call) => call.storagePath).sort()
    expect(paths).toEqual([
      'job-a/after_del_queue-job-a.jpg',
      'job-b/after_del_queue-job-b.jpg',
    ])
    expect(harness.managerConstructions).toEqual(['office-a'])
  })

  test('MAX_CONCURRENT_UPLOADS_PER_ACTOR stays 2 for many pending jobs', async () => {
    const harness = await createHarness({
      records: Array.from({ length: 5 }, (_, index) => makeRecord({
        queue_id: `queue-${index}`,
        entity_id: 'job-a',
        storage_path: `job-a/after_del_queue-${index}.jpg`,
        created_at: FIXED_CREATED_AT + index,
      })),
    })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 2)
    await harness.runtime.wake({ hiddenDuration: 0 })
    await flushMany()
    expect(harness.transport.startCalls).toHaveLength(2)
    expect(harness.managerConstructions).toEqual(['office-a'])
  })

  test('SHORT_BACKGROUND_NO_DESTRUCTIVE_RESTART leaves healthy handles running', async () => {
    const harness = await createHarness({ records: [makeRecord()] })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 1)
    harness.documentTarget.visibilityState = 'hidden'
    harness.documentTarget.dispatch('visibilitychange')
    harness.clock.jump(1000)
    harness.documentTarget.visibilityState = 'visible'
    harness.documentTarget.dispatch('visibilitychange')
    await flushMany()
    expect(harness.transport.abortCalls).toEqual([])
    expect(harness.transport.startCalls).toHaveLength(1)
    expect(harness.transport.maxLiveForPath()).toBe(1)
  })

  test('LONG_SUSPENSION_FOREGROUND_RECOVERY retires stale handles and gives queued work a slot', async () => {
    const harness = await createHarness({
      transport: createTransport({ failReclaim: true }),
      records: [
        makeRecord({
          queue_id: 'uploading-1',
          storage_path: 'job-a/after_del_uploading-1.jpg',
          created_at: FIXED_CREATED_AT,
        }),
        makeRecord({
          queue_id: 'uploading-2',
          storage_path: 'job-a/after_del_uploading-2.jpg',
          created_at: FIXED_CREATED_AT + 1,
        }),
      ],
    })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 2)
    await harness.db.putRecord(makeRecord({
      queue_id: 'queued-3',
      storage_path: 'job-a/after_del_queued-3.jpg',
      created_at: FIXED_CREATED_AT + 2,
    }))
    await harness.db.putRecord(makeRecord({
      queue_id: 'queued-4',
      storage_path: 'job-a/after_del_queued-4.jpg',
      created_at: FIXED_CREATED_AT + 3,
    }))
    harness.documentTarget.visibilityState = 'hidden'
    harness.documentTarget.dispatch('visibilitychange')
    harness.clock.jump(LEASE_TTL_MS)
    harness.documentTarget.visibilityState = 'visible'
    harness.documentTarget.dispatch('visibilitychange')
    await waitFor(() => harness.transport.startCalls.some((call) => call.storagePath.endsWith('queued-3.jpg')))
    expect(harness.transport.abortCalls).toEqual([
      'job-a/after_del_uploading-1.jpg',
      'job-a/after_del_uploading-2.jpg',
    ])
    expect(harness.transport.maxLiveForPath()).toBe(1)
    const stored = await harness.db.listRecordsForActor({
      actorScopeType: harness.actorScopeType,
      actorScopeId: harness.actorScopeId,
    })
    const queued = stored.find((record) => record.queue_id === 'queued-3')
    expect(queued.storage_path).toBe('job-a/after_del_queued-3.jpg')
    expect(stored.filter((record) => record.queue_id === 'queued-3')).toHaveLength(1)
  })

  test('SAME_QUEUE_PATH recovery keeps queueId, storage path, and one live TUS handle', async () => {
    const storagePath = 'job-a/after_del_queue-same.jpg'
    const harness = await createHarness({
      records: [makeRecord({
        queue_id: 'queue-same',
        status: PHOTO_UPLOAD_STATUSES.UPLOADING,
        storage_path: storagePath,
        tus_upload_url: TUS_URL,
        tus_created_at: FIXED_NOW,
        lease_owner: null,
        lease_expires_at: null,
      })],
    })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 1)
    harness.documentTarget.visibilityState = 'hidden'
    harness.documentTarget.dispatch('visibilitychange')
    harness.clock.jump(LEASE_TTL_MS)
    harness.documentTarget.visibilityState = 'visible'
    harness.documentTarget.dispatch('visibilitychange')
    await waitFor(() => harness.transport.startCalls.length >= 2)
    expect(harness.transport.startCalls.every((call) => call.storagePath === storagePath)).toBe(true)
    expect(harness.transport.startCalls.every((call) => call.tusUploadUrl === TUS_URL)).toBe(true)
    expect(harness.transport.maxLiveForPath()).toBe(1)
    expect(harness.transport.abortCalls).toEqual([storagePath])
    const stored = await harness.db.getRecord({
      queueId: 'queue-same',
      actorScopeType: harness.actorScopeType,
      actorScopeId: harness.actorScopeId,
    })
    expect(stored.queue_id).toBe('queue-same')
    expect(stored.storage_path).toBe(storagePath)
    const all = await harness.db.listRecordsForActor({
      actorScopeType: harness.actorScopeType,
      actorScopeId: harness.actorScopeId,
    })
    expect(all.filter((record) => record.queue_id === 'queue-same')).toHaveLength(1)
  })

  test('LIFECYCLE_STALE_RECOVERY_ATTEMPT_BURN stays 0 across abort and reclaim', async () => {
    const initialUploadAttempts = 3
    const initialDbAttempts = 2
    const initialCleanupAttempts = 1
    const storagePath = 'job-a/after_del_queue-attempts.jpg'
    const harness = await createHarness({
      records: [makeRecord({
        queue_id: 'queue-attempts',
        storage_path: storagePath,
        upload_attempt_count: initialUploadAttempts,
        db_attempt_count: initialDbAttempts,
        remote_cleanup_attempt_count: initialCleanupAttempts,
      })],
    })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 1)
    const beforeHide = await harness.db.getRecord({
      queueId: 'queue-attempts',
      actorScopeType: harness.actorScopeType,
      actorScopeId: harness.actorScopeId,
    })
    expect(beforeHide.upload_attempt_count).toBe(initialUploadAttempts)
    expect(beforeHide.db_attempt_count).toBe(initialDbAttempts)
    expect(beforeHide.remote_cleanup_attempt_count).toBe(initialCleanupAttempts)

    harness.documentTarget.visibilityState = 'hidden'
    harness.documentTarget.dispatch('visibilitychange')
    harness.clock.jump(LEASE_TTL_MS)
    harness.documentTarget.visibilityState = 'visible'
    harness.documentTarget.dispatch('visibilitychange')
    await waitFor(() => harness.transport.startCalls.length >= 2)

    expect(harness.transport.abortCalls).toEqual([storagePath])
    expect(harness.transport.maxLiveForPath()).toBe(1)
    expect(harness.transport.startCalls.every((call) => call.storagePath === storagePath)).toBe(true)
    const afterReclaim = await harness.db.getRecord({
      queueId: 'queue-attempts',
      actorScopeType: harness.actorScopeType,
      actorScopeId: harness.actorScopeId,
    })
    expect(afterReclaim.upload_attempt_count).toBe(initialUploadAttempts)
    expect(afterReclaim.db_attempt_count).toBe(initialDbAttempts)
    expect(afterReclaim.remote_cleanup_attempt_count).toBe(initialCleanupAttempts)
    expect(afterReclaim.queue_id).toBe('queue-attempts')
    expect(afterReclaim.storage_path).toBe(storagePath)
  })

  test('PAGESHOW_RECOVERY wakes and pumps, including a persisted BFCache event', async () => {
    const harness = await createHarness({
      records: [makeRecord({
        queue_id: 'queue-visible',
        storage_path: 'job-a/after_del_queue-visible.jpg',
      })],
    })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 1)
    await harness.db.putRecord(makeRecord({
      queue_id: 'queue-pageshow',
      storage_path: 'job-a/after_del_queue-pageshow.jpg',
      created_at: FIXED_CREATED_AT + 5,
    }))
    harness.windowTarget.dispatch('pageshow', { persisted: true })
    await waitFor(() => harness.transport.startCalls.some((call) => (
      call.storagePath === 'job-a/after_del_queue-pageshow.jpg'
    )))
    expect(harness.transport.abortCalls).toEqual([])
  })

  test('ONLINE_PUMPS_QUEUED_WORK when no row is UPLOAD_PAUSED', async () => {
    const harness = await createHarness({
      records: [makeRecord({
        queue_id: 'queue-online-1',
        storage_path: 'job-a/after_del_queue-online-1.jpg',
      })],
    })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 1)
    const before = await harness.db.listRecordsForActor({
      actorScopeType: harness.actorScopeType,
      actorScopeId: harness.actorScopeId,
    })
    expect(before.some((record) => record.status === PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED)).toBe(false)
    await harness.db.putRecord(makeRecord({
      queue_id: 'queue-online-2',
      storage_path: 'job-a/after_del_queue-online-2.jpg',
      created_at: FIXED_CREATED_AT + 4,
    }))
    harness.windowTarget.dispatch('online')
    await waitFor(() => harness.transport.startCalls.some((call) => (
      call.storagePath === 'job-a/after_del_queue-online-2.jpg'
    )))
  })

  test('MANAGER_COUNT_PER_ACTOR stays 1 across repeated acquire and driver versus office actors', async () => {
    const office = await createHarness({ actorScopeId: 'office-a' })
    const again = acquirePhotoUploadRuntime({
      actorScopeType: office.actorScopeType,
      actorScopeId: office.actorScopeId,
    })
    expect(again).toBe(office.runtime)
    await office.runtime.ready
    expect(office.managerConstructions).toEqual(['office-a'])
    await releasePhotoUploadRuntime(office.actorScopeType, office.actorScopeId)
    expect(getPhotoUploadRuntime(office.actorScopeType, office.actorScopeId)).toBe(office.runtime)

    const driver = await createHarness({
      actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL,
      actorScopeId: 'driver-1',
      leaseOwner: 'driver-lease',
    })
    await driver.runtime.ready
    expect(driver.managerConstructions).toEqual(['driver-1'])
    expect(office.managerConstructions).toEqual(['office-a'])
    await releasePhotoUploadRuntime(office.actorScopeType, office.actorScopeId)
  })

  test('release removes lifecycle listeners and stops only that actor runtime', async () => {
    const harness = await createHarness()
    await harness.runtime.ready
    expect(harness.documentTarget.listenerCount('visibilitychange')).toBe(1)
    expect(harness.windowTarget.listenerCount('pageshow')).toBe(1)
    expect(harness.windowTarget.listenerCount('online')).toBe(1)
    await releasePhotoUploadRuntime(harness.actorScopeType, harness.actorScopeId)
    await releasePhotoUploadRuntime(harness.actorScopeType, harness.actorScopeId)
    expect(getPhotoUploadRuntime(harness.actorScopeType, harness.actorScopeId)).toBeNull()
    expect(harness.documentTarget.listenerCount('visibilitychange')).toBe(0)
    expect(harness.windowTarget.listenerCount('pageshow')).toBe(0)
    expect(harness.windowTarget.listenerCount('online')).toBe(0)
  })

  test('office auth identity change does not wake the previous actor runtime', async () => {
    let onAuth = null
    const supabaseClient = {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'office-a' } } } }),
        onAuthStateChange(callback) {
          onAuth = callback
          return { data: { subscription: { unsubscribe: jest.fn() } } }
        },
      },
    }
    const harness = await createHarness({
      supabaseClient,
      records: [makeRecord({
        queue_id: 'queue-auth-1',
        storage_path: 'job-a/after_del_queue-auth-1.jpg',
      })],
    })
    await harness.runtime.ready
    await waitFor(() => harness.transport.startCalls.length === 1)
    await harness.db.putRecord(makeRecord({
      queue_id: 'queue-auth-2',
      storage_path: 'job-a/after_del_queue-auth-2.jpg',
      created_at: FIXED_CREATED_AT + 8,
    }))
    onAuth('SIGNED_IN', { user: { id: 'office-b' } })
    await flushMany()
    expect(harness.transport.startCalls).toHaveLength(1)
    onAuth('TOKEN_REFRESHED', { user: { id: 'office-a' } })
    await waitFor(() => harness.transport.startCalls.some((call) => (
      call.storagePath === 'job-a/after_del_queue-auth-2.jpg'
    )))
  })
})

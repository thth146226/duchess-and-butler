/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

import fs from 'fs'
import path from 'path'
import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  createPhotoUploadDb,
} from './photoUploadDb'
import { LEASE_TTL_MS } from './photoUploadManager'
import {
  BACKOFF_JITTER,
  MANAGER_DB_BACKOFF_BASE_MS,
  MANAGER_DB_BACKOFF_MAX_MS,
  MANAGER_UPLOAD_BACKOFF_BASE_MS,
  MANAGER_UPLOAD_BACKOFF_MAX_MS,
  MAX_DB_ATTEMPTS,
  MAX_MANAGER_UPLOAD_ATTEMPTS,
  PHOTO_UPLOAD_RETRY_PHASES,
  PHOTO_UPLOAD_RUNTIME_ERROR_CODES,
  PHOTO_UPLOAD_WORKER_OUTCOMES,
  PROGRESS_PERSIST_THROTTLE_MS,
  calculateBackoffDelayMs,
  createPhotoUploadStore,
} from './photoUploadStore'

const SOURCE_BYTES = [1, 2, 3, 4, 5, 250, 251, 252]
const SENTINEL_TOKEN = 'p6-sentinel-token-SECRET-never-persist'
const PUBLIC_URL = 'https://example.test/storage/v1/object/public/evidence-photos/job-1/delivery_queue-office-a-1.jpg'
const TUS_URL = 'https://tus.example/uploads/abc'
const FIXED_CREATED_AT = 1_700_000_000_000
const FIXED_UPDATED_AT = 1_700_000_000_500
const FIXED_NOW = 1_900_000_000_000

let testSeq = 0
let dbName
let handles
let fetchCalls

function jpegBlob() {
  return new Blob([Uint8Array.from(SOURCE_BYTES)], { type: 'image/jpeg' })
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

function makeRecord(overrides = {}) {
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: 'queue-office-a-1',
    blob: jpegBlob(),
    file_name: 'evidence.jpg',
    mime_type: 'image/jpeg',
    file_size: SOURCE_BYTES.length,
    source_surface: 'evidence_upload',
    entity_type: 'job',
    entity_id: 'job-1',
    provisional_id: null,
    actor_scope_type: 'office_user',
    actor_scope_id: 'office-a',
    run_type: 'delivery',
    storage_path: 'job-1/delivery_queue-office-a-1.jpg',
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
    metadata_payload: { nested: 'original' },
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

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function flushMany(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await flushPromises()
  }
}

async function waitFor(predicate, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) {
      return
    }
    await flushPromises()
  }
  throw new Error('waitFor timeout')
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
    openTimerCount() {
      return timeouts.size
    },
    jump(ms) {
      nowMs += ms
    },
    async advance(ms) {
      nowMs += ms
      const due = [...timeouts.entries()]
        .filter(([, timer]) => timer.due <= nowMs)
        .sort((left, right) => left[1].due - right[1].due)
      for (const [id, timer] of due) {
        timeouts.delete(id)
        timer.fn()
        await flushMany(4)
      }
    },
  }
}

function collectStrings(value, out, seen) {
  if (value == null) {
    return
  }
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (typeof value !== 'object') {
    return
  }
  if (typeof Blob === 'function' && value instanceof Blob) {
    return
  }
  if (seen.has(value)) {
    return
  }
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

function createFakeTransport(options = {}) {
  const startCalls = []
  const abortCalls = []
  const handles = []
  return {
    startCalls,
    abortCalls,
    handles,
    startUpload(input) {
      const call = {
        storagePath: input.storagePath,
        mimeType: input.mimeType,
        tusUploadUrl: input.tusUploadUrl,
        tusCreatedAt: input.tusCreatedAt,
      }
      startCalls.push(call)
      let resolveDone
      let rejectDone
      let settled = false
      const done = new Promise((resolve, reject) => {
        resolveDone = (value) => {
          if (settled) {
            return
          }
          settled = true
          resolve(value)
        }
        rejectDone = (error) => {
          if (settled) {
            return
          }
          settled = true
          reject(error)
        }
      })
      const handle = {
        abort(shouldTerminate) {
          abortCalls.push(shouldTerminate)
          rejectDone({ code: 'ABORTED', message: 'ABORTED' })
        },
        done,
        input,
        resolveDone,
        rejectDone,
        fireUrl(uploadUrl, createdAt) {
          if (typeof input.onUploadUrl === 'function') {
            input.onUploadUrl({
              uploadUrl,
              createdAt: createdAt == null ? input.now : createdAt,
            })
          }
        },
        fireProgress(bytesUploaded, bytesTotal) {
          if (typeof input.onProgress === 'function') {
            input.onProgress({ bytesUploaded, bytesTotal })
          }
        },
      }
      handles.push(handle)
      if (options.autoComplete) {
        queueMicrotask(() => {
          handle.fireUrl(TUS_URL, input.now)
          resolveDone({
            kind: 'TUS_COMPLETE',
            uploadUrl: TUS_URL,
            storagePath: input.storagePath,
            bytesTotal: input.blob.size,
          })
        })
      }
      return handle
    },
  }
}

function createFakeReconciler(handlers = {}) {
  const inspectCalls = []
  const reconcileCalls = []
  return {
    inspectCalls,
    reconcileCalls,
    async inspectRemoteObject(input) {
      inspectCalls.push(input)
      if (typeof handlers.inspectRemoteObject === 'function') {
        return handlers.inspectRemoteObject(input)
      }
      return {
        kind: 'REMOTE_COMPLETE',
        storagePath: input.storagePath,
        expectedSize: input.expectedSize,
        actualSize: input.expectedSize,
        proofSource: 'STORAGE_INFO',
        publicUrl: PUBLIC_URL,
      }
    },
    async reconcileEvidencePhotoRow(input) {
      reconcileCalls.push(input)
      if (typeof handlers.reconcileEvidencePhotoRow === 'function') {
        return handlers.reconcileEvidencePhotoRow(input)
      }
      return {
        kind: 'DB_INSERT_SUCCEEDED',
        id: 'row-1',
        file_path: input.storagePath,
        photo_url: input.publicUrl,
      }
    },
  }
}

function createHandleSet() {
  const dbs = []
  const stores = []
  return {
    db(instance) {
      dbs.push(instance)
      return instance
    },
    store(instance) {
      stores.push(instance)
      return instance
    },
    async cleanup() {
      for (const store of stores) {
        await store.stop()
      }
      for (const instance of dbs) {
        await instance.close()
      }
    },
  }
}

async function getRow(db, queueId = 'queue-office-a-1', actorScopeId = 'office-a') {
  return db.getRecord({
    queueId,
    actorScopeType: 'office_user',
    actorScopeId,
  })
}

describe('photoUploadStore', () => {
  beforeEach(() => {
    testSeq += 1
    dbName = `duchess-p6-store-${testSeq}`
    handles = createHandleSet()
    fetchCalls = []
    global.fetch = (...args) => {
      fetchCalls.push(args)
      return Promise.reject(new Error('LIVE_NETWORK_FORBIDDEN'))
    }
  })

  afterEach(async () => {
    expect(fetchCalls).toEqual([])
    if (handles) {
      await handles.cleanup()
      handles = null
    }
    if (dbName) {
      await deleteDatabase(dbName)
    }
  })

  test('exports frozen P6 constants', () => {
    expect(MAX_MANAGER_UPLOAD_ATTEMPTS).toBe(5)
    expect(MAX_DB_ATTEMPTS).toBe(5)
    expect(MANAGER_UPLOAD_BACKOFF_BASE_MS).toBe(5000)
    expect(MANAGER_UPLOAD_BACKOFF_MAX_MS).toBe(300000)
    expect(MANAGER_DB_BACKOFF_BASE_MS).toBe(5000)
    expect(MANAGER_DB_BACKOFF_MAX_MS).toBe(300000)
    expect(PROGRESS_PERSIST_THROTTLE_MS).toBe(1000)
    expect(BACKOFF_JITTER).toBe('FULL_JITTER_0_TO_CALCULATED_DELAY')
  })

  test('static store module has no live clients, TUS, React, or SW', () => {
    const source = fs.readFileSync(path.join(__dirname, 'photoUploadStore.js'), 'utf8')
    expect(source).not.toMatch(/createClient\(/)
    expect(source).not.toMatch(/SUPABASE_/)
    expect(source).not.toMatch(/evidence_photos/)
    expect(source).not.toMatch(/tus\.Upload/)
    expect(source).not.toMatch(/new Upload/)
    expect(source).not.toMatch(/storage\.upload/)
    expect(source).not.toMatch(/storage\.update/)
    expect(source).not.toMatch(/x-upsert/)
    expect(source).not.toMatch(/from 'react'/)
    expect(source).not.toMatch(/from "react"/)
    expect(source).not.toMatch(/serviceWorker/)
    expect(source).not.toMatch(/BroadcastChannel/)
    expect(source).not.toMatch(/navigator\.locks/)
    expect(source).not.toMatch(/photoUploadTransport/)
    expect(source).not.toMatch(/photoUploadReconciler/)
    expect(source).not.toMatch(/from '\.\/supabase'/)
  })

  test('full jitter is bounded and capped at 300000', () => {
    expect(calculateBackoffDelayMs(1, 5000, 300000, () => 0)).toBe(0)
    expect(calculateBackoffDelayMs(1, 5000, 300000, () => 1)).toBe(5000)
    expect(calculateBackoffDelayMs(2, 5000, 300000, () => 1)).toBe(10000)
    expect(calculateBackoffDelayMs(7, 5000, 300000, () => 1)).toBe(300000)
    expect(calculateBackoffDelayMs(20, 5000, 300000, () => 1)).toBe(300000)
  })

  function createRuntime(overrides = {}) {
    const db = overrides.db || handles.db(createPhotoUploadDb({ dbName }))
    const clock = overrides.clock || createClock(FIXED_NOW)
    const transport = overrides.transport || createFakeTransport({ autoComplete: true })
    const reconciler = overrides.reconciler || createFakeReconciler()
    const store = handles.store(createPhotoUploadStore({
      db,
      transport,
      reconciler,
      actorScopeType: 'office_user',
      actorScopeId: overrides.actorScopeId || 'office-a',
      leaseOwner: overrides.leaseOwner || 'runtime-a',
      getAccessToken: overrides.getAccessToken || (() => SENTINEL_TOKEN),
      isOnline: overrides.isOnline || (() => true),
      now: clock.now,
      random: overrides.random || (() => 0),
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      ...(overrides.managerFactory ? { managerFactory: overrides.managerFactory } : {}),
    }))
    return {
      db,
      clock,
      transport,
      reconciler,
      store,
    }
  }

  test('A-E QUEUED success pipeline reaches DONE, persists identities, and never reuploads', async () => {
    const { db, store, transport, reconciler } = createRuntime()
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE && row.blob === null
    })
    const stored = await getRow(db)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.DONE)
    expect(stored.remote_public_url).toBe(PUBLIC_URL)
    expect(stored.db_row_id).toBe('row-1')
    expect(stored.storage_path).toBe('job-1/delivery_queue-office-a-1.jpg')
    expect(stored.blob).toBeNull()
    expect(stored.retry_phase).toBeNull()
    expect(stored.next_retry_at).toBeNull()
    expect(transport.startCalls).toHaveLength(1)
    expect(transport.startCalls[0].storagePath).toBe(stored.storage_path)
    expect(reconciler.reconcileCalls).toHaveLength(1)
    assertNoToken(stored)
    assertNoToken(store.getRuntimeStatus())
  })

  test('B status is durably UPLOADING before transport starts', async () => {
    const transport = createFakeTransport()
    const { db, store } = createRuntime({ transport })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.startCalls.length === 1)
    const stored = await getRow(db)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(transport.startCalls).toHaveLength(1)
  })

  test('F offline precheck pauses without transport or attempt burn', async () => {
    const { db, store, transport } = createRuntime({
      isOnline: () => false,
      transport: createFakeTransport(),
    })
    await db.putRecord(makeRecord({ upload_attempt_count: 2 }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED
    })
    const stored = await getRow(db)
    expect(stored.upload_attempt_count).toBe(2)
    expect(transport.startCalls).toHaveLength(0)
    expect(stored.last_error.code).toBe(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.OFFLINE)
    assertNoToken(stored)
  })

  test('G missing auth pauses without transport or attempt burn', async () => {
    const { db, store, transport } = createRuntime({
      getAccessToken: () => null,
      transport: createFakeTransport(),
    })
    await db.putRecord(makeRecord({ upload_attempt_count: 1 }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED
    })
    const stored = await getRow(db)
    expect(stored.upload_attempt_count).toBe(1)
    expect(transport.startCalls).toHaveLength(0)
  })

  test('H transport AUTH_OR_PERMISSION pauses without attempt burn', async () => {
    const transport = createFakeTransport()
    const { db, store } = createRuntime({ transport })
    await db.putRecord(makeRecord({ upload_attempt_count: 3 }))
    store.start()
    await waitFor(() => transport.handles.length === 1)
    transport.handles[0].rejectDone({
      code: 'AUTH_OR_PERMISSION',
      message: SENTINEL_TOKEN,
    })
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED
    })
    const stored = await getRow(db)
    expect(stored.upload_attempt_count).toBe(3)
    expect(stored.last_error).toEqual({
      code: 'AUTH_OR_PERMISSION',
      message: 'AUTH_OR_PERMISSION',
    })
    assertNoToken(stored)
  })

  test('I RETRYABLE_TRANSPORT waits with deterministic next_retry_at', async () => {
    const transport = createFakeTransport()
    const { db, store, clock } = createRuntime({
      transport,
      random: () => 0,
    })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    transport.handles[0].rejectDone({
      code: 'RETRYABLE_TRANSPORT',
      message: SENTINEL_TOKEN,
    })
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT
    })
    const stored = await getRow(db)
    expect(stored.upload_attempt_count).toBe(1)
    expect(stored.retry_phase).toBe(PHOTO_UPLOAD_RETRY_PHASES.UPLOAD)
    expect(stored.next_retry_at).toBe(clock.now())
    assertNoToken(stored)
  })

  test('J max upload attempts prevents a sixth transport call', async () => {
    const transport = createFakeTransport()
    const { db, store } = createRuntime({ transport })
    await db.putRecord(makeRecord({ upload_attempt_count: 5 }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD
    })
    expect(transport.startCalls).toHaveLength(0)
    const stored = await getRow(db)
    expect(stored.last_error.code).toBe(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_UPLOAD_ATTEMPTS_REACHED)
    expect(stored.upload_attempt_count).toBe(5)
  })

  test('J retryable fifth attempt becomes FAILED_UPLOAD', async () => {
    const transport = createFakeTransport()
    const { db, store } = createRuntime({ transport })
    await db.putRecord(makeRecord({ upload_attempt_count: 4 }))
    store.start()
    await waitFor(() => transport.handles.length === 1)
    transport.handles[0].rejectDone({ code: 'RETRYABLE_TRANSPORT' })
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD
    })
    expect(transport.startCalls).toHaveLength(1)
    const stored = await getRow(db)
    expect(stored.upload_attempt_count).toBe(5)
    expect(stored.last_error.code).toBe(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_UPLOAD_ATTEMPTS_REACHED)
  })

  test('K PERMANENT_TRANSPORT maps to FAILED_UPLOAD', async () => {
    const transport = createFakeTransport()
    const { db, store } = createRuntime({ transport })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    transport.handles[0].rejectDone({ code: 'PERMANENT_TRANSPORT' })
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD
    })
    const stored = await getRow(db)
    expect(stored.upload_attempt_count).toBe(1)
    expect(stored.last_error.code).toBe('PERMANENT_TRANSPORT')
  })

  test('L TUS_CONFLICT with remote complete keeps the path and continues', async () => {
    const transport = createFakeTransport()
    const { db, store, reconciler } = createRuntime({ transport })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    const originalPath = (await getRow(db)).storage_path
    transport.handles[0].rejectDone({ code: 'TUS_CONFLICT' })
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
    })
    const stored = await getRow(db)
    expect(stored.storage_path).toBe(originalPath)
    expect(stored.remote_public_url).toBe(PUBLIC_URL)
    expect(transport.startCalls).toHaveLength(1)
    expect(reconciler.inspectCalls).toHaveLength(1)
  })

  test('M TUS_CONFLICT with remote incomplete returns to QUEUED', async () => {
    const transport = createFakeTransport()
    const reconciler = createFakeReconciler({
      inspectRemoteObject: async (input) => ({
        kind: 'REMOTE_INCOMPLETE',
        storagePath: input.storagePath,
        expectedSize: input.expectedSize,
        actualSize: 0,
        proofSource: 'STORAGE_INFO',
        publicUrl: null,
      }),
    })
    const { db, store } = createRuntime({ transport, reconciler })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    const originalPath = (await getRow(db)).storage_path
    transport.handles[0].rejectDone({ code: 'TUS_CONFLICT' })
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.QUEUED
    })
    const stored = await getRow(db)
    expect(stored.storage_path).toBe(originalPath)
    expect(stored.blob).toBeInstanceOf(Blob)
  })

  test('N REMOTE_RETRYABLE uses the upload retry path', async () => {
    const transport = createFakeTransport({ autoComplete: true })
    const reconciler = createFakeReconciler({
      inspectRemoteObject: async () => {
        const error = new Error('REMOTE_RETRYABLE')
        error.code = 'REMOTE_RETRYABLE'
        error.message = SENTINEL_TOKEN
        throw error
      },
    })
    const { db, store } = createRuntime({ transport, reconciler, random: () => 0 })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT
    })
    const stored = await getRow(db)
    expect(stored.upload_attempt_count).toBe(1)
    expect(stored.retry_phase).toBe(PHOTO_UPLOAD_RETRY_PHASES.UPLOAD)
    assertNoToken(stored)
  })

  test('O REMOTE_PERMANENT maps to FAILED_UPLOAD', async () => {
    const transport = createFakeTransport({ autoComplete: true })
    const reconciler = createFakeReconciler({
      inspectRemoteObject: async () => {
        const error = new Error('REMOTE_PERMANENT')
        error.code = 'REMOTE_PERMANENT'
        throw error
      },
    })
    const { db, store } = createRuntime({ transport, reconciler })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD
    })
    const stored = await getRow(db)
    expect(stored.upload_attempt_count).toBe(1)
    expect(stored.last_error.code).toBe('REMOTE_PERMANENT')
  })

  test('P intentional abort does not burn attempts and remains recoverable', async () => {
    const transport = createFakeTransport()
    const { db, store } = createRuntime({ transport })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    await store.stop()
    await flushMany(12)
    expect(transport.abortCalls).toContain(false)
    expect(transport.abortCalls.every((value) => value === false)).toBe(true)
    const stored = await getRow(db)
    expect(stored).toBeTruthy()
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(stored.upload_attempt_count).toBe(0)
    expect(stored.blob).toBeInstanceOf(Blob)
    expect(stored.last_error).toBeNull()
  })

  test('Q onUploadUrl persists the exact TUS URL and created timestamp', async () => {
    const transport = createFakeTransport()
    const { db, store, clock } = createRuntime({ transport })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    transport.handles[0].fireUrl(TUS_URL, clock.now())
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.tus_upload_url === TUS_URL
    })
    const stored = await getRow(db)
    expect(stored.tus_upload_url).toBe(TUS_URL)
    expect(stored.tus_created_at).toBe(FIXED_NOW)
  })

  test('R progress persistence is throttled to 1000ms', async () => {
    const transport = createFakeTransport()
    const { db, store, clock } = createRuntime({ transport })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    transport.handles[0].fireProgress(1, 8)
    transport.handles[0].fireProgress(2, 8)
    transport.handles[0].fireProgress(3, 8)
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.bytes_uploaded === 1
    })
    expect((await getRow(db)).bytes_uploaded).toBe(1)
    clock.jump(PROGRESS_PERSIST_THROTTLE_MS)
    transport.handles[0].fireProgress(4, 8)
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.bytes_uploaded === 4
    })
  })

  test('S T progress cannot overwrite a newer TUS URL or later status', async () => {
    const transport = createFakeTransport()
    const { db, store, clock } = createRuntime({ transport })
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    transport.handles[0].fireProgress(1, 8)
    await waitFor(async () => (await getRow(db)).bytes_uploaded === 1)
    transport.handles[0].fireUrl(TUS_URL, clock.now())
    await waitFor(async () => (await getRow(db)).tus_upload_url === TUS_URL)
    clock.jump(PROGRESS_PERSIST_THROTTLE_MS)
    transport.handles[0].fireProgress(5, 8)
    await waitFor(async () => (await getRow(db)).bytes_uploaded === 5)
    expect((await getRow(db)).tus_upload_url).toBe(TUS_URL)
    expect((await getRow(db)).status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    transport.handles[0].resolveDone({
      kind: 'TUS_COMPLETE',
      uploadUrl: TUS_URL,
      storagePath: 'job-1/delivery_queue-office-a-1.jpg',
      bytesTotal: 8,
    })
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE && row.blob === null
    })
    const handle = transport.handles[0]
    clock.jump(PROGRESS_PERSIST_THROTTLE_MS)
    handle.fireProgress(8, 8)
    await flushMany(12)
    const stored = await getRow(db)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.DONE)
    expect(stored.tus_upload_url).toBe(TUS_URL)
    expect(stored.remote_public_url).toBe(PUBLIC_URL)
    expect(stored.blob).toBeNull()
  })

  test('U V fence loss rejects stale writes and aborts the active upload non-terminating', async () => {
    const transport = createFakeTransport()
    const { db, store, clock } = createRuntime({ transport })
    const dbB = handles.db(createPhotoUploadDb({ dbName }))
    await db.putRecord(makeRecord())
    store.start()
    await waitFor(() => transport.handles.length === 1)
    clock.jump(LEASE_TTL_MS)
    await dbB.claimLease({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      leaseOwner: 'thief',
      now: clock.now(),
      leaseTtlMs: LEASE_TTL_MS,
    })
    transport.handles[0].fireProgress(3, 8)
    await waitFor(() => transport.abortCalls.length >= 1)
    expect(transport.abortCalls).toContain(false)
    await flushMany(8)
    const stored = await getRow(dbB)
    expect(stored.lease_owner).toBe('thief')
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(stored.bytes_uploaded).toBe(0)
    expect(stored.upload_attempt_count).toBe(0)
    expect(store.getRuntimeStatus().lastWorkerOutcome).toBe(PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED)
  })

  test('W recovered STORAGE_COMPLETE begins DB phase with zero transport calls', async () => {
    const transport = createFakeTransport()
    const { db, store, reconciler } = createRuntime({ transport })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
    })
    expect(transport.startCalls).toHaveLength(0)
    expect(reconciler.reconcileCalls).toHaveLength(1)
    const stored = await getRow(db)
    expect(stored.db_row_id).toBe('row-1')
    expect(stored.blob).toBeNull()
  })

  test('X recovered DB_PENDING performs zero transport calls', async () => {
    const transport = createFakeTransport()
    const { db, store } = createRuntime({ transport })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
    })
    expect(transport.startCalls).toHaveLength(0)
  })

  test('Y not-due DB_RETRY_WAIT does nothing', async () => {
    const transport = createFakeTransport()
    const reconciler = createFakeReconciler()
    const { db, store } = createRuntime({ transport, reconciler })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT,
      retry_phase: PHOTO_UPLOAD_RETRY_PHASES.DB,
      next_retry_at: FIXED_NOW + 5000,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await flushMany(16)
    const stored = await getRow(db)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT)
    expect(transport.startCalls).toHaveLength(0)
    expect(reconciler.reconcileCalls).toHaveLength(0)
  })

  test('Z due DB_RETRY_WAIT becomes DB_PENDING and performs zero transport calls', async () => {
    const transport = createFakeTransport()
    const { db, store, reconciler } = createRuntime({ transport })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT,
      retry_phase: PHOTO_UPLOAD_RETRY_PHASES.DB,
      next_retry_at: FIXED_NOW,
      remote_public_url: PUBLIC_URL,
      db_attempt_count: 1,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
    })
    expect(transport.startCalls).toHaveLength(0)
    expect(reconciler.reconcileCalls).toHaveLength(1)
  })

  test('AA DB_ROW_FOUND reaches DONE and clears the Blob', async () => {
    const reconciler = createFakeReconciler({
      reconcileEvidencePhotoRow: async () => ({
        kind: 'DB_ROW_FOUND',
        id: 'existing-row',
        file_path: 'job-1/delivery_queue-office-a-1.jpg',
        photo_url: PUBLIC_URL,
      }),
    })
    const { db, store, transport } = createRuntime({
      transport: createFakeTransport(),
      reconciler,
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE && row.blob === null
    })
    const stored = await getRow(db)
    expect(stored.db_row_id).toBe('existing-row')
    expect(transport.startCalls).toHaveLength(0)
  })

  test('AB DB_INSERT_SUCCEEDED reaches DONE and clears the Blob', async () => {
    const { db, store } = createRuntime({
      transport: createFakeTransport(),
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE && row.blob === null
    })
    expect((await getRow(db)).db_row_id).toBe('row-1')
  })

  test('AC DB_RETRYABLE waits in DB phase', async () => {
    const reconciler = createFakeReconciler({
      reconcileEvidencePhotoRow: async () => {
        const error = new Error('DB_RETRYABLE')
        error.code = 'DB_RETRYABLE'
        throw error
      },
    })
    const { db, store, clock } = createRuntime({
      transport: createFakeTransport(),
      reconciler,
      random: () => 0,
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT
    })
    const stored = await getRow(db)
    expect(stored.retry_phase).toBe(PHOTO_UPLOAD_RETRY_PHASES.DB)
    expect(stored.db_attempt_count).toBe(1)
    expect(stored.next_retry_at).toBe(clock.now())
  })

  test('AD DB_INSERT_AMBIGUOUS does not immediately retry a second insert', async () => {
    const reconciler = createFakeReconciler({
      reconcileEvidencePhotoRow: async () => {
        const error = new Error('DB_INSERT_AMBIGUOUS')
        error.code = 'DB_INSERT_AMBIGUOUS'
        throw error
      },
    })
    const { db, store } = createRuntime({
      transport: createFakeTransport(),
      reconciler,
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT
    })
    await flushMany(16)
    expect(reconciler.reconcileCalls).toHaveLength(1)
  })

  test('AE DB_AUTH_OR_PERMISSION waits without burning a DB attempt', async () => {
    const reconciler = createFakeReconciler({
      reconcileEvidencePhotoRow: async () => {
        const error = new Error('DB_AUTH_OR_PERMISSION')
        error.code = 'DB_AUTH_OR_PERMISSION'
        throw error
      },
    })
    const { db, store } = createRuntime({
      transport: createFakeTransport(),
      reconciler,
      random: () => 0,
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
      db_attempt_count: 2,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT
    })
    const stored = await getRow(db)
    expect(stored.db_attempt_count).toBe(2)
    expect(stored.retry_phase).toBe(PHOTO_UPLOAD_RETRY_PHASES.DB)
  })

  test('AF DB_PERMANENT maps to FAILED_DB', async () => {
    const reconciler = createFakeReconciler({
      reconcileEvidencePhotoRow: async () => {
        const error = new Error('DB_PERMANENT')
        error.code = 'DB_PERMANENT'
        throw error
      },
    })
    const { db, store } = createRuntime({
      transport: createFakeTransport(),
      reconciler,
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.FAILED_DB
    })
    expect((await getRow(db)).last_error.code).toBe('DB_PERMANENT')
  })

  test('AG DB_MULTIPLE_ROWS maps to FAILED_DB', async () => {
    const reconciler = createFakeReconciler({
      reconcileEvidencePhotoRow: async () => {
        const error = new Error('DB_MULTIPLE_ROWS')
        error.code = 'DB_MULTIPLE_ROWS'
        throw error
      },
    })
    const { db, store } = createRuntime({
      transport: createFakeTransport(),
      reconciler,
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.FAILED_DB
    })
    expect((await getRow(db)).last_error.code).toBe('DB_MULTIPLE_ROWS')
  })

  test('AH max DB attempts prevents a sixth reconciliation', async () => {
    const reconciler = createFakeReconciler()
    const { db, store, transport } = createRuntime({
      transport: createFakeTransport(),
      reconciler,
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
      db_attempt_count: 5,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.FAILED_DB
    })
    expect(reconciler.reconcileCalls).toHaveLength(0)
    expect(transport.startCalls).toHaveLength(0)
    expect((await getRow(db)).last_error.code).toBe(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_DB_ATTEMPTS_REACHED)
  })

  test('AI DB phase never invokes transport', async () => {
    const transport = createFakeTransport()
    const { db, store } = createRuntime({ transport })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE,
      remote_public_url: PUBLIC_URL,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'queue-office-a-2',
      storage_path: 'job-1/delivery_queue-office-a-2.jpg',
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: PUBLIC_URL,
      created_at: FIXED_CREATED_AT + 1,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'queue-office-a-3',
      storage_path: 'job-1/delivery_queue-office-a-3.jpg',
      status: PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT,
      retry_phase: PHOTO_UPLOAD_RETRY_PHASES.DB,
      next_retry_at: FIXED_NOW,
      remote_public_url: PUBLIC_URL,
      created_at: FIXED_CREATED_AT + 2,
    }))
    store.start()
    await waitFor(async () => {
      const one = await getRow(db, 'queue-office-a-1')
      const two = await getRow(db, 'queue-office-a-2')
      const three = await getRow(db, 'queue-office-a-3')
      return one.status === PHOTO_UPLOAD_STATUSES.DONE
        && two.status === PHOTO_UPLOAD_STATUSES.DONE
        && three.status === PHOTO_UPLOAD_STATUSES.DONE
    })
    expect(transport.startCalls).toHaveLength(0)
  })

  test('broken storage invariant fails DB without reupload', async () => {
    const reconciler = createFakeReconciler({
      inspectRemoteObject: async (input) => ({
        kind: 'REMOTE_INCOMPLETE',
        storagePath: input.storagePath,
        expectedSize: input.expectedSize,
        actualSize: 0,
        proofSource: 'STORAGE_INFO',
        publicUrl: null,
      }),
    })
    const { db, store, transport } = createRuntime({
      transport: createFakeTransport(),
      reconciler,
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE,
      remote_public_url: null,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.FAILED_DB
    })
    const stored = await getRow(db)
    expect(stored.last_error.code).toBe(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.REMOTE_STORAGE_INVARIANT_BROKEN)
    expect(stored.status).not.toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(transport.startCalls).toHaveLength(0)
  })

  test('missing public URL can be recovered by remote inspect then continue DB', async () => {
    const { db, store, transport, reconciler } = createRuntime({
      transport: createFakeTransport(),
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DB_PENDING,
      remote_public_url: null,
    }))
    store.start()
    await waitFor(async () => {
      const row = await getRow(db)
      return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
    })
    const stored = await getRow(db)
    expect(stored.remote_public_url).toBe(PUBLIC_URL)
    expect(transport.startCalls).toHaveLength(0)
    expect(reconciler.inspectCalls).toHaveLength(1)
    expect(reconciler.reconcileCalls).toHaveLength(1)
  })

  test('stop prevents new claims, aborts active upload, and does not delete the queue', async () => {
    const transport = createFakeTransport()
    const { db, store, clock } = createRuntime({ transport })
    await db.putRecord(makeRecord({ queue_id: 'q-1', storage_path: 'job-1/delivery_q-1.jpg' }))
    await db.putRecord(makeRecord({
      queue_id: 'q-2',
      storage_path: 'job-1/delivery_q-2.jpg',
      created_at: FIXED_CREATED_AT + 1,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-3',
      storage_path: 'job-1/delivery_q-3.jpg',
      created_at: FIXED_CREATED_AT + 2,
    }))
    store.start()
    await waitFor(() => transport.handles.length === 2)
    await store.stop()
    await flushMany(12)
    expect(transport.startCalls).toHaveLength(2)
    expect(transport.abortCalls.length).toBeGreaterThan(0)
    expect(transport.abortCalls.every((value) => value === false)).toBe(true)
    expect(clock.openTimerCount()).toBe(0)
    const one = await getRow(db, 'q-1')
    const two = await getRow(db, 'q-2')
    const three = await getRow(db, 'q-3')
    expect(one).toBeTruthy()
    expect(two).toBeTruthy()
    expect(three).toBeTruthy()
    expect(three.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(three.lease_owner).toBeNull()
    expect(one.blob).toBeInstanceOf(Blob)
    expect(one.upload_attempt_count).toBe(0)
  })

  test('start does not mutate an unrelated actor', async () => {
    const { db, store, transport } = createRuntime({
      transport: createFakeTransport(),
    })
    await db.putRecord(makeRecord())
    await db.putRecord(makeRecord({
      queue_id: 'queue-office-b-1',
      actor_scope_id: 'office-b',
      storage_path: 'job-1/delivery_queue-office-b-1.jpg',
    }))
    store.start()
    await waitFor(() => transport.handles.length === 1)
    const other = await getRow(db, 'queue-office-b-1', 'office-b')
    expect(other.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(other.lease_owner).toBeNull()
  })

  test('resumePausedUploads transitions only UPLOAD_PAUSED via UPLOAD_RESUME_READY and pumps once after persist', async () => {
    const pumps = []
    const persistAtPump = []
    const blob = jpegBlob()
    const { db, store, transport } = createRuntime({
      transport: createFakeTransport(),
      managerFactory: () => ({
        pump: async () => {
          const row = await getRow(db)
          persistAtPump.push(row && row.status)
          pumps.push('pump')
        },
        stop: async () => {},
      }),
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED,
      blob,
      upload_attempt_count: 3,
      db_attempt_count: 2,
      tus_upload_url: TUS_URL,
      tus_created_at: FIXED_NOW - 10,
      storage_path: 'job-1/delivery_queue-office-a-1.jpg',
      file_name: 'evidence.jpg',
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-failed-upload',
      storage_path: 'job-1/delivery_q-failed-upload.jpg',
      status: PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD,
      upload_attempt_count: 5,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-failed-db',
      storage_path: 'job-1/delivery_q-failed-db.jpg',
      status: PHOTO_UPLOAD_STATUSES.FAILED_DB,
      db_attempt_count: 5,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-upload-wait',
      storage_path: 'job-1/delivery_q-upload-wait.jpg',
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT,
      next_retry_at: FIXED_NOW + 9_000,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-db-wait',
      storage_path: 'job-1/delivery_q-db-wait.jpg',
      status: PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT,
      next_retry_at: FIXED_NOW + 9_000,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-draft',
      storage_path: null,
      entity_id: null,
      status: PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED,
      provisional_id: 'prov-1',
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-unknown',
      storage_path: null,
      entity_id: null,
      status: PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN,
      provisional_id: 'prov-2',
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-done',
      storage_path: 'job-1/delivery_q-done.jpg',
      status: PHOTO_UPLOAD_STATUSES.DONE,
      blob: null,
      completed_at: FIXED_NOW,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-paused-2',
      storage_path: 'job-1/delivery_q-paused-2.jpg',
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED,
      upload_attempt_count: 1,
      db_attempt_count: 0,
    }))
    const result = await store.resumePausedUploads()
    expect(result).toEqual({ resumed: 2 })
    expect(pumps).toEqual(['pump'])
    expect(persistAtPump).toEqual([PHOTO_UPLOAD_STATUSES.QUEUED])
    expect(transport.startCalls).toHaveLength(0)
    const resumed = await getRow(db)
    expect(resumed.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(resumed.queue_id).toBe('queue-office-a-1')
    expect(resumed.actor_scope_type).toBe('office_user')
    expect(resumed.actor_scope_id).toBe('office-a')
    expect(resumed.entity_type).toBe('job')
    expect(resumed.entity_id).toBe('job-1')
    expect(resumed.provisional_id).toBeNull()
    expect(resumed.storage_path).toBe('job-1/delivery_queue-office-a-1.jpg')
    expect(resumed.blob).toBeInstanceOf(Blob)
    expect(resumed.blob.size).toBe(blob.size)
    expect(resumed.blob.type).toBe(blob.type)
    expect(resumed.file_name).toBe('evidence.jpg')
    expect(resumed.mime_type).toBe('image/jpeg')
    expect(resumed.file_size).toBe(SOURCE_BYTES.length)
    expect(resumed.source_surface).toBe('evidence_upload')
    expect(resumed.tus_upload_url).toBe(TUS_URL)
    expect(resumed.upload_attempt_count).toBe(3)
    expect(resumed.db_attempt_count).toBe(2)
    expect(resumed.created_at).toBe(FIXED_CREATED_AT)
    expect((await getRow(db, 'q-failed-upload')).status).toBe(PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD)
    expect((await getRow(db, 'q-failed-db')).status).toBe(PHOTO_UPLOAD_STATUSES.FAILED_DB)
    expect((await getRow(db, 'q-upload-wait')).status).toBe(PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT)
    expect((await getRow(db, 'q-db-wait')).status).toBe(PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT)
    expect((await getRow(db, 'q-draft')).status).toBe(PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED)
    expect((await getRow(db, 'q-unknown')).status).toBe(PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN)
    expect((await getRow(db, 'q-done')).status).toBe(PHOTO_UPLOAD_STATUSES.DONE)
  })

  test('resumePausedUploads with zero paused rows does not pump', async () => {
    const pumps = []
    const { db, store } = createRuntime({
      managerFactory: () => ({
        pump: async () => {
          pumps.push('pump')
        },
        stop: async () => {},
      }),
    })
    await db.putRecord(makeRecord({ status: PHOTO_UPLOAD_STATUSES.QUEUED }))
    const result = await store.resumePausedUploads()
    expect(result).toEqual({ resumed: 0 })
    expect(pumps).toEqual([])
  })

  test('resumePausedUploads cannot resume another actor queue', async () => {
    const pumps = []
    const { db, store } = createRuntime({
      managerFactory: () => ({
        pump: async () => {
          pumps.push('pump')
        },
        stop: async () => {},
      }),
    })
    await db.putRecord(makeRecord({
      queue_id: 'queue-office-b-1',
      actor_scope_id: 'office-b',
      storage_path: 'job-1/delivery_queue-office-b-1.jpg',
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED,
    }))
    const result = await store.resumePausedUploads()
    expect(result).toEqual({ resumed: 0 })
    expect(pumps).toEqual([])
    const other = await getRow(db, 'queue-office-b-1', 'office-b')
    expect(other.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED)
  })

  test('stale resume cannot clobber a newer UPLOADING record', async () => {
    const { db, store, clock } = createRuntime({
      managerFactory: () => ({
        pump: async () => {},
        stop: async () => {},
      }),
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED,
    }))
    const held = await db.claimLease({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      leaseOwner: 'tab-b',
      now: clock.now(),
      leaseTtlMs: LEASE_TTL_MS,
    })
    await db.putRecordFenced({
      record: {
        ...held,
        status: PHOTO_UPLOAD_STATUSES.UPLOADING,
        updated_at: clock.now(),
      },
      leaseOwner: 'tab-b',
      leaseGeneration: held.lease_generation,
    })
    const result = await store.resumePausedUploads()
    expect(result).toEqual({ resumed: 0 })
    const stored = await getRow(db)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(stored.lease_owner).toBe('tab-b')
  })

  test('fence loss cannot clobber newer state', async () => {
    const { db, store, clock } = createRuntime({
      leaseOwner: 'runtime-a',
      managerFactory: () => ({
        pump: async () => {},
        stop: async () => {},
      }),
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED,
    }))
    const originalClaim = db.claimLease.bind(db)
    db.claimLease = async (args) => {
      const claimed = await originalClaim(args)
      await db.putRecord({
        ...claimed,
        status: PHOTO_UPLOAD_STATUSES.UPLOADING,
        lease_owner: 'thief',
        lease_generation: claimed.lease_generation + 1,
        lease_expires_at: clock.now() + LEASE_TTL_MS,
        updated_at: clock.now(),
      })
      return claimed
    }
    const result = await store.resumePausedUploads()
    expect(result).toEqual({ resumed: 0 })
    const stored = await getRow(db)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(stored.lease_owner).toBe('thief')
  })

  test('failed fenced persist leaves the paused record durable', async () => {
    const { db, store } = createRuntime({
      managerFactory: () => ({
        pump: async () => {},
        stop: async () => {},
      }),
    })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED,
      upload_attempt_count: 2,
    }))
    db.putRecordFenced = async () => {
      throw new Error('persist exploded')
    }
    const result = await store.resumePausedUploads()
    expect(result).toEqual({ resumed: 0 })
    const stored = await getRow(db)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED)
    expect(stored.upload_attempt_count).toBe(2)
  })

  test('resumePausedUploads source uses UPLOAD_RESUME_READY and never transports directly', () => {
    const source = fs.readFileSync(path.join(__dirname, 'photoUploadStore.js'), 'utf8')
    const resumeFn = source.slice(source.indexOf('async function resumePausedUploads'))
    const resumeBody = resumeFn.slice(0, resumeFn.indexOf('return { resumed }') + 20)
    expect(resumeBody).toMatch(/UPLOAD_RESUME_READY/)
    expect(resumeBody).not.toMatch(/tus\.Upload/)
    expect(resumeBody).not.toMatch(/transport\.startUpload/)
    expect(resumeBody).not.toMatch(/inspectRemoteObject/)
    expect(resumeBody).not.toMatch(/evidence_photos/)
  })
})

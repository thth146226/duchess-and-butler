/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_ACTOR_SCOPE_TYPES,
  PHOTO_UPLOAD_DB_ERROR_CODES,
  PHOTO_UPLOAD_DB_VERSION,
  PHOTO_UPLOAD_QUEUE_STORE,
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  PhotoUploadDbError,
  createPhotoUploadDb,
} from './photoUploadDb'
import {
  LEASE_TTL_MS,
  createPhotoUploadManager,
} from './photoUploadManager'
import {
  acquirePhotoUploadRuntime,
  resetPhotoUploadRuntimeRegistryForTests,
} from './photoUploadRuntime'

const SOURCE_BYTES = [9, 8, 7, 6, 5, 4, 250]
const TUS_URL = 'https://tus.example/uploads/queue-recovery'
const ACTOR = {
  actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
  actorScopeId: 'office-recovery',
}
const FIXED_NOW = 1_900_000_000_000

let testSeq = 0

function jpegBlob(bytes = SOURCE_BYTES) {
  return new Blob([Uint8Array.from(bytes)], { type: 'image/jpeg' })
}

async function bytesOf(blob) {
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

function deleteDatabase(name) {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

function openVersion(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      if (typeof upgrade === 'function') {
        upgrade(request.result)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('open failed'))
  })
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('transaction error'))
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
  })
}

function makeRecord(overrides = {}) {
  const blob = Object.prototype.hasOwnProperty.call(overrides, 'blob') ? overrides.blob : jpegBlob()
  const fileSize = blob instanceof Blob ? blob.size : SOURCE_BYTES.length
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: 'queue-recovery-1',
    blob,
    file_name: 'evidence.jpg',
    mime_type: 'image/jpeg',
    file_size: fileSize,
    source_surface: 'office_evidence',
    entity_type: 'job',
    entity_id: 'job-recovery',
    provisional_id: null,
    actor_scope_type: ACTOR.actorScopeType,
    actor_scope_id: ACTOR.actorScopeId,
    run_type: 'after_del',
    storage_path: 'job-recovery/after_del_queue-recovery-1.jpg',
    status: PHOTO_UPLOAD_STATUSES.QUEUED,
    upload_attempt_count: 1,
    db_attempt_count: 0,
    next_retry_at: null,
    retry_phase: null,
    discard_requested: false,
    discard_requested_at: null,
    failure_stage: null,
    last_error: null,
    last_http_status: null,
    tus_upload_url: TUS_URL,
    tus_created_at: FIXED_NOW - 1000,
    bytes_uploaded: 0,
    bytes_total: fileSize,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: { synthetic: true },
    lease_owner: null,
    lease_generation: 4,
    lease_expires_at: null,
    remote_reconciliation_status: null,
    remote_cleanup_attempt_count: 0,
    remote_cleanup_last_error: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_500,
    completed_at: null,
    ...overrides,
    blob,
    file_size: fileSize,
    bytes_total: fileSize,
  }
}

async function seedV1(name, record) {
  const raw = await openVersion(name, PHOTO_UPLOAD_DB_VERSION, (database) => {
    if (database.objectStoreNames.contains(PHOTO_UPLOAD_QUEUE_STORE)) {
      return
    }
    const store = database.createObjectStore(PHOTO_UPLOAD_QUEUE_STORE, { keyPath: 'queue_id' })
    store.createIndex('by_actor', ['actor_scope_type', 'actor_scope_id'])
    store.createIndex('by_actor_status', ['actor_scope_type', 'actor_scope_id', 'status'])
  })
  const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
  tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).put(record)
  await txDone(tx)
  raw.close()
}

function installStoredBlobRewriteGuard() {
  const nativeGet = IDBObjectStore.prototype.get
  const nativePut = IDBObjectStore.prototype.put
  const storedBlobs = new WeakSet()
  IDBObjectStore.prototype.get = function getStoredBlob(key) {
    const request = nativeGet.call(this, key)
    request.addEventListener('success', () => {
      const value = request.result
      if (value && value.blob instanceof Blob) {
        storedBlobs.add(value.blob)
      }
    })
    return request
  }
  IDBObjectStore.prototype.put = function putStoredBlob(value, key) {
    if (value && value.blob instanceof Blob && storedBlobs.has(value.blob)) {
      throw new DOMException(
        'Error preparing Blob/File data to be stored in object store',
        'UnknownError'
      )
    }
    return nativePut.call(this, value, key)
  }
  return function restore() {
    IDBObjectStore.prototype.get = nativeGet
    IDBObjectStore.prototype.put = nativePut
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
      listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn))
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn(event)
      }
    },
  }
}

function createTransport() {
  const startCalls = []
  const abortCalls = []
  const liveByPath = new Map()
  return {
    startCalls,
    abortCalls,
    liveFor(path) {
      return liveByPath.get(path) || 0
    },
    startUpload(input) {
      const path = input.storagePath
      startCalls.push({
        storagePath: path,
        tusUploadUrl: input.tusUploadUrl == null ? null : input.tusUploadUrl,
      })
      liveByPath.set(path, (liveByPath.get(path) || 0) + 1)
      let settled = false
      let rejectDone = () => {}
      const done = new Promise((_resolve, reject) => {
        rejectDone = reject
      })
      return {
        abort() {
          abortCalls.push(path)
          if (!settled) {
            settled = true
            liveByPath.set(path, Math.max(0, (liveByPath.get(path) || 1) - 1))
            rejectDone({ code: 'ABORTED', message: 'ABORTED' })
          }
        },
        done,
      }
    },
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(predicate) {
  for (let i = 0; i < 40; i += 1) {
    if (await predicate()) {
      return
    }
    await flush()
  }
  throw new Error('waitFor timeout')
}

describe('photo upload V1 queue recovery', () => {
  afterEach(async () => {
    await resetPhotoUploadRuntimeRegistryForTests()
  })

  test('rewriting the stored blob fails before Uploading and the detached copy preserves the bytes', async () => {
    const dbName = `duchess-queue-recovery-${testSeq += 1}`
    const original = makeRecord()
    await seedV1(dbName, original)
    const restore = installStoredBlobRewriteGuard()
    try {
      const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
      const readTx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readonly')
      const stored = await new Promise((resolve, reject) => {
        const request = readTx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).get(original.queue_id)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await txDone(readTx)
      const writeTx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
      expect(() => writeTx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).put(stored)).toThrow('Error preparing Blob/File data')
      try {
        writeTx.abort()
      } catch (_error) {
        // The simulated write already aborted the transaction.
      }
      raw.close()

      const db = createPhotoUploadDb({ dbName })
      const claimed = await db.claimLease({
        queueId: original.queue_id,
        ...ACTOR,
        leaseOwner: 'tab-recovery',
        now: FIXED_NOW,
        leaseTtlMs: 30000,
      })
      expect(claimed.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
      expect(claimed.queue_id).toBe(original.queue_id)
      expect(claimed.tus_upload_url).toBe(TUS_URL)
      expect(claimed.bytes_uploaded).toBe(0)
      expect(await bytesOf(claimed.blob)).toEqual(SOURCE_BYTES)

      const uploading = {
        ...claimed,
        status: PHOTO_UPLOAD_STATUSES.UPLOADING,
        updated_at: FIXED_NOW,
      }
      const fenced = await db.putRecordFenced({
        record: uploading,
        leaseOwner: 'tab-recovery',
        leaseGeneration: claimed.lease_generation,
      })
      expect(fenced.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
      expect(fenced.queue_id).toBe(original.queue_id)
      expect(fenced.actor_scope_id).toBe(ACTOR.actorScopeId)
      expect(fenced.tus_upload_url).toBe(TUS_URL)
      expect(fenced.bytes_uploaded).toBe(0)
      expect(await bytesOf(fenced.blob)).toEqual(SOURCE_BYTES)
      await db.close()
    } finally {
      restore()
      await deleteDatabase(dbName)
    }
  })

  test('one failed claim leaves that row Queued and still starts the other row', async () => {
    const started = []
    const rows = [
      makeRecord({ queue_id: 'queue-a', storage_path: 'job-recovery/a.jpg', created_at: 1 }),
      makeRecord({ queue_id: 'queue-b', storage_path: 'job-recovery/b.jpg', created_at: 2 }),
    ]
    const db = {
      async listRecordsForActor() {
        return rows.map((row) => ({ ...row }))
      },
      async claimLease({ queueId }) {
        if (queueId === 'queue-a') {
          throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'IDB_CLAIM_PUT_ERROR')
        }
        const row = rows.find((item) => item.queue_id === queueId)
        return {
          ...row,
          lease_owner: 'owner-1',
          lease_generation: row.lease_generation + 1,
          lease_expires_at: FIXED_NOW + LEASE_TTL_MS,
        }
      },
      async putRecordFenced({ record }) {
        return { ...record, status: PHOTO_UPLOAD_STATUSES.UPLOADING }
      },
      async releaseLease() {
        return null
      },
      async getRecord() {
        return null
      },
    }
    const manager = createPhotoUploadManager({
      db,
      ...ACTOR,
      leaseOwner: 'owner-1',
      now: () => FIXED_NOW,
      setTimeoutImpl: () => 1,
      clearTimeoutImpl: () => {},
      executeClaimedRecord: async (record) => {
        started.push(record.queue_id)
      },
    })
    await manager.pump()
    expect(started).toEqual(['queue-b'])
    expect(rows.find((row) => row.queue_id === 'queue-a').status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    await manager.pump()
    expect(started).toEqual(['queue-b'])
  })

  test('pageshow after a frozen lease resumes the same TUS url without a second live upload', async () => {
    const dbName = `duchess-queue-recovery-${testSeq += 1}`
    const clock = createClock(FIXED_NOW)
    const transport = createTransport()
    const windowTarget = createTarget()
    const documentTarget = createTarget()
    const db = createPhotoUploadDb({ dbName })
    const record = makeRecord({ queue_id: 'queue-frozen' })
    await db.putRecord(record)
    const runtime = acquirePhotoUploadRuntime({
      ...ACTOR,
      createDb: () => db,
      createTransport: () => transport,
      createReconciler: () => ({
        inspectRemoteObject: async () => ({ kind: 'REMOTE_INCOMPLETE' }),
        reconcileEvidencePhotoRow: async () => ({ kind: 'DB_ROW_FOUND', id: 'row-1' }),
      }),
      getAccessToken: async () => 'synthetic-token',
      isOnline: () => true,
      now: clock.now,
      leaseOwner: 'tab-frozen',
      windowTarget,
      documentTarget,
    })
    try {
      await runtime.ready
      await waitFor(() => transport.startCalls.length === 1)
      expect(transport.startCalls[0].tusUploadUrl).toBe(TUS_URL)
      clock.jump(1000)
      windowTarget.dispatch('pageshow', { persisted: true })
      await flush()
      expect(transport.abortCalls).toEqual([])
      expect(transport.liveFor(record.storage_path)).toBe(1)

      clock.jump(LEASE_TTL_MS)
      windowTarget.dispatch('pageshow', { persisted: true })
      await waitFor(() => transport.startCalls.length === 2)
      expect(transport.abortCalls).toEqual([record.storage_path])
      expect(transport.startCalls[1].tusUploadUrl).toBe(TUS_URL)
      expect(transport.startCalls[1].storagePath).toBe(record.storage_path)
      expect(transport.liveFor(record.storage_path)).toBe(1)
      const stored = await db.getRecord({ queueId: record.queue_id, ...ACTOR })
      expect(await bytesOf(stored.blob)).toEqual(SOURCE_BYTES)
      expect(stored.tus_upload_url).toBe(TUS_URL)
      expect(stored.status).not.toBe(PHOTO_UPLOAD_STATUSES.DONE)
    } finally {
      await resetPhotoUploadRuntimeRegistryForTests()
      await deleteDatabase(dbName)
    }
  })
})

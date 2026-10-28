/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import { MAX_CONCURRENT_UPLOADS } from './photoUploadManager'
import {
  PHOTO_UPLOAD_DB_ERROR_CODES,
  PHOTO_UPLOAD_DB_VERSION,
  PHOTO_UPLOAD_PAYLOAD_STORE,
  PHOTO_UPLOAD_QUEUE_STORE,
  createPhotoUploadDb,
} from './photoUploadDb'
import { createPhotoUploadRollbackRecovery } from './photoUploadRollbackRecovery'
import { createPhotoUploadStore } from './photoUploadStore'

const SOURCE_BYTES = [1, 2, 3, 4, 5, 250, 251, 252]
const FIXED_CREATED_AT = 1_700_000_000_000
const FIXED_UPDATED_AT = 1_700_000_000_500
const FIXED_NOW = 1_900_000_000_000
const ACTOR = {
  actorScopeType: 'office_user',
  actorScopeId: 'office-a',
}

let testSeq = 0
let dbName
let db
let store

function jpegBlob(bytes = SOURCE_BYTES) {
  return new Blob([Uint8Array.from(bytes)], { type: 'image/jpeg' })
}

function blobWithMiddle(middleByte) {
  const bytes = new Uint8Array((65536 * 2) + 32)
  bytes.fill(7)
  bytes[65536 + 8] = middleByte
  return new Blob([bytes], { type: 'image/jpeg' })
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('idb request failed'))
  })
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('transaction error'))
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
  })
}

function openVersion(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      if (typeof upgrade === 'function') {
        upgrade(request.result, request.transaction)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('open failed'))
    request.onblocked = () => reject(new Error('open blocked'))
  })
}

function makeRecord(overrides = {}) {
  return {
    schema_version: 1,
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
    tus_upload_url: 'https://tus.example/uploads/existing',
    tus_created_at: FIXED_CREATED_AT,
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

async function readBlobBytes(blob) {
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

async function readStoreValue(name, storeName, key) {
  const raw = await openVersion(name, PHOTO_UPLOAD_DB_VERSION)
  try {
    const tx = raw.transaction(storeName, 'readonly')
    const value = await idbRequest(tx.objectStore(storeName).get(key))
    await txComplete(tx)
    return value
  } finally {
    raw.close()
  }
}

async function seedLegacyRecords(name, records) {
  const raw = await openVersion(name, 1, (database) => {
    const store = database.createObjectStore(PHOTO_UPLOAD_QUEUE_STORE, { keyPath: 'queue_id' })
    store.createIndex('by_actor', ['actor_scope_type', 'actor_scope_id'])
    store.createIndex('by_actor_status', ['actor_scope_type', 'actor_scope_id', 'status'])
  })
  const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
  const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
  records.forEach((record) => store.put(record))
  await txComplete(tx)
  raw.close()
}

function actorGet(queueId, actorScopeId = 'office-a') {
  return db.getRecord({
    queueId,
    actorScopeType: 'office_user',
    actorScopeId,
  })
}

describe('photo upload S1 payload separation', () => {
  beforeEach(() => {
    testSeq += 1
    dbName = `duchess-s1-${testSeq}-${Date.now()}`
    db = createPhotoUploadDb({ dbName })
    store = null
  })

  afterEach(async () => {
    if (store && typeof store.stop === 'function') {
      await store.stop()
      store = null
    }
    if (db && typeof db.close === 'function') {
      await db.close()
      db = null
    }
    if (dbName) {
      await deleteDatabase(dbName)
    }
  })

  test('keeps the database name and stores bytes outside the queue record', async () => {
    expect(MAX_CONCURRENT_UPLOADS).toBe(2)
    const record = makeRecord()
    await db.putRecord(record)
    const queueRow = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, record.queue_id)
    const payload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, record.queue_id)
    expect(queueRow.blob).toBeUndefined()
    expect(queueRow.payload_id).toBe(record.queue_id)
    expect(queueRow.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(queueRow.tus_upload_url).toBe(record.tus_upload_url)
    expect(queueRow.storage_path).toBe(record.storage_path)
    expect(payload.queue_id).toBe(record.queue_id)
    expect(payload.actor_scope_id).toBe('office-a')
    expect(await readBlobBytes(payload.blob)).toEqual(SOURCE_BYTES)
    const listed = await db.listRecordsForActor(ACTOR)
    expect(listed[0].blob).toBeNull()
    expect(listed[0].queue_id).toBe(record.queue_id)
  })

  test('reopen returns the same bytes and a closed instance rejects later writes', async () => {
    await db.putRecord(makeRecord({ queue_id: 'queue-reopen' }))
    await db.close()
    await expect(db.putRecord(makeRecord({ queue_id: 'queue-reopen' }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR,
      message: 'PHOTO_UPLOAD_DB_CLOSED',
    })
    db = createPhotoUploadDb({ dbName })
    const stored = await actorGet('queue-reopen')
    expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
    const payload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-reopen')
    expect(await readBlobBytes(payload.blob)).toEqual(SOURCE_BYTES)
  })

  test('metadata lease updates do not rewrite the payload bytes', async () => {
    await db.putRecord(makeRecord())
    const claimed = await db.claimLease({
      queueId: 'queue-office-a-1',
      ...ACTOR,
      leaseOwner: 'tab-a',
      now: FIXED_NOW,
      leaseTtlMs: 30000,
    })
    const heartbeat = await db.heartbeatLease({
      queueId: 'queue-office-a-1',
      ...ACTOR,
      leaseOwner: 'tab-a',
      leaseGeneration: claimed.lease_generation,
      now: FIXED_NOW + 1000,
      leaseTtlMs: 30000,
    })
    const queueRow = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-office-a-1')
    const payload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-office-a-1')
    expect(queueRow.blob).toBeUndefined()
    expect(queueRow.lease_expires_at).toBe(heartbeat.lease_expires_at)
    expect(await readBlobBytes(payload.blob)).toEqual(SOURCE_BYTES)
    await expect(db.putRecordFenced({
      record: makeRecord({
        status: PHOTO_UPLOAD_STATUSES.UPLOADING,
        blob: jpegBlob([9, 9, 9, 9, 9, 9, 9, 9]),
        file_size: 8,
        bytes_total: 8,
      }),
      leaseOwner: 'tab-b',
      leaseGeneration: claimed.lease_generation,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_FENCE_CONFLICT,
    })
    const afterFence = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-office-a-1')
    expect(await readBlobBytes(afterFence.blob)).toEqual(SOURCE_BYTES)
  })

  test('upgrades one legacy record at a time and leaves a bad copy untouched', async () => {
    const good = makeRecord({
      queue_id: 'queue-b',
      storage_path: 'job-1/delivery_queue-b.jpg',
    })
    const bad = makeRecord({
      queue_id: 'queue-a',
      storage_path: 'job-1/delivery_queue-a.jpg',
    })
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [bad, good])
    db = createPhotoUploadDb({ dbName })
    await db.listRecordsForActor(ACTOR)
    const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
    const payloadTx = raw.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readwrite')
    payloadTx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).put({
      payload_id: 'queue-a',
      queue_id: 'queue-a',
      actor_scope_type: 'office_user',
      actor_scope_id: 'office-a',
      blob: jpegBlob([9]),
      size_bytes: 1,
      mime_type: 'image/jpeg',
      created_at: FIXED_CREATED_AT,
    })
    await txComplete(payloadTx)
    raw.close()

    const first = await db.migrateNextLegacyRecord()
    expect(first).toMatchObject({ migrated: true, queueId: 'queue-a' })
    const repaired = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-a')
    const repairedPayload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-a')
    expect(repaired.blob).toBeUndefined()
    expect(await readBlobBytes(repairedPayload.blob)).toEqual(SOURCE_BYTES)
    const stillLegacy = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-b')
    expect(stillLegacy.blob).toBeInstanceOf(Blob)

    const second = await db.migrateNextLegacyRecord()
    expect(second).toMatchObject({ migrated: true, queueId: 'queue-b' })
    const promoted = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-b')
    const promotedPayload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-b')
    expect(promoted.blob).toBeUndefined()
    expect(promoted.payload_id).toBe('queue-b')
    expect(await readBlobBytes(promotedPayload.blob)).toEqual(SOURCE_BYTES)
    expect(await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-a')).toBeTruthy()

    const third = await db.migrateNextLegacyRecord()
    expect(third.migrated).toBe(false)
    expect(third.queueId).not.toBe('queue-b')
  })

  test('a migrated legacy record reopens with the same bytes', async () => {
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({ queue_id: 'queue-legacy' })])
    db = createPhotoUploadDb({ dbName })
    const migrated = await db.migrateNextLegacyRecord()
    expect(migrated).toEqual({ migrated: true, queueId: 'queue-legacy' })
    await db.close()
    db = createPhotoUploadDb({ dbName })
    const stored = await actorGet('queue-legacy')
    expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
    const queueRow = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-legacy')
    expect(queueRow.blob).toBeUndefined()
  })

  test('does not return another actor payload and does not resurrect bytes after DONE cleanup', async () => {
    await db.putRecord(makeRecord())
    expect(await db.getPayloadForUpload({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-b',
    })).toBeNull()
    const existing = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-office-a-1')
    existing.actor_scope_id = 'office-b'
    const foreign = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
    const tx = foreign.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readwrite')
    tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).put(existing)
    await txComplete(tx)
    foreign.close()
    const hidden = await actorGet('queue-office-a-1')
    expect(hidden.blob).toBeNull()
    expect(hidden.queue_id).toBe('queue-office-a-1')

    await db.putRecord(makeRecord({
      queue_id: 'queue-done',
      storage_path: 'job-1/delivery_queue-done.jpg',
    }))
    await db.putRecord(makeRecord({
      queue_id: 'queue-done',
      storage_path: 'job-1/delivery_queue-done.jpg',
      status: PHOTO_UPLOAD_STATUSES.DONE,
      completed_at: FIXED_UPDATED_AT,
      blob: null,
    }))
    expect((await actorGet('queue-done')).blob).toBeNull()
    expect(await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-done')).toBeUndefined()
    const claimed = await db.claimLease({
      queueId: 'queue-done',
      ...ACTOR,
      leaseOwner: 'tab-a',
      now: FIXED_NOW,
      leaseTtlMs: 30000,
    })
    await db.putRecordFenced({
      record: makeRecord({
        queue_id: 'queue-done',
        storage_path: 'job-1/delivery_queue-done.jpg',
        status: PHOTO_UPLOAD_STATUSES.DONE,
        completed_at: FIXED_UPDATED_AT,
        blob: jpegBlob(),
      }),
      leaseOwner: 'tab-a',
      leaseGeneration: claimed.lease_generation,
    })
    expect((await actorGet('queue-done')).blob).toBeNull()
    expect(await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-done')).toBeUndefined()
  })

  test('delete removes queue and payload while rollback stays blocked for non-DONE bytes', async () => {
    await db.putRecord(makeRecord({ queue_id: 'queue-keep' }))
    await db.putRecord(makeRecord({
      queue_id: 'queue-drop',
      storage_path: 'job-1/delivery_queue-drop.jpg',
    }))
    const recovery = createPhotoUploadRollbackRecovery({ db })
    const blocked = await recovery.inspectRollbackSafety(ACTOR)
    expect(blocked.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(false)
    expect(blocked.hasRetainedLocalBlob).toBe(true)
    expect(blocked.blockingCount).toBe(2)
    await db.deleteLocalRecord({
      queueId: 'queue-drop',
      ...ACTOR,
    })
    expect(await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-drop')).toBeUndefined()
    expect(await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-drop')).toBeUndefined()
    expect(await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-keep')).toBeTruthy()
    const afterDelete = await recovery.inspectRollbackSafety(ACTOR)
    expect(afterDelete.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(false)
    expect(afterDelete.blockingCount).toBe(1)
  })

  test('concurrent claims keep a single lease and the original bytes', async () => {
    await db.putRecord(makeRecord())
    const claim = (leaseOwner) => db.claimLease({
      queueId: 'queue-office-a-1',
      ...ACTOR,
      leaseOwner,
      now: FIXED_NOW,
      leaseTtlMs: 30000,
    })
    const results = await Promise.allSettled([claim('tab-a'), claim('tab-b')])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.code).toBe(PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_NOT_AVAILABLE)
    const payload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-office-a-1')
    expect(await readBlobBytes(payload.blob)).toEqual(SOURCE_BYTES)
    const queueRow = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-office-a-1')
    expect(queueRow.blob).toBeUndefined()
  })

  test('quota failure aborts before a queue write and preserves the error name', async () => {
    const calls = { aborts: 0, queuePuts: 0 }
    const quota = new Error('quota')
    quota.name = 'QuotaExceededError'
    const failing = createPhotoUploadDb({
      dbName: `${dbName}-quota`,
      openDB: async () => ({
        transaction() {
          return {
            objectStore(name) {
              return {
                get: async () => undefined,
                put: async () => {
                  if (name === PHOTO_UPLOAD_PAYLOAD_STORE) {
                    throw quota
                  }
                  calls.queuePuts += 1
                },
                delete: async () => {},
              }
            },
            abort() {
              calls.aborts += 1
            },
            get done() {
              return Promise.resolve()
            },
          }
        },
        close() {},
      }),
    })
    await expect(failing.putRecord(makeRecord())).rejects.toMatchObject({
      name: 'QuotaExceededError',
      code: PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR,
    })
    expect(calls.aborts).toBeGreaterThan(0)
    expect(calls.queuePuts).toBe(0)
    await failing.close()
  })

  test('versionchange closes the yielded connection and an explicit close stays terminal', async () => {
    let blocking = null
    let terminated = null
    let opens = 0
    const closes = []
    const connection = createPhotoUploadDb({
      dbName: `${dbName}-lifecycle`,
      openDB: async (_name, version, options) => {
        opens += 1
        expect(version).toBe(2)
        blocking = options.blocking
        terminated = options.terminated
        options.blocked()
        const generation = opens
        return {
          close() {
            closes.push(generation)
          },
          getAllFromIndex: async () => [],
        }
      },
    })
    await connection.listRecordsForActor(ACTOR)
    blocking()
    expect(closes).toEqual([1])
    await connection.listRecordsForActor(ACTOR)
    expect(opens).toBe(2)
    terminated()
    await connection.listRecordsForActor(ACTOR)
    expect(opens).toBe(3)
    await connection.close()
    await expect(connection.listRecordsForActor(ACTOR)).rejects.toMatchObject({
      message: 'PHOTO_UPLOAD_DB_CLOSED',
    })
    expect(opens).toBe(3)
    await connection.close()
  })

  test('a missing local payload retries without a remote upload or attempt increment', async () => {
    const starts = []
    await db.putRecord(makeRecord({
      tus_upload_url: 'https://tus.example/uploads/keep',
      upload_attempt_count: 1,
    }))
    const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
    const tx = raw.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readwrite')
    tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).delete('queue-office-a-1')
    await txComplete(tx)
    raw.close()
    store = createPhotoUploadStore({
      db,
      transport: {
        startUpload(input) {
          starts.push(input.storagePath)
          return { done: new Promise(() => {}), abort() {} }
        },
      },
      reconciler: {
        inspectRemoteObject: async () => null,
        reconcileEvidencePhotoRow: async () => null,
      },
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      leaseOwner: 'tab-a',
      getAccessToken: async () => 'local-token',
      isOnline: () => true,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    store.start()
    let stored = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      stored = await actorGet('queue-office-a-1')
      if (stored && stored.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT) {
        break
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT)
    expect(stored.upload_attempt_count).toBe(1)
    expect(stored.last_error.code).toBe('LOCAL_PAYLOAD_UNAVAILABLE')
    expect(stored.next_retry_at).toBe(FIXED_NOW + 5000)
    expect(stored.tus_upload_url).toBe('https://tus.example/uploads/keep')
    expect(starts).toEqual([])
    await store.stop()
  })

  test('stop then wake does not claim or upload', async () => {
    const starts = []
    await db.putRecord(makeRecord())
    store = createPhotoUploadStore({
      db,
      transport: {
        startUpload() {
          starts.push('started')
          return { done: Promise.resolve(), abort() {} }
        },
      },
      reconciler: {
        inspectRemoteObject: async () => null,
        reconcileEvidencePhotoRow: async () => null,
      },
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      leaseOwner: 'tab-a',
      getAccessToken: async () => 'local-token',
      isOnline: () => true,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    await store.stop()
    const woke = await store.wake({ hiddenDuration: 0, source: 'pageshow' })
    expect(woke.woke).toBe(false)
    const stored = await actorGet('queue-office-a-1')
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(stored.lease_owner).toBeNull()
    expect(starts).toEqual([])
  })

  test('byte mismatch in the middle blocks legacy promotion', async () => {
    const original = blobWithMiddle(1)
    const altered = blobWithMiddle(2)
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({
      queue_id: 'queue-middle',
      blob: original,
      file_size: original.size,
      bytes_total: original.size,
    })])
    db = createPhotoUploadDb({
      dbName,
      afterLegacyPayloadCommit: async () => {
        const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
        const tx = raw.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readwrite')
        const payload = await idbRequest(tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).get('queue-middle'))
        payload.blob = altered
        payload.size_bytes = altered.size
        tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).put(payload)
        await txComplete(tx)
        raw.close()
      },
    })
    const result = await db.migrateNextLegacyRecord()
    expect(result).toMatchObject({ migrated: false, deferred: true, queueId: 'queue-middle' })
    const preserved = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-middle')
    expect(preserved.blob).toBeInstanceOf(Blob)
    const preservedBytes = new Uint8Array(await preserved.blob.arrayBuffer())
    const alteredBytes = new Uint8Array(await altered.arrayBuffer())
    expect(preservedBytes[65536 + 8]).toBe(1)
    expect(alteredBytes[65536 + 8]).toBe(2)
    expect(preservedBytes.length).toBe(alteredBytes.length)
  })

  test('interruption after payload commit preserves the legacy record', async () => {
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({ queue_id: 'queue-legacy' })])
    db = createPhotoUploadDb({
      dbName,
      afterLegacyPayloadCommit: async () => {
        throw new Error('interrupted before promotion')
      },
    })
    const result = await db.migrateNextLegacyRecord()
    expect(result).toMatchObject({ migrated: false, deferred: true, queueId: 'queue-legacy' })
    const preserved = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-legacy')
    expect(await readBlobBytes(preserved.blob)).toEqual(SOURCE_BYTES)
    expect(await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-legacy')).toBeTruthy()
  })

  test('a payload deleted after commit is not promoted', async () => {
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({ queue_id: 'queue-legacy' })])
    db = createPhotoUploadDb({
      dbName,
      afterLegacyPayloadCommit: async () => {
        const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
        const tx = raw.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readwrite')
        tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).delete('queue-legacy')
        await txComplete(tx)
        raw.close()
      },
    })
    const result = await db.migrateNextLegacyRecord()
    expect(result).toMatchObject({ migrated: false, deferred: true, queueId: 'queue-legacy' })
    const preserved = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-legacy')
    expect(await readBlobBytes(preserved.blob)).toEqual(SOURCE_BYTES)
  })

  test('a concurrent queue change preserves the legacy record', async () => {
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({ queue_id: 'queue-legacy' })])
    db = createPhotoUploadDb({
      dbName,
      afterLegacyPayloadCommit: async () => {
        const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
        const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
        const row = await idbRequest(tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).get('queue-legacy'))
        row.updated_at += 1
        tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).put(row)
        await txComplete(tx)
        raw.close()
      },
    })
    const result = await db.migrateNextLegacyRecord()
    expect(result).toMatchObject({ migrated: false, deferred: true, queueId: 'queue-legacy' })
    const preserved = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-legacy')
    expect(preserved.updated_at).toBe(FIXED_UPDATED_AT + 1)
    expect(await readBlobBytes(preserved.blob)).toEqual(SOURCE_BYTES)
  })

  test('full byte comparison stays outside active IndexedDB transactions', async () => {
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({ queue_id: 'queue-legacy' })])
    const probe = await openVersion(`${dbName}-probe`, 1, (database) => {
      database.createObjectStore('probe')
    })
    const proto = Object.getPrototypeOf(probe)
    probe.close()
    const originalTransaction = proto.transaction
    const originalArrayBuffer = Blob.prototype.arrayBuffer
    let depth = 0
    let transactions = 0
    let violations = 0
    proto.transaction = function transaction(storeNames, mode) {
      transactions += 1
      const tx = originalTransaction.call(this, storeNames, mode)
      depth += 1
      const release = () => {
        depth = Math.max(0, depth - 1)
      }
      tx.addEventListener('complete', release)
      tx.addEventListener('abort', release)
      return tx
    }
    Blob.prototype.arrayBuffer = function arrayBuffer(...args) {
      if (depth > 0) {
        violations += 1
        throw new DOMException(
          'A request was placed against a transaction which is currently not active.',
          'TransactionInactiveError'
        )
      }
      return originalArrayBuffer.apply(this, args)
    }
    try {
      db = createPhotoUploadDb({ dbName })
      const result = await db.migrateNextLegacyRecord()
      expect(result).toEqual({ migrated: true, queueId: 'queue-legacy' })
      expect(transactions).toBeGreaterThan(0)
      expect(violations).toBe(0)
      const stored = await actorGet('queue-legacy')
      expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
    } finally {
      proto.transaction = originalTransaction
      Blob.prototype.arrayBuffer = originalArrayBuffer
      await deleteDatabase(`${dbName}-probe`)
    }
  })

  test('a payload from another queue is a local failure and does not start upload', async () => {
    const starts = []
    await db.putRecord(makeRecord({ upload_attempt_count: 2 }))
    const payload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-office-a-1')
    payload.queue_id = 'queue-other'
    const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
    const tx = raw.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readwrite')
    tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).put(payload)
    await txComplete(tx)
    raw.close()
    store = createPhotoUploadStore({
      db,
      transport: {
        startUpload() {
          starts.push('started')
          return { done: Promise.resolve({ kind: 'TUS_COMPLETE' }), abort() {} }
        },
      },
      reconciler: {
        inspectRemoteObject: async () => null,
        reconcileEvidencePhotoRow: async () => null,
      },
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      leaseOwner: 'tab-a',
      getAccessToken: async () => 'local-token',
      isOnline: () => true,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    store.start()
    let stored = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      stored = await actorGet('queue-office-a-1')
      if (stored && stored.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT) {
        break
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT)
    expect(stored.upload_attempt_count).toBe(2)
    expect(stored.last_error.code).toBe('LOCAL_PAYLOAD_UNAVAILABLE')
    expect(starts).toEqual([])
    await store.stop()
  })

  test('putRecord cannot recreate bytes after DONE cleanup', async () => {
    await db.putRecord(makeRecord({
      queue_id: 'queue-done',
      storage_path: 'job-1/delivery_queue-done.jpg',
      status: PHOTO_UPLOAD_STATUSES.DONE,
      completed_at: FIXED_UPDATED_AT,
      blob: null,
    }))
    await expect(db.putRecord(makeRecord({
      queue_id: 'queue-done',
      storage_path: 'job-1/delivery_queue-done.jpg',
      status: PHOTO_UPLOAD_STATUSES.DONE,
      completed_at: FIXED_UPDATED_AT,
    }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.BLOB_CLEANUP_FORBIDDEN,
    })
    expect((await actorGet('queue-done')).blob).toBeNull()
    expect(await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-done')).toBeUndefined()
  })

  test('stop settles a pending upload without a late attempt increment', async () => {
    const starts = []
    let finishUpload = () => {}
    const pending = new Promise((resolve) => {
      finishUpload = resolve
    })
    await db.putRecord(makeRecord())
    store = createPhotoUploadStore({
      db,
      transport: {
        startUpload() {
          starts.push('started')
          return { done: pending, abort() {} }
        },
      },
      reconciler: {
        inspectRemoteObject: async () => null,
        reconcileEvidencePhotoRow: async () => null,
      },
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      leaseOwner: 'tab-a',
      getAccessToken: async () => 'local-token',
      isOnline: () => true,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    store.start()
    for (let attempt = 0; attempt < 40 && starts.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(starts).toEqual(['started'])
    let deadlockTimer
    const stopResult = await Promise.race([
      store.stop().then(() => 'stopped'),
      new Promise((resolve) => {
        deadlockTimer = setTimeout(() => resolve('deadlock'), 2000)
      }),
    ])
    clearTimeout(deadlockTimer)
    expect(stopResult).toBe('stopped')
    const stored = await actorGet('queue-office-a-1')
    expect(stored.upload_attempt_count).toBe(0)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(starts).toEqual(['started'])
    finishUpload({ kind: 'TUS_COMPLETE' })
  })

  test('two instances migrating the same legacy record keep the verified payload', async () => {
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({
      queue_id: 'queue-shared',
      storage_path: 'job-1/delivery_queue-shared.jpg',
    })])
    let arrived = 0
    let releaseBoth
    const bothStaged = new Promise((resolve) => {
      releaseBoth = resolve
    })
    const tokens = []
    const hook = async () => {
      const payload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-shared')
      tokens.push(payload.payload_token)
      arrived += 1
      if (arrived === 2) {
        releaseBoth()
      }
      await bothStaged
    }
    const first = createPhotoUploadDb({ dbName, afterLegacyPayloadCommit: hook })
    const second = createPhotoUploadDb({ dbName, afterLegacyPayloadCommit: hook })
    try {
      const [left, right] = await Promise.all([
        first.migrateNextLegacyRecord(),
        second.migrateNextLegacyRecord(),
      ])
      expect(left).toEqual({ migrated: true, queueId: 'queue-shared' })
      expect(right).toEqual({ migrated: true, queueId: 'queue-shared' })
      expect(arrived).toBe(2)
      expect(tokens).toHaveLength(2)
      expect(tokens[0]).toBe(tokens[1])
      expect(typeof tokens[0]).toBe('string')
      expect(tokens[0].length).toBeGreaterThan(0)
      const queueRow = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-shared')
      const payload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-shared')
      expect(queueRow.blob).toBeUndefined()
      expect(queueRow.payload_id).toBe('queue-shared')
      expect(payload.payload_token).toBe(tokens[0])
      expect(await readBlobBytes(payload.blob)).toEqual(SOURCE_BYTES)
    } finally {
      await first.close()
      await second.close()
    }
  })

  test('a payload byte swap with the same metadata is not promoted', async () => {
    const original = blobWithMiddle(1)
    const altered = blobWithMiddle(3)
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({
      queue_id: 'queue-middle',
      storage_path: 'job-1/delivery_queue-middle.jpg',
      blob: original,
      file_size: original.size,
      bytes_total: original.size,
    })])
    db = createPhotoUploadDb({
      dbName,
      beforeLegacyPromote: async ({ payloadToken }) => {
        const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
        const tx = raw.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readwrite')
        const payload = await idbRequest(tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).get('queue-middle'))
        expect(payload.payload_token).toBe(payloadToken)
        payload.blob = altered
        payload.size_bytes = altered.size
        payload.mime_type = altered.type
        tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).put(payload)
        await txComplete(tx)
        raw.close()
      },
    })
    const result = await db.migrateNextLegacyRecord()
    expect(result).toMatchObject({ migrated: false, deferred: true, queueId: 'queue-middle' })
    const preserved = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-middle')
    expect(preserved.blob).toBeInstanceOf(Blob)
    expect(preserved.updated_at).toBe(FIXED_UPDATED_AT)
    expect(preserved.payload_id == null || preserved.payload_id === '').toBe(true)
    const preservedBytes = new Uint8Array(await preserved.blob.arrayBuffer())
    expect(preservedBytes[65536 + 8]).toBe(1)
    expect(preservedBytes.length).toBe(altered.size)
  })

  test('an inline blob swap with the same metadata is not promoted', async () => {
    const original = blobWithMiddle(1)
    const altered = blobWithMiddle(4)
    await db.close()
    db = null
    await seedLegacyRecords(dbName, [makeRecord({
      queue_id: 'queue-middle',
      storage_path: 'job-1/delivery_queue-middle.jpg',
      blob: original,
      file_size: original.size,
      bytes_total: original.size,
    })])
    db = createPhotoUploadDb({
      dbName,
      beforeLegacyPromote: async () => {
        const raw = await openVersion(dbName, PHOTO_UPLOAD_DB_VERSION)
        const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
        const row = await idbRequest(tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).get('queue-middle'))
        row.blob = altered
        tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).put(row)
        await txComplete(tx)
        raw.close()
      },
    })
    const result = await db.migrateNextLegacyRecord()
    expect(result).toMatchObject({ migrated: false, deferred: true, queueId: 'queue-middle' })
    const preserved = await readStoreValue(dbName, PHOTO_UPLOAD_QUEUE_STORE, 'queue-middle')
    expect(preserved.blob).toBeInstanceOf(Blob)
    expect(preserved.updated_at).toBe(FIXED_UPDATED_AT)
    expect(preserved.mime_type).toBe('image/jpeg')
    expect(preserved.file_size).toBe(original.size)
    const preservedBytes = new Uint8Array(await preserved.blob.arrayBuffer())
    expect(preservedBytes[65536 + 8]).toBe(4)
    const payload = await readStoreValue(dbName, PHOTO_UPLOAD_PAYLOAD_STORE, 'queue-middle')
    const payloadBytes = new Uint8Array(await payload.blob.arrayBuffer())
    expect(payloadBytes[65536 + 8]).toBe(1)
    expect(payloadBytes.length).toBe(preservedBytes.length)
  })
})

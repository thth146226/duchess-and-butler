/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_DB_ERROR_CODES,
  PHOTO_UPLOAD_DB_NAME,
  PHOTO_UPLOAD_DB_VERSION,
  PHOTO_UPLOAD_QUEUE_STORE,
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  PhotoUploadDbError,
  createPhotoUploadDb,
} from './photoUploadDb'

const SOURCE_BYTES = [1, 2, 3, 4, 5, 250, 251, 252]
const FIXED_CREATED_AT = 1_700_000_000_000
const FIXED_UPDATED_AT = 1_700_000_000_500

let testSeq = 0
let db
let dbName

function jpegBlob() {
  return new Blob([Uint8Array.from(SOURCE_BYTES)], { type: 'image/jpeg' })
}

async function readBlobBytes(blob) {
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

function openRawDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, PHOTO_UPLOAD_DB_VERSION)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
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

describe('photoUploadDb', () => {
  beforeEach(() => {
    testSeq += 1
    dbName = `duchess-p2-test-${testSeq}`
    db = createPhotoUploadDb({ dbName })
  })

  afterEach(async () => {
    if (db) {
      await db.close()
      db = null
    }
    if (dbName) {
      await deleteDatabase(dbName)
    }
  })

  test('creates version 1 queue store with actor indexes', async () => {
    await db.putRecord(makeRecord())
    await db.close()
    db = null

    const raw = await openRawDatabase(dbName)
    expect(raw.name).toBe(dbName)
    expect(raw.version).toBe(1)
    expect(PHOTO_UPLOAD_DB_NAME).toBe('duchess-photo-upload-v1')
    expect(PHOTO_UPLOAD_DB_VERSION).toBe(1)
    expect(raw.objectStoreNames.contains(PHOTO_UPLOAD_QUEUE_STORE)).toBe(true)

    const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readonly')
    const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
    expect(store.keyPath).toBe('queue_id')
    expect(store.indexNames.contains('by_actor')).toBe(true)
    expect(store.indexNames.contains('by_actor_status')).toBe(true)
    expect(store.index('by_actor').keyPath).toEqual(['actor_scope_type', 'actor_scope_id'])
    expect(store.index('by_actor_status').keyPath).toEqual([
      'actor_scope_type',
      'actor_scope_id',
      'status',
    ])
    raw.close()
  })

  test('persists Blob and metadata atomically with exact jpeg bytes', async () => {
    const record = makeRecord()
    await db.putRecord(record)
    const stored = await db.getRecord({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.file_name).toBe('evidence.jpg')
    expect(stored.blob).toBeInstanceOf(Blob)
    expect(stored.blob.type).toBe('image/jpeg')
    expect(stored.blob.size).toBe(8)
    expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
  })

  test('logical fake-indexeddb reopen preserves record and exact Blob bytes', async () => {
    const record = makeRecord({ queue_id: 'queue-reopen-1' })
    await db.putRecord(record)
    await db.close()

    db = createPhotoUploadDb({ dbName })
    const stored = await db.getRecord({
      queueId: 'queue-reopen-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.queue_id).toBe('queue-reopen-1')
    expect(stored.blob.type).toBe('image/jpeg')
    expect(stored.blob.size).toBe(8)
    expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
  })

  test('committed metadata is structured-clone independent of the source object', async () => {
    const record = makeRecord()
    await db.putRecord(record)
    record.metadata_payload.nested = 'mutated-after-put'
    const stored = await db.getRecord({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.metadata_payload).toEqual({ nested: 'original' })
    expect(stored.metadata_payload).not.toBe(record.metadata_payload)
  })

  test('office A cannot get office B or driver records', async () => {
    await db.putRecord(makeRecord({ queue_id: 'q-office-a' }))
    await db.putRecord(makeRecord({
      queue_id: 'q-office-b',
      actor_scope_id: 'office-b',
      storage_path: 'job-1/delivery_q-office-b.jpg',
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-driver-a',
      actor_scope_type: 'driver_portal',
      actor_scope_id: 'driver-a',
      source_surface: 'driver_portal',
      storage_path: 'job-1/delivery_q-driver-a.jpg',
    }))

    expect(await db.getRecord({
      queueId: 'q-office-b',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })).toBeNull()
    expect(await db.getRecord({
      queueId: 'q-driver-a',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })).toBeNull()
    expect(await db.getRecord({
      queueId: 'q-office-a',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })).not.toBeNull()
  })

  test('listRecordsForActor is isolated across office and driver actors', async () => {
    await db.putRecord(makeRecord({ queue_id: 'q-office-a' }))
    await db.putRecord(makeRecord({
      queue_id: 'q-office-b',
      actor_scope_id: 'office-b',
      storage_path: 'job-1/delivery_q-office-b.jpg',
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-driver-a',
      actor_scope_type: 'driver_portal',
      actor_scope_id: 'driver-a',
      source_surface: 'driver_portal',
      storage_path: 'job-1/delivery_q-driver-a.jpg',
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-driver-b',
      actor_scope_type: 'driver_portal',
      actor_scope_id: 'driver-b',
      source_surface: 'driver_portal',
      storage_path: 'job-1/delivery_q-driver-b.jpg',
    }))

    const officeA = await db.listRecordsForActor({
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    const driverA = await db.listRecordsForActor({
      actorScopeType: 'driver_portal',
      actorScopeId: 'driver-a',
    })
    expect(officeA.map((row) => row.queue_id)).toEqual(['q-office-a'])
    expect(driverA.map((row) => row.queue_id)).toEqual(['q-driver-a'])
  })

  test('rejects cross-actor overwrite and preserves the original record', async () => {
    const original = makeRecord({ queue_id: 'shared-id' })
    await db.putRecord(original)
    await expect(db.putRecord(makeRecord({
      queue_id: 'shared-id',
      actor_scope_id: 'office-b',
      file_name: 'hijacked.jpg',
      storage_path: 'job-1/delivery_shared-id.jpg',
    }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.ACTOR_SCOPE_CONFLICT,
    })
    const stored = await db.getRecord({
      queueId: 'shared-id',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.file_name).toBe('evidence.jpg')
    expect(stored.actor_scope_id).toBe('office-a')
    expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
  })

  test('rejects a status that is not a P1 photo upload status', async () => {
    await expect(db.putRecord(makeRecord({ status: 'NOT_A_STATUS' }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
  })

  test('rejects an unknown top-level field', async () => {
    await expect(db.putRecord(makeRecord({ extra_field: true }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
  })

  test('rejects nested access_token in metadata_payload', async () => {
    await expect(db.putRecord(makeRecord({
      metadata_payload: { nested: { access_token: 'secret' } },
    }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
  })

  test('rejects nested authorization in metadata_payload', async () => {
    await expect(db.putRecord(makeRecord({
      metadata_payload: { headers: { Authorization: 'Bearer x' } },
    }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
  })

  test('rejects nested portal_token in metadata_payload', async () => {
    await expect(db.putRecord(makeRecord({
      metadata_payload: { portal_token: 'tok' },
    }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
  })

  test('rejects a raw Error as last_error', async () => {
    await expect(db.putRecord(makeRecord({
      last_error: new Error('boom'),
    }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
  })

  test('accepts a sanitized last_error object', async () => {
    const record = makeRecord({
      last_error: { code: 'X', message: 'safe' },
    })
    await db.putRecord(record)
    const stored = await db.getRecord({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.last_error).toEqual({ code: 'X', message: 'safe' })
  })

  test('persists DRAFT_QUEUED with null entity_id, null storage_path, and retained Blob', async () => {
    const record = makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED,
      entity_id: null,
      storage_path: null,
    })
    await db.putRecord(record)
    const stored = await db.getRecord({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED)
    expect(stored.entity_id).toBeNull()
    expect(stored.storage_path).toBeNull()
    expect(stored.blob).toBeInstanceOf(Blob)
    expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
  })

  test('round-trips frozen TUS, lease, retry, and remote fields without using their semantics', async () => {
    const record = makeRecord({
      tus_upload_url: 'https://storage.example/tus/1',
      tus_created_at: FIXED_CREATED_AT,
      lease_owner: 'worker-1',
      lease_generation: 4,
      lease_expires_at: FIXED_CREATED_AT + 1000,
      retry_phase: 'upload',
      remote_reconciliation_status: 'pending',
      remote_cleanup_attempt_count: 2,
      remote_cleanup_last_error: { code: 'CLEANUP', message: 'later' },
      db_row_id: 'row-99',
      remote_public_url: 'https://cdn.example/photo.jpg',
      metadata_payload: { camera: 'rear' },
    })
    await db.putRecord(record)
    const stored = await db.getRecord({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.tus_upload_url).toBe('https://storage.example/tus/1')
    expect(stored.tus_created_at).toBe(FIXED_CREATED_AT)
    expect(stored.lease_owner).toBe('worker-1')
    expect(stored.lease_generation).toBe(4)
    expect(stored.lease_expires_at).toBe(FIXED_CREATED_AT + 1000)
    expect(stored.retry_phase).toBe('upload')
    expect(stored.remote_reconciliation_status).toBe('pending')
    expect(stored.remote_cleanup_attempt_count).toBe(2)
    expect(stored.remote_cleanup_last_error).toEqual({ code: 'CLEANUP', message: 'later' })
    expect(stored.db_row_id).toBe('row-99')
    expect(stored.remote_public_url).toBe('https://cdn.example/photo.jpg')
    expect(stored.metadata_payload).toEqual({ camera: 'rear' })
  })

  test('clearDoneBlob nulls Blob, writes supplied updated_at, and preserves other fields', async () => {
    const record = makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DONE,
      completed_at: FIXED_UPDATED_AT,
      db_row_id: 'row-1',
      remote_public_url: 'https://cdn.example/done.jpg',
    })
    await db.putRecord(record)
    await db.clearDoneBlob({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      updatedAt: FIXED_UPDATED_AT + 50,
    })
    const stored = await db.getRecord({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.blob).toBeNull()
    expect(stored.updated_at).toBe(FIXED_UPDATED_AT + 50)
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.DONE)
    expect(stored.db_row_id).toBe('row-1')
    expect(stored.remote_public_url).toBe('https://cdn.example/done.jpg')
    expect(stored.file_name).toBe('evidence.jpg')
  })

  test('rejects non-DONE Blob cleanup and leaves the record unchanged', async () => {
    const record = makeRecord({ status: PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE })
    await db.putRecord(record)
    await expect(db.clearDoneBlob({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      updatedAt: FIXED_UPDATED_AT + 50,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.BLOB_CLEANUP_FORBIDDEN,
    })
    const stored = await db.getRecord({
      queueId: record.queue_id,
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.blob).toBeInstanceOf(Blob)
    expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
    expect(stored.updated_at).toBe(FIXED_UPDATED_AT)
  })

  test('deleteLocalRecord removes only the actor-owned queue record', async () => {
    await db.putRecord(makeRecord({ queue_id: 'q-office-a' }))
    await db.deleteLocalRecord({
      queueId: 'q-office-a',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(await db.getRecord({
      queueId: 'q-office-a',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })).toBeNull()
  })

  test('wrong actor cannot delete another actor record', async () => {
    await db.putRecord(makeRecord({ queue_id: 'q-office-a' }))
    await expect(db.deleteLocalRecord({
      queueId: 'q-office-a',
      actorScopeType: 'office_user',
      actorScopeId: 'office-b',
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.ACTOR_SCOPE_CONFLICT,
    })
    expect(await db.getRecord({
      queueId: 'q-office-a',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })).not.toBeNull()
  })

  test('invalid replacement does not mutate an existing valid record', async () => {
    const original = makeRecord({ queue_id: 'q-keep' })
    await db.putRecord(original)
    await expect(db.putRecord(makeRecord({
      queue_id: 'q-keep',
      status: 'BAD',
    }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
    const stored = await db.getRecord({
      queueId: 'q-keep',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
    expect(stored.file_name).toBe('evidence.jpg')
    expect(await readBlobBytes(stored.blob)).toEqual(SOURCE_BYTES)
  })

  test('propagates QuotaExceededError-class failure instead of converting it to success', async () => {
    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    const failingDb = createPhotoUploadDb({
      dbName,
      openDB: async () => ({
        transaction() {
          return {
            objectStore() {
              return {
                get: async () => undefined,
                put: async () => {
                  throw quota
                },
              }
            },
            done: Promise.resolve(),
          }
        },
        close() {},
      }),
    })
    await db.close()
    db = failingDb
    await expect(failingDb.putRecord(makeRecord())).rejects.toMatchObject({
      name: 'QuotaExceededError',
      code: PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR,
    })
  })

  test('listRecordsForActorByStatus uses the actor-status index', async () => {
    await db.putRecord(makeRecord({
      queue_id: 'q-queued',
      status: PHOTO_UPLOAD_STATUSES.QUEUED,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-uploading',
      status: PHOTO_UPLOAD_STATUSES.UPLOADING,
      storage_path: 'job-1/delivery_q-uploading.jpg',
    }))
    await db.putRecord(makeRecord({
      queue_id: 'q-other-actor',
      actor_scope_id: 'office-b',
      status: PHOTO_UPLOAD_STATUSES.QUEUED,
      storage_path: 'job-1/delivery_q-other-actor.jpg',
    }))
    const queued = await db.listRecordsForActorByStatus({
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
      status: PHOTO_UPLOAD_STATUSES.QUEUED,
    })
    expect(queued.map((row) => row.queue_id)).toEqual(['q-queued'])
  })

  test('openDB failure is rejected as DATABASE_ERROR', async () => {
    const failingDb = createPhotoUploadDb({
      dbName,
      openDB: async () => {
        throw new Error('open failed')
      },
    })
    await db.close()
    db = failingDb
    await expect(failingDb.putRecord(makeRecord())).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR,
    })
  })

  test('rejects retained Blob when blob.size does not equal file_size', async () => {
    await expect(db.putRecord(makeRecord({ file_size: 99, bytes_total: 99 }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
  })

  test('rejects retained Blob when blob.type does not equal mime_type', async () => {
    await expect(db.putRecord(makeRecord({ mime_type: 'image/png' }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
  })

  test('sensitive metadata rejection leaves no record for that queue_id', async () => {
    await expect(db.putRecord(makeRecord({
      queue_id: 'q-secret',
      metadata_payload: { access_token: 'nope' },
    }))).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD,
    })
    expect(await db.getRecord({
      queueId: 'q-secret',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })).toBeNull()
  })

  test('PhotoUploadDbError remains identifiable for INVALID_RECORD', async () => {
    await expect(db.putRecord(makeRecord({ queue_id: '' }))).rejects.toBeInstanceOf(PhotoUploadDbError)
  })
})

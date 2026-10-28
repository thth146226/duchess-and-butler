/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

const fs = require('fs')
const path = require('path')

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_DB_VERSION,
  PHOTO_UPLOAD_PAYLOAD_STORE,
  PHOTO_UPLOAD_QUEUE_STORE,
  createPhotoUploadDb,
} from './photoUploadDb'
import {
  RAW_V1_OPEN_PROHIBITED,
  createPhotoUploadRecoveryDb,
  prohibitRawVersionRequest,
} from './photoUploadCompatibleRecovery'

const SOURCE_BYTES = [1, 2, 3, 4, 5, 250, 251, 252]
const ACTOR = {
  actorScopeType: 'office_user',
  actorScopeId: 'office-recovery',
}

function jpegBlob(bytes = SOURCE_BYTES) {
  return new Blob([Uint8Array.from(bytes)], { type: 'image/jpeg' })
}

function makeRecord(overrides = {}) {
  const blob = Object.prototype.hasOwnProperty.call(overrides, 'blob') ? overrides.blob : jpegBlob()
  const fileSize = blob instanceof Blob ? blob.size : SOURCE_BYTES.length
  return {
    schema_version: 1,
    queue_id: 'queue-recovery-1',
    blob,
    file_name: 'evidence.jpg',
    mime_type: 'image/jpeg',
    file_size: fileSize,
    source_surface: 'evidence_upload',
    entity_type: 'job',
    entity_id: 'job-recovery',
    provisional_id: null,
    actor_scope_type: ACTOR.actorScopeType,
    actor_scope_id: ACTOR.actorScopeId,
    run_type: 'delivery',
    storage_path: 'job-recovery/evidence.jpg',
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
    bytes_total: fileSize,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: { synthetic: true },
    lease_owner: 'tab-original',
    lease_generation: 3,
    lease_expires_at: 1_900_000_100_000,
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

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked'))
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
    request.onblocked = () => reject(new Error('open blocked'))
  })
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('transaction error'))
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
  })
}

async function seedV1(name, record) {
  const raw = await openVersion(name, 1, (database) => {
    if (database.objectStoreNames.contains(PHOTO_UPLOAD_QUEUE_STORE)) {
      return
    }
    const store = database.createObjectStore(PHOTO_UPLOAD_QUEUE_STORE, { keyPath: 'queue_id' })
    store.createIndex('by_actor', ['actor_scope_type', 'actor_scope_id'])
    store.createIndex('by_actor_status', ['actor_scope_type', 'actor_scope_id', 'status'])
  })
  const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
  tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).put(record)
  await txComplete(tx)
  raw.close()
}

async function readRaw(name, version) {
  const raw = await openVersion(name, version)
  try {
    const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readonly')
    const row = await new Promise((resolve, reject) => {
      const request = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).get('queue-recovery-1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await txComplete(tx)
    let payloadCount = null
    if (raw.objectStoreNames.contains(PHOTO_UPLOAD_PAYLOAD_STORE)) {
      const payloadTx = raw.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readonly')
      payloadCount = await new Promise((resolve, reject) => {
        const request = payloadTx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await txComplete(payloadTx)
    }
    return {
      version: raw.version,
      stores: Array.from(raw.objectStoreNames),
      row,
      payloadCount,
    }
  } finally {
    raw.close()
  }
}

async function inlineBytes(row) {
  if (!row || !(row.blob instanceof Blob)) {
    return null
  }
  return Array.from(new Uint8Array(await row.blob.arrayBuffer()))
}

describe('photo upload compatible recovery', () => {
  let sequence = 0
  let dbName

  beforeEach(() => {
    sequence += 1
    dbName = `duchess-photo-upload-recovery-${sequence}`
  })

  afterEach(async () => {
    await deleteDatabase(dbName)
  })

  test('opening an upgraded database at version 1 throws VersionError and keeps the bytes', async () => {
    const record = makeRecord()
    await seedV1(dbName, record)
    const before = await readRaw(dbName, 1)
    expect(before.version).toBe(1)
    expect(await inlineBytes(before.row)).toEqual(SOURCE_BYTES)

    const upgraded = createPhotoUploadDb({ dbName })
    await upgraded.listRecordsForActor(ACTOR)
    await upgraded.close()

    const afterUpgrade = await readRaw(dbName, PHOTO_UPLOAD_DB_VERSION)
    expect(afterUpgrade.version).toBe(2)
    expect(afterUpgrade.stores).toContain(PHOTO_UPLOAD_PAYLOAD_STORE)
    expect(await inlineBytes(afterUpgrade.row)).toEqual(SOURCE_BYTES)

    await expect(openVersion(dbName, 1)).rejects.toMatchObject({ name: 'VersionError' })

    const preserved = await readRaw(dbName, PHOTO_UPLOAD_DB_VERSION)
    expect(await inlineBytes(preserved.row)).toEqual(SOURCE_BYTES)
    expect(preserved.row.lease_owner).toBe('tab-original')
    expect(preserved.payloadCount).toBe(0)
  })

  test('an unupgraded V1 database is readable and stays at version 1', async () => {
    await seedV1(dbName, makeRecord())
    const recovery = createPhotoUploadRecoveryDb({ dbName })
    const first = await recovery.readActorRecords(ACTOR)
    expect(first.version).toBe(1)
    expect(first.stores).not.toContain(PHOTO_UPLOAD_PAYLOAD_STORE)
    expect(first.records).toHaveLength(1)
    expect(Array.from(first.records[0].inlineBytes)).toEqual(SOURCE_BYTES)
    expect(first.records[0].payloadBytes).toBeNull()
    expect(first.records[0].storage).toBe('v1-inline')
    expect(first.records[0].leaseOwner).toBe('tab-original')
    expect(recovery.uploadsEnabled).toBe(false)
    expect(recovery.claimLease).toBeUndefined()
    expect(recovery.putRecord).toBeUndefined()
    expect(recovery.migrateNextLegacyRecord).toBeUndefined()
    await recovery.close()

    const reopened = createPhotoUploadRecoveryDb({ dbName })
    const second = await reopened.readActorRecords(ACTOR)
    expect(second.version).toBe(1)
    expect(Array.from(second.records[0].inlineBytes)).toEqual(SOURCE_BYTES)
    await reopened.close()
  })

  test('a V2 separated payload is readable and is not rewritten', async () => {
    const current = createPhotoUploadDb({ dbName })
    await current.putRecord(makeRecord())
    await current.close()
    const recovery = createPhotoUploadRecoveryDb({ dbName })
    const snapshot = await recovery.readActorRecords(ACTOR)
    expect(snapshot.version).toBe(2)
    expect(snapshot.stores).toContain(PHOTO_UPLOAD_PAYLOAD_STORE)
    expect(snapshot.records[0].storage).toBe('v2-payload')
    expect(snapshot.records[0].inlineBytes).toBeNull()
    expect(Array.from(snapshot.records[0].payloadBytes)).toEqual(SOURCE_BYTES)
    expect(snapshot.records[0].leaseGeneration).toBe(3)
    await recovery.close()

    const raw = await readRaw(dbName, 2)
    expect(raw.row.blob).toBeUndefined()
    expect(raw.payloadCount).toBe(1)
    expect(raw.row.lease_owner).toBe('tab-original')
  })

  test('a V2 database still holding an inline V1 record keeps those bytes', async () => {
    await seedV1(dbName, makeRecord())
    const current = createPhotoUploadDb({ dbName })
    await current.listRecordsForActor(ACTOR)
    await current.close()
    const recovery = createPhotoUploadRecoveryDb({ dbName })
    const snapshot = await recovery.readActorRecords(ACTOR)
    expect(snapshot.version).toBe(2)
    expect(snapshot.records[0].storage).toBe('v2-unmigrated-inline')
    expect(Array.from(snapshot.records[0].inlineBytes)).toEqual(SOURCE_BYTES)
    expect(snapshot.records[0].payloadBytes).toBeNull()
    await recovery.close()
    const raw = await readRaw(dbName, 2)
    expect(await inlineBytes(raw.row)).toEqual(SOURCE_BYTES)
    expect(raw.payloadCount).toBe(0)
  })

  test('a failed migration leaves both copies and recovery deletes neither', async () => {
    await seedV1(dbName, makeRecord())
    const current = createPhotoUploadDb({
      dbName,
      afterLegacyPayloadCommit() {
        throw new Error('migration interrupted')
      },
    })
    const result = await current.migrateNextLegacyRecord()
    expect(result).toMatchObject({ migrated: false, deferred: true, queueId: 'queue-recovery-1' })
    await current.close()

    const recovery = createPhotoUploadRecoveryDb({ dbName })
    const snapshot = await recovery.readActorRecords(ACTOR)
    expect(snapshot.records[0].storage).toBe('v2-unmigrated-with-copy')
    expect(Array.from(snapshot.records[0].inlineBytes)).toEqual(SOURCE_BYTES)
    expect(Array.from(snapshot.records[0].payloadBytes)).toEqual(SOURCE_BYTES)
    await recovery.close()

    const reopened = createPhotoUploadRecoveryDb({ dbName })
    const again = await reopened.readActorRecords(ACTOR)
    expect(Array.from(again.records[0].inlineBytes)).toEqual(SOURCE_BYTES)
    expect(Array.from(again.records[0].payloadBytes)).toEqual(SOURCE_BYTES)
    await reopened.close()

    const raw = await readRaw(dbName, 2)
    expect(await inlineBytes(raw.row)).toEqual(SOURCE_BYTES)
    expect(raw.payloadCount).toBe(1)
    expect(raw.row.lease_owner).toBe('tab-original')
  })

  test('recovery refuses a raw V1 version request and two readers do not take a lease', async () => {
    await seedV1(dbName, makeRecord())
    const current = createPhotoUploadDb({ dbName })
    await current.listRecordsForActor(ACTOR)
    await current.close()

    expect(() => prohibitRawVersionRequest(2, 1)).toThrow(RAW_V1_OPEN_PROHIBITED)
    expect(() => createPhotoUploadRecoveryDb({ dbName, requestedVersion: 1 })).toThrow(RAW_V1_OPEN_PROHIBITED)

    const left = createPhotoUploadRecoveryDb({ dbName })
    const right = createPhotoUploadRecoveryDb({ dbName })
    const [first, second] = await Promise.all([
      left.readActorRecords(ACTOR),
      right.readActorRecords(ACTOR),
    ])
    expect(Array.from(first.records[0].inlineBytes)).toEqual(SOURCE_BYTES)
    expect(Array.from(second.records[0].inlineBytes)).toEqual(SOURCE_BYTES)
    expect(first.records[0].leaseOwner).toBe('tab-original')
    expect(second.records[0].leaseOwner).toBe('tab-original')
    await left.close()
    await right.close()

    const raw = await readRaw(dbName, 2)
    expect(raw.version).toBe(2)
    expect(raw.row.lease_owner).toBe('tab-original')
    expect(raw.row.lease_generation).toBe(3)
  })

  test('the recovery artifact does not reference local harnesses or the TUS engine', () => {
    const recovery = fs.readFileSync(path.join(__dirname, 'photoUploadCompatibleRecovery.js'), 'utf8')
    const entry = fs.readFileSync(path.join(__dirname, '../photoUploadRecoveryEntry.js'), 'utf8')
    for (const source of [recovery, entry]) {
      expect(source).not.toContain('tus-local')
      expect(source).not.toContain('tusLocalSafari')
      expect(source).not.toContain('safariS12')
      expect(source).not.toContain('setupProxy')
      expect(source).not.toContain('photoUploadTransport')
      expect(source).not.toContain('tus-js-client')
    }
    expect(entry).toContain('uploadsEnabled')
    expect(recovery).toContain('uploadsEnabled: false')
    expect(recovery).not.toContain('indexedDB.open(name,')
  })
})

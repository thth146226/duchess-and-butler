/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
const fs = require('fs')
const path = require('path')

require('fake-indexeddb/auto')

const rawOpen = indexedDB.open.bind(indexedDB)

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_DB_VERSION,
  PHOTO_UPLOAD_GLOBAL_DB_VERSION_LIMITATION,
  PHOTO_UPLOAD_PAYLOAD_STORE,
  PHOTO_UPLOAD_QUEUE_STORE,
  createPhotoUploadDb,
} from './photoUploadDb'
import { createPhotoUploadRecoveryDb } from './photoUploadCompatibleRecovery'
import {
  getPhotoUploadActivation,
  grantPhotoUploadActivationForTests,
  installPhotoUploadIndexedDbGuard,
  refreshPhotoUploadActivation,
  resetPhotoUploadActivationForTests,
  revokePhotoUploadActivation,
} from './photoUploadActivation'
import {
  evaluatePhotoUploadActivation,
  loadPhotoUploadPilotAllowlist,
  loadPhotoUploadRecoveryContingency,
  selectPhotoUploadIdentity,
} from './photoUploadActivationDecision'

const REAL_NAME = 'duchess-photo-upload-v1'
const SHARED_NAME = 'duchess-s18-two-actors'
const DRIVER_A = { actorScopeType: 'driver_portal', actorScopeId: 'driver-a' }
const DRIVER_B = { actorScopeType: 'driver_portal', actorScopeId: 'driver-b' }
const OFFICE = { actorScopeType: 'office_user', actorScopeId: 'office-1' }
const DRIVER_ALLOWLIST = Object.freeze([DRIVER_A])
const OFFICE_ALLOWLIST = Object.freeze([OFFICE])

let productionOpens = 0
let guardedOpen = null
const fetchCalls = []

function jpeg(bytes) {
  return new Blob([Uint8Array.from(bytes)], { type: 'image/jpeg' })
}

function makeRecord(actor, queueId, bytes) {
  const blob = jpeg(bytes)
  return {
    schema_version: 1,
    queue_id: queueId,
    blob,
    file_name: `${queueId}.jpg`,
    mime_type: 'image/jpeg',
    file_size: blob.size,
    source_surface: 'evidence_upload',
    entity_type: 'job',
    entity_id: 'job-synthetic',
    provisional_id: null,
    actor_scope_type: actor.actorScopeType,
    actor_scope_id: actor.actorScopeId,
    run_type: 'delivery',
    storage_path: `job-synthetic/${queueId}.jpg`,
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
    bytes_total: blob.size,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: { synthetic: true },
    lease_owner: null,
    lease_generation: 0,
    lease_expires_at: null,
    remote_reconciliation_status: null,
    remote_cleanup_attempt_count: 0,
    remote_cleanup_last_error: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_500,
    completed_at: null,
  }
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

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function bytesOf(blob) {
  if (!(blob instanceof Blob)) {
    return null
  }
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

function seedProductionV2() {
  return new Promise((resolve, reject) => {
    const request = rawOpen(REAL_NAME, PHOTO_UPLOAD_DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PHOTO_UPLOAD_QUEUE_STORE)) {
        database.createObjectStore(PHOTO_UPLOAD_QUEUE_STORE, { keyPath: 'queue_id' })
      }
      if (!database.objectStoreNames.contains(PHOTO_UPLOAD_PAYLOAD_STORE)) {
        database.createObjectStore(PHOTO_UPLOAD_PAYLOAD_STORE, { keyPath: 'payload_id' })
      }
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error || new Error('seed failed'))
  })
}

async function seedV1(name, records) {
  const raw = await openVersion(name, 1, (database) => {
    if (!database.objectStoreNames.contains(PHOTO_UPLOAD_QUEUE_STORE)) {
      const store = database.createObjectStore(PHOTO_UPLOAD_QUEUE_STORE, { keyPath: 'queue_id' })
      store.createIndex('by_actor', ['actor_scope_type', 'actor_scope_id'])
      store.createIndex('by_actor_status', ['actor_scope_type', 'actor_scope_id', 'status'])
    }
  })
  const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
  const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
  records.forEach((record) => store.put(record))
  await txComplete(tx)
  raw.close()
}

async function readShared(name) {
  const raw = await openVersion(name, PHOTO_UPLOAD_DB_VERSION)
  try {
    const tx = raw.transaction([PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE], 'readonly')
    const queue = await requestResult(tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).getAll())
    const payloads = await requestResult(tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).getAll())
    await txComplete(tx)
    return { version: raw.version, queue, payloads }
  } finally {
    raw.close()
  }
}

function countOpen(name, version) {
  const request = arguments.length < 2 ? guardedOpen(name) : guardedOpen(name, version)
  if (name === REAL_NAME) {
    productionOpens += 1
  }
  return request
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function uploadBody(actor, expiresAt = Date.now() + 60_000) {
  return {
    state: 'AUTHORIZED',
    purpose: 'upload',
    uploadsEnabled: true,
    actorScopeType: actor.actorScopeType,
    actorScopeId: actor.actorScopeId,
    expiresAt,
  }
}

describe('photo upload actor scope', () => {
  beforeEach(() => {
    productionOpens = 0
    fetchCalls.length = 0
    resetPhotoUploadActivationForTests()
    installPhotoUploadIndexedDbGuard()
    guardedOpen = indexedDB.open.bind(indexedDB)
    indexedDB.open = function openCounted(name, version) {
      if (arguments.length < 2) {
        return countOpen(name)
      }
      return countOpen(name, version)
    }
    global.fetch = async (url) => {
      fetchCalls.push(String(url))
      throw new Error('UNEXPECTED_FETCH')
    }
  })

  afterEach(async () => {
    indexedDB.open = guardedOpen
    resetPhotoUploadActivationForTests()
    await deleteDatabase(REAL_NAME)
    await deleteDatabase(SHARED_NAME)
    expect(fetchCalls.join(' ')).not.toMatch(/upload\/resumable|supabase\.co/)
  })

  test('one server pilot is configured outside the client and identities do not cross', () => {
    expect(loadPhotoUploadPilotAllowlist({})).toEqual([])
    expect(loadPhotoUploadPilotAllowlist({ PHOTO_UPLOAD_PILOT_ACTOR: 'not-an-actor' })).toEqual([])
    expect(loadPhotoUploadPilotAllowlist({
      PHOTO_UPLOAD_PILOT_ACTOR: 'driver_portal:driver-a office_user:office-1',
    })).toEqual([])
    expect(loadPhotoUploadPilotAllowlist({ PHOTO_UPLOAD_PILOT_ACTOR: 'driver_portal:driver-a' })).toEqual([DRIVER_A])
    expect(loadPhotoUploadRecoveryContingency({})).toBe(false)
    expect(loadPhotoUploadRecoveryContingency({ PHOTO_UPLOAD_RECOVERY_CONTINGENCY: '1' })).toBe(true)

    expect(selectPhotoUploadIdentity({ officeUserId: 'office-1', driverId: 'driver-a' })).toEqual(OFFICE)
    expect(selectPhotoUploadIdentity({ driverId: 'driver-a' })).toEqual(DRIVER_A)
    expect(selectPhotoUploadIdentity({})).toBeNull()

    expect(evaluatePhotoUploadActivation(DRIVER_A, { allowlist: DRIVER_ALLOWLIST, now: () => 1000 }).state).toBe('AUTHORIZED')
    expect(evaluatePhotoUploadActivation(DRIVER_B, { allowlist: DRIVER_ALLOWLIST, now: () => 1000 })).toEqual({
      state: 'DENIED',
      purpose: 'upload',
    })
    expect(evaluatePhotoUploadActivation(OFFICE, { allowlist: DRIVER_ALLOWLIST, now: () => 1000 }).state).toBe('DENIED')
    expect(evaluatePhotoUploadActivation(OFFICE, { allowlist: OFFICE_ALLOWLIST, now: () => 1000 }).state).toBe('AUTHORIZED')
    expect(evaluatePhotoUploadActivation(DRIVER_A, { allowlist: OFFICE_ALLOWLIST, now: () => 1000 }).state).toBe('DENIED')
    expect(evaluatePhotoUploadActivation(DRIVER_A, { allowlist: [], now: () => 1000 }).state).toBe('DENIED')
    expect(evaluatePhotoUploadActivation(OFFICE, { allowlist: [], now: () => 1000 }).state).toBe('DENIED')

    const activationSource = fs.readFileSync(path.join(__dirname, 'photoUploadActivation.js'), 'utf8')
    const driverSource = fs.readFileSync(path.join(__dirname, '../components/DriverPhotoUploadRuntime.js'), 'utf8')
    const apiSource = fs.readFileSync(path.join(__dirname, '../../api/photo-upload-activation.js'), 'utf8')
    expect(activationSource).not.toContain('PHOTO_UPLOAD_PILOT_ACTOR')
    expect(driverSource).toContain('portalToken')
    expect(driverSource).not.toContain('resolveDriverSupabaseBearer')
    expect(apiSource).toContain('resolveDriverByToken')
    expect(apiSource).toContain('getUser')
    expect(apiSource).not.toMatch(/body\.driverId|body\.actorScopeId/)
  })

  test('an unauthorized driver cannot open the production database', async () => {
    grantPhotoUploadActivationForTests(DRIVER_A)
    await expect(createPhotoUploadDb({ ...DRIVER_B }).putRecord(makeRecord(DRIVER_B, 'queue-b', [4, 5, 6]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    resetPhotoUploadActivationForTests()
    await expect(createPhotoUploadDb({ ...DRIVER_A }).putRecord(makeRecord(DRIVER_A, 'queue-a', [9, 9]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    await expect(createPhotoUploadDb({ ...OFFICE }).putRecord(makeRecord(OFFICE, 'queue-office', [1]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(0)
  })

  test('office authorization does not open a driver database and the reverse is refused', async () => {
    grantPhotoUploadActivationForTests(OFFICE)
    await expect(createPhotoUploadDb({ ...DRIVER_A }).putRecord(makeRecord(DRIVER_A, 'queue-driver', [2, 2]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(0)
    const officeDb = createPhotoUploadDb({ ...OFFICE })
    await officeDb.putRecord(makeRecord(OFFICE, 'queue-office', [3, 3]))
    expect(productionOpens).toBe(1)
    await officeDb.close()

    revokePhotoUploadActivation()
    grantPhotoUploadActivationForTests(DRIVER_A)
    await expect(createPhotoUploadDb({ ...OFFICE }).putRecord(makeRecord(OFFICE, 'queue-office-2', [4]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(1)
  })

  test('a stale or revoked authorization does not open the database', async () => {
    let resolveA
    const first = refreshPhotoUploadActivation({
      getAccessToken: async () => 'portal-a',
      fetcher: () => new Promise((resolve) => {
        resolveA = resolve
      }),
    })
    await settle()
    const second = refreshPhotoUploadActivation({
      getAccessToken: async () => 'portal-b',
      fetcher: async () => ({ state: 'DENIED', purpose: 'upload' }),
    })
    resolveA(uploadBody(DRIVER_A))
    await first
    await second
    expect(getPhotoUploadActivation().state).toBe('DENIED')
    await expect(createPhotoUploadDb({ ...DRIVER_A }).putRecord(makeRecord(DRIVER_A, 'queue-stale', [8]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')

    grantPhotoUploadActivationForTests(DRIVER_A)
    revokePhotoUploadActivation()
    await expect(createPhotoUploadDb({ ...DRIVER_A }).putRecord(makeRecord(DRIVER_A, 'queue-revoked', [8]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(0)
  })

  test('switching identity in the same browser closes the previous actor', async () => {
    const first = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'portal-a',
      fetcher: async () => uploadBody(DRIVER_A),
    })
    expect(first.grant.actorScopeId).toBe('driver-a')
    const dbA = createPhotoUploadDb({ ...DRIVER_A })
    await dbA.putRecord(makeRecord(DRIVER_A, 'queue-switch-a', [1, 1]))
    await dbA.close()
    const second = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'portal-b',
      fetcher: async () => ({ state: 'DENIED', purpose: 'upload' }),
    })
    expect(second.state).toBe('DENIED')
    await expect(createPhotoUploadDb({ ...DRIVER_A }).putRecord(makeRecord(DRIVER_A, 'queue-switch-b', [2]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(1)
  })

  test('payload promotion stays on the authorized actor and the shared database version is not isolation', async () => {
    const bytesA = [9, 9, 9]
    const bytesB = [4, 5, 6, 7]
    const recordB = makeRecord(DRIVER_B, 'queue-b', bytesB)
    await seedV1(SHARED_NAME, [recordB, makeRecord(DRIVER_A, 'queue-a', bytesA)])
    const dbA = createPhotoUploadDb({ dbName: SHARED_NAME, ...DRIVER_A })
    const migrated = await dbA.migrateNextLegacyRecord()
    expect(migrated).toEqual({ migrated: true, queueId: 'queue-a' })
    const again = await dbA.migrateNextLegacyRecord()
    expect(again.migrated).toBe(false)

    await expect(dbA.getRecord({
      queueId: 'queue-b',
      actorScopeType: DRIVER_B.actorScopeType,
      actorScopeId: DRIVER_B.actorScopeId,
    })).rejects.toThrow('outside the authorized actor')
    await expect(dbA.putRecord({
      ...recordB,
      actor_scope_type: DRIVER_A.actorScopeType,
      actor_scope_id: DRIVER_A.actorScopeId,
      blob: null,
    })).rejects.toThrow('different actor')
    await dbA.close()

    const shared = await readShared(SHARED_NAME)
    const rowA = shared.queue.find((row) => row.queue_id === 'queue-a')
    const rowB = shared.queue.find((row) => row.queue_id === 'queue-b')
    const payloadA = shared.payloads.find((row) => row.queue_id === 'queue-a')
    const payloadB = shared.payloads.find((row) => row.queue_id === 'queue-b')
    expect(await bytesOf(payloadA.blob)).toEqual(bytesA)
    expect(rowA.blob instanceof Blob).toBe(false)
    expect(await bytesOf(rowB.blob)).toEqual(bytesB)
    expect(payloadB).toBeUndefined()
    expect(shared.version).toBe(2)
    const completeIsolation = false
    expect(completeIsolation).toBe(false)
    expect(PHOTO_UPLOAD_GLOBAL_DB_VERSION_LIMITATION).toContain('not complete isolation')
    await expect(openVersion(SHARED_NAME, 1)).rejects.toMatchObject({ name: 'VersionError' })
    expect(productionOpens).toBe(0)
  })

  test('read-only recovery can open when the upload allowlist is empty and cannot upload', async () => {
    const recovery = evaluatePhotoUploadActivation(OFFICE, {
      allowlist: [],
      purpose: 'recovery',
      recoveryContingency: true,
      now: () => 1000,
    })
    expect(recovery).toMatchObject({
      state: 'AUTHORIZED',
      purpose: 'recovery',
      uploadsEnabled: false,
      actorScopeId: 'office-1',
    })
    expect(evaluatePhotoUploadActivation(DRIVER_A, {
      allowlist: [],
      purpose: 'recovery',
      recoveryContingency: true,
      now: () => 1000,
    }).state).toBe('DENIED')
    expect(evaluatePhotoUploadActivation(OFFICE, {
      allowlist: [],
      purpose: 'upload',
      recoveryContingency: true,
      now: () => 1000,
    }).state).toBe('DENIED')

    await seedProductionV2()
    grantPhotoUploadActivationForTests(OFFICE, Date.now() + 60_000, 'recovery')
    const readable = createPhotoUploadRecoveryDb()
    const snapshot = await readable.inspect()
    expect(snapshot.uploadsEnabled).toBe(false)
    expect(snapshot.version).toBe(PHOTO_UPLOAD_DB_VERSION)
    await readable.close()
    await expect(createPhotoUploadDb({ ...OFFICE }).putRecord(makeRecord(OFFICE, 'queue-upload', [1, 2]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    await expect(createPhotoUploadDb({ ...OFFICE }).migrateNextLegacyRecord()).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(1)

    grantPhotoUploadActivationForTests(OFFICE)
    await expect(createPhotoUploadRecoveryDb().inspect()).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(1)
  })

  test('a recovery response cannot become an upload grant', async () => {
    const decision = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'office-session',
      fetcher: async (_token, purpose) => {
        expect(purpose).toBe('upload')
        return {
          state: 'AUTHORIZED',
          purpose: 'recovery',
          uploadsEnabled: false,
          ...OFFICE,
          expiresAt: Date.now() + 60_000,
        }
      },
    })
    expect(decision.state).toBe('DENIED')
    await expect(createPhotoUploadDb({ ...OFFICE }).putRecord(makeRecord(OFFICE, 'queue-crossed', [1]))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(0)
  })
})

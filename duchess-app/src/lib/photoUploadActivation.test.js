/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
const fs = require('fs')
const path = require('path')

require('fake-indexeddb/auto')

const rawOpen = indexedDB.open.bind(indexedDB)

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_DB_NAME,
  PHOTO_UPLOAD_DB_VERSION,
  PHOTO_UPLOAD_PAYLOAD_STORE,
  PHOTO_UPLOAD_QUEUE_STORE,
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  createPhotoUploadDb,
} from './photoUploadDb'
import { createPhotoUploadRecoveryDb } from './photoUploadCompatibleRecovery'
import {
  PHOTO_UPLOAD_ACTIVATION,
  getPhotoUploadActivation,
  grantPhotoUploadActivationForTests,
  installPhotoUploadIndexedDbGuard,
  refreshPhotoUploadActivation,
  resetPhotoUploadActivationForTests,
  revokePhotoUploadActivation,
} from './photoUploadActivation'
import {
  PHOTO_UPLOAD_AUTHORIZED_ACTORS,
  evaluatePhotoUploadActivation,
} from './photoUploadActivationDecision'
import {
  acquirePhotoUploadRuntime,
  releasePhotoUploadRuntime,
  resetPhotoUploadRuntimeRegistryForTests,
} from './photoUploadRuntime'

const ACTOR_A = { actorScopeType: 'office_user', actorScopeId: 'actor-a' }
const ACTOR_B = { actorScopeType: 'office_user', actorScopeId: 'actor-b' }
const REAL_NAME = 'duchess-photo-upload-v1'

let productionOpens = 0
let guardedOpen = null
const fetchCalls = []

function jpeg() {
  return new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'image/jpeg' })
}

function recordFor(actor, queueId) {
  const now = 1_700_000_000_000
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: queueId,
    blob: jpeg(),
    file_name: 'evidence.jpg',
    mime_type: 'image/jpeg',
    file_size: 4,
    source_surface: 'office_evidence',
    entity_type: 'job',
    entity_id: 'job-1',
    provisional_id: null,
    actor_scope_type: actor.actorScopeType,
    actor_scope_id: actor.actorScopeId,
    run_type: 'delivery',
    storage_path: `job-1/delivery_${queueId}.jpg`,
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
    bytes_total: 4,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: null,
    lease_owner: null,
    lease_generation: 0,
    lease_expires_at: null,
    remote_reconciliation_status: null,
    remote_cleanup_attempt_count: 0,
    remote_cleanup_last_error: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
}

function authorizedBody(actor, expiresAt = Date.now() + 60_000) {
  return {
    state: 'AUTHORIZED',
    actorScopeType: actor.actorScopeType,
    actorScopeId: actor.actorScopeId,
    expiresAt,
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

function runtimeStubs(fetcher, actor) {
  return {
    actorScopeType: actor.actorScopeType,
    actorScopeId: actor.actorScopeId,
    getAccessToken: async () => `token-${actor.actorScopeId}`,
    activationFetcher: fetcher,
    windowTarget: null,
    documentTarget: null,
    createTransport() {
      return {
        startUpload() {
          throw new Error('UPLOAD_API_CALLED')
        },
      }
    },
    createReconciler() {
      return {
        async inspectRemoteObject() {
          throw new Error('UPLOAD_API_CALLED')
        },
        async reconcileEvidencePhotoRow() {
          throw new Error('UPLOAD_API_CALLED')
        },
      }
    },
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

function readStore(database, storeName) {
  return new Promise((resolve, reject) => {
    if (!database.objectStoreNames.contains(storeName)) {
      resolve([])
      return
    }
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

async function preservedBlobSize() {
  const database = await new Promise((resolve, reject) => {
    const request = rawOpen(REAL_NAME, PHOTO_UPLOAD_DB_VERSION)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const queue = await readStore(database, PHOTO_UPLOAD_QUEUE_STORE)
    const payloads = await readStore(database, PHOTO_UPLOAD_PAYLOAD_STORE)
    const blobs = [...queue, ...payloads].map((row) => row && row.blob).filter((blob) => blob instanceof Blob)
    return blobs.reduce((total, blob) => total + blob.size, 0)
  } finally {
    database.close()
  }
}

describe('photo upload selective activation', () => {
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
    await resetPhotoUploadRuntimeRegistryForTests()
    await deleteDatabase(REAL_NAME)
    await deleteDatabase('duchess-activation-synthetic')
    expect(fetchCalls.join(' ')).not.toMatch(/upload\/resumable|supabase\.co/)
  })

  test('starts disabled and the server allowlist is empty', () => {
    expect(PHOTO_UPLOAD_ACTIVATION).toBe('DISABLED')
    expect(getPhotoUploadActivation().state).toBe('DISABLED')
    expect(PHOTO_UPLOAD_AUTHORIZED_ACTORS).toEqual([])
    expect(Object.isFrozen(PHOTO_UPLOAD_AUTHORIZED_ACTORS)).toBe(true)
    expect(evaluatePhotoUploadActivation(ACTOR_A)).toEqual({ state: 'DENIED', purpose: 'upload' })
    expect(evaluatePhotoUploadActivation(ACTOR_A, {
      allowlist: [ACTOR_A],
      now: () => 1000,
    })).toEqual({
      state: 'AUTHORIZED',
      purpose: 'upload',
      uploadsEnabled: true,
      actorScopeType: 'office_user',
      actorScopeId: 'actor-a',
      expiresAt: 61_000,
    })
    const source = fs.readFileSync(path.join(__dirname, '../../api/photo-upload-activation.js'), 'utf8')
    expect(source).not.toMatch(/body\.actorScopeId|body\.driverId|req\.body\.actor/)
    expect(source).toMatch(/resolveDriverByToken/)
    expect(source).toMatch(/getUser/)
    expect(source).toMatch(/loadPhotoUploadPilotAllowlist/)
  })

  test('DISABLED, UNKNOWN, and DENIED do not open the production database', async () => {
    const deniedDb = createPhotoUploadDb({ ...ACTOR_A })
    await expect(deniedDb.putRecord(recordFor(ACTOR_A, 'disabled-row'))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    await expect(new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(REAL_NAME)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      } catch (error) {
        reject(error)
      }
    })).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    await expect(new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(REAL_NAME, 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      } catch (error) {
        reject(error)
      }
    })).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    const recovery = createPhotoUploadRecoveryDb()
    await expect(recovery.inspect()).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')

    const unknown = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'token-a',
      fetcher: async () => {
        throw new Error('offline')
      },
    })
    expect(unknown.state).toBe('UNKNOWN')
    await expect(createPhotoUploadDb({ ...ACTOR_A }).putRecord(recordFor(ACTOR_A, 'unknown-row'))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')

    const denied = await refreshPhotoUploadActivation({
      getAccessToken: async () => '',
      fetcher: async () => authorizedBody(ACTOR_A),
    })
    expect(denied.state).toBe('DENIED')
    const explicitDenial = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'token-a',
      fetcher: async () => ({ state: 'DENIED' }),
    })
    expect(explicitDenial.state).toBe('DENIED')
    expect(productionOpens).toBe(0)
  })

  test('an authorized actor can use the S1.2 database and another actor cannot', async () => {
    const decision = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'token-a',
      fetcher: async () => authorizedBody(ACTOR_A),
    })
    expect(decision.state).toBe('AUTHORIZED')
    const db = createPhotoUploadDb({ ...ACTOR_A })
    await db.putRecord(recordFor(ACTOR_A, 'authorized-row'))
    const stored = await db.getRecord({
      queueId: 'authorized-row',
      actorScopeType: ACTOR_A.actorScopeType,
      actorScopeId: ACTOR_A.actorScopeId,
    })
    expect(stored.queue_id).toBe('authorized-row')
    expect(productionOpens).toBe(1)
    await expect(createPhotoUploadDb({ ...ACTOR_B }).putRecord(recordFor(ACTOR_B, 'other-row'))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(1)
    const synthetic = createPhotoUploadDb({ dbName: 'duchess-activation-synthetic' })
    await synthetic.putRecord(recordFor(ACTOR_B, 'synthetic-row'))
    expect(productionOpens).toBe(1)
    await db.close()
    await synthetic.close()
  })

  test('revocation accepts no new write and keeps the existing blob', async () => {
    grantPhotoUploadActivationForTests(ACTOR_A)
    const db = createPhotoUploadDb({ ...ACTOR_A })
    await db.putRecord(recordFor(ACTOR_A, 'kept-row'))
    await db.close()
    revokePhotoUploadActivation()
    await expect(createPhotoUploadDb({ ...ACTOR_A }).putRecord(recordFor(ACTOR_A, 'new-row'))).rejects.toThrow('PHOTO_UPLOAD_ACTIVATION_BLOCKED')
    expect(productionOpens).toBe(1)
    expect(await preservedBlobSize()).toBeGreaterThan(0)
  })

  test('a stale authorization cannot enable a different actor', async () => {
    let resolveA
    let resolveB
    const runtimeA = acquirePhotoUploadRuntime(runtimeStubs(
      () => new Promise((resolve) => { resolveA = resolve }),
      ACTOR_A,
    ))
    await settle()
    const runtimeB = acquirePhotoUploadRuntime(runtimeStubs(
      () => new Promise((resolve) => { resolveB = resolve }),
      ACTOR_B,
    ))
    await settle()
    resolveA(authorizedBody(ACTOR_A))
    await runtimeA.ready
    expect(productionOpens).toBe(0)
    expect(getPhotoUploadActivation().state).not.toBe('AUTHORIZED')
    resolveB({ state: 'DENIED' })
    await runtimeB.ready
    expect(getPhotoUploadActivation().state).toBe('DENIED')
    expect(productionOpens).toBe(0)
    await releasePhotoUploadRuntime(ACTOR_A.actorScopeType, ACTOR_A.actorScopeId)
    await releasePhotoUploadRuntime(ACTOR_B.actorScopeType, ACTOR_B.actorScopeId)
  })

  test('logout and a delayed server failure do not open the production database', async () => {
    let authListener = null
    let resolveFetch = null
    const runtime = acquirePhotoUploadRuntime({
      ...runtimeStubs(() => new Promise((resolve) => { resolveFetch = resolve }), ACTOR_A),
      supabaseClient: {
        auth: {
          onAuthStateChange(listener) {
            authListener = listener
            return { data: { subscription: { unsubscribe() {} } } }
          },
          async getSession() {
            return { data: { session: { access_token: 'token-a', user: { id: ACTOR_A.actorScopeId } } } }
          },
        },
      },
    })
    await settle()
    expect(productionOpens).toBe(0)
    authListener('SIGNED_OUT', null)
    resolveFetch(authorizedBody(ACTOR_A))
    await runtime.ready
    expect(getPhotoUploadActivation().state).not.toBe('AUTHORIZED')
    expect(productionOpens).toBe(0)

    const failed = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'token-a',
      fetcher: async () => {
        throw new Error('timeout')
      },
    })
    expect(failed.state).toBe('UNKNOWN')
    const expired = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'token-a',
      now: () => 5_000,
      fetcher: async () => authorizedBody(ACTOR_A, 4_000),
    })
    expect(expired.state).toBe('DENIED')
    expect(productionOpens).toBe(0)
  })

  test('the default activation request sends only the bearer token', async () => {
    const previousFetch = global.fetch
    global.fetch = async (url, init) => {
      fetchCalls.push(String(url))
      expect(url).toBe('/api/photo-upload-activation')
      expect(init.method).toBe('POST')
      expect(init.body).toBeUndefined()
      expect(init.headers.Authorization).toBe('Bearer token-a')
      return {
        ok: false,
        async json() {
          return { state: 'AUTHORIZED', actorScopeType: 'office_user', actorScopeId: 'actor-a', expiresAt: Date.now() + 1000 }
        },
      }
    }
    const decision = await refreshPhotoUploadActivation({
      getAccessToken: async () => 'token-a',
    })
    global.fetch = previousFetch
    expect(decision.state).toBe('UNKNOWN')
    expect(productionOpens).toBe(0)
  })
})

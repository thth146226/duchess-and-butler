/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

const crypto = require('crypto')
const http = require('http')
const path = require('path')

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_ACTOR_SCOPE_TYPES,
  PHOTO_UPLOAD_DB_ERROR_CODES,
  PHOTO_UPLOAD_DB_NAME,
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  createPhotoUploadDb,
} from './photoUploadDb'
import { LEASE_TTL_MS, MAX_CONCURRENT_UPLOADS } from './photoUploadManager'
import {
  acquirePhotoUploadRuntime,
  releasePhotoUploadRuntime,
  resetPhotoUploadRuntimeRegistryForTests,
} from './photoUploadRuntime'
import { createPhotoUploadStore } from './photoUploadStore'
import { TUS_CHUNK_SIZE_BYTES, createPhotoUploadTransport } from './photoUploadTransport'
import tusLocalServer from './tusLocalServer'

const startTusLocalServer = tusLocalServer.startTusLocalServer || tusLocalServer.default.startTusLocalServer

const { Upload: BrowserUpload } = require(path.join(
  __dirname,
  '../../node_modules/tus-js-client/lib.es5/browser/index.js'
))

const ACTOR = 's12-tus-local-actor'
const TOKEN = 's12-tus-local-token'
const reports = []

function installNodeXhr() {
  class XMLHttpRequest {
    constructor() {
      this.readyState = 0
      this.status = 0
      this.responseText = ''
      this.upload = {}
      this._headers = {}
      this._settled = false
      this._req = null
    }

    open(method, url) {
      const parsed = new URL(url)
      if (parsed.hostname !== '127.0.0.1') {
        throw new Error('local tus transport refused a non-local host')
      }
      this._method = method
      this._url = parsed
      this.readyState = 1
    }

    setRequestHeader(name, value) {
      this._headers[name] = value
    }

    getResponseHeader(name) {
      if (!this._responseHeaders) {
        return null
      }
      const key = Object.keys(this._responseHeaders).find((item) => item.toLowerCase() === name.toLowerCase())
      const value = key ? this._responseHeaders[key] : null
      if (Array.isArray(value)) {
        return value.join(', ')
      }
      return value == null ? null : String(value)
    }

    abort() {
      if (this._settled) {
        return
      }
      this._settled = true
      if (this._req) {
        this._req.destroy()
      }
      if (typeof this.onerror === 'function') {
        this.onerror(new Error('aborted'))
      }
    }

    send(body) {
      const headers = { ...this._headers }
      const request = http.request({
        protocol: this._url.protocol,
        hostname: this._url.hostname,
        port: this._url.port,
        path: `${this._url.pathname}${this._url.search}`,
        method: this._method,
        headers,
      })
      this._req = request
      request.on('response', (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          if (this._settled) {
            return
          }
          this._settled = true
          this.status = res.statusCode
          this.responseText = Buffer.concat(chunks).toString('utf8')
          this._responseHeaders = res.headers
          this.readyState = 4
          if (typeof this.onload === 'function') {
            this.onload()
          }
        })
      })
      request.on('error', (error) => {
        if (this._settled) {
          return
        }
        this._settled = true
        if (typeof this.onerror === 'function') {
          this.onerror(error)
        }
      })
      if (body == null) {
        request.end()
        return
      }
      Promise.resolve()
        .then(() => body.arrayBuffer())
        .then((raw) => {
          const bytes = Buffer.from(raw)
          if (!headers['Content-Length'] && !headers['content-length']) {
            request.setHeader('Content-Length', bytes.length)
          }
          let offset = 0
          const write = () => {
            if (this._settled) {
              return
            }
            if (offset >= bytes.length) {
              request.end()
              return
            }
            const next = Math.min(offset + 65536, bytes.length)
            const accepted = request.write(bytes.subarray(offset, next))
            offset = next
            if (this.upload && typeof this.upload.onprogress === 'function') {
              this.upload.onprogress({ lengthComputable: true, loaded: offset, total: bytes.length })
            }
            if (!accepted) {
              request.once('drain', write)
              return
            }
            write()
          }
          write()
        })
        .catch((error) => {
          if (!this._settled && typeof this.onerror === 'function') {
            this._settled = true
            this.onerror(error)
          }
        })
    }
  }

  global.XMLHttpRequest = XMLHttpRequest
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function syntheticBytes(size, seed) {
  const bytes = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (seed + index * 17) & 255
  }
  return bytes
}

function makeRecord(queueId, bytes) {
  const now = 1_700_000_000_000
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: queueId,
    blob: new Blob([bytes], { type: 'application/octet-stream' }),
    file_name: `${queueId}.bin`,
    mime_type: 'application/octet-stream',
    file_size: bytes.length,
    source_surface: 's12_tus_local',
    entity_type: 'job',
    entity_id: 's12-tus-local-job',
    provisional_id: null,
    actor_scope_type: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
    actor_scope_id: ACTOR,
    run_type: 'delivery',
    storage_path: `s12-tus-local/${queueId}.bin`,
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
    bytes_total: bytes.length,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: { synthetic: true },
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

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('deleteDatabase failed'))
    request.onblocked = () => resolve()
  })
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  return false
}

function localTransport(endpoint) {
  function LocalUpload(file, options) {
    return new BrowserUpload(file, { ...options, endpoint })
  }
  return createPhotoUploadTransport({ UploadClass: LocalUpload })
}

function localReconciler(server) {
  return {
    async inspectRemoteObject({ storagePath, expectedSize }) {
      const file = server.bytesFor(storagePath)
      const actualSize = file ? file.length : 0
      if (!file || actualSize !== expectedSize) {
        return {
          kind: 'REMOTE_INCOMPLETE',
          storagePath,
          expectedSize,
          actualSize,
        }
      }
      return {
        kind: 'REMOTE_COMPLETE',
        storagePath,
        expectedSize,
        actualSize,
        proofSource: 'local_file_size',
        publicUrl: `${server.origin}/local/${encodeURIComponent(storagePath)}`,
      }
    },
    async reconcileEvidencePhotoRow({ storagePath }) {
      return { kind: 'DB_INSERT_SUCCEEDED', id: `local-${storagePath}` }
    },
  }
}

function runtimeOptions(server, dbName, leaseOwner) {
  return {
    actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
    actorScopeId: ACTOR,
    leaseOwner,
    createDb: () => createPhotoUploadDb({ dbName }),
    createTransport: () => localTransport(server.endpoint),
    createReconciler: () => localReconciler(server),
    getAccessToken: async () => TOKEN,
    isOnline: () => true,
  }
}

function storeOptions(server, db, leaseOwner) {
  return {
    db,
    transport: localTransport(server.endpoint),
    reconciler: localReconciler(server),
    actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
    actorScopeId: ACTOR,
    leaseOwner,
    getAccessToken: async () => TOKEN,
    isOnline: () => true,
  }
}

function publish(entry) {
  reports.push(entry)
  return entry
}

describe('S1.2 local tus', () => {
  jest.setTimeout(40000)

  beforeAll(() => {
    installNodeXhr()
  })

  afterEach(async () => {
    await resetPhotoUploadRuntimeRegistryForTests()
  })

  afterAll(() => {
    process.stdout.write(`\nTUS_LOCAL_REPORT ${JSON.stringify(reports)}\n`)
  })

  test('transfers a synthetic file and matches sha-256', async () => {
    const server = await startTusLocalServer()
    const dbName = 'duchess-photo-upload-s12-tus-local-complete'
    const bytes = syntheticBytes(48 * 1024, 3)
    const sourceHash = sha256(bytes)
    const db = createPhotoUploadDb({ dbName })
    try {
      expect(dbName).not.toBe(PHOTO_UPLOAD_DB_NAME)
      await db.putRecord(makeRecord('s12-tus-complete', bytes))
      const runtime = acquirePhotoUploadRuntime(runtimeOptions(server, dbName, 's12-owner-complete'))
      await runtime.ready
      const finished = await waitFor(async () => {
        const row = await db.getRecord({
          queueId: 's12-tus-complete',
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })
        return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
      }, 15000)
      const destination = server.bytesFor('s12-tus-local/s12-tus-complete.bin')
      const row = await db.getRecord({
        queueId: 's12-tus-complete',
        actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
        actorScopeId: ACTOR,
      })
      const snapshot = server.snapshot()
      publish({
        scenario: 'complete',
        bytes: bytes.length,
        sha256_source: sourceHash,
        sha256_destination: destination ? sha256(destination) : null,
        offset_final: server.offsetFor('s12-tus-local/s12-tus-complete.bin'),
        post_count: server.uploadCount('s12-tus-local/s12-tus-complete.bin'),
        operations: snapshot.operations,
        upload_attempt_count: row && row.upload_attempt_count,
        status: row && row.status,
      })
      expect(finished).toBe(true)
      expect(sha256(destination)).toBe(sourceHash)
      expect(destination.length).toBe(bytes.length)
      expect(server.uploadCount('s12-tus-local/s12-tus-complete.bin')).toBe(1)
      expect(row.upload_attempt_count).toBe(1)
      expect(String(row.remote_public_url).startsWith('http://127.0.0.1')).toBe(true)
      expect(JSON.stringify(snapshot.operations)).not.toContain('supabase.co')
    } finally {
      await resetPhotoUploadRuntimeRegistryForTests()
      await db.close()
      await server.close()
      await deleteDatabase(dbName)
    }
  })

  test('resumes from the tus offset after the connection is cut', async () => {
    const server = await startTusLocalServer()
    const dbName = 'duchess-photo-upload-s12-tus-local-cut'
    const bytes = syntheticBytes(TUS_CHUNK_SIZE_BYTES + 4096, 9)
    const sourceHash = sha256(bytes)
    const storagePath = 's12-tus-local/s12-tus-cut.bin'
    server.arm(storagePath, { cutAfterBytes: 128 })
    const db = createPhotoUploadDb({ dbName })
    try {
      await db.putRecord(makeRecord('s12-tus-cut', bytes))
      const runtime = acquirePhotoUploadRuntime(runtimeOptions(server, dbName, 's12-owner-cut'))
      await runtime.ready
      const finished = await waitFor(async () => {
        const row = await db.getRecord({
          queueId: 's12-tus-cut',
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })
        return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
      }, 20000)
      const destination = server.bytesFor(storagePath)
      const snapshot = server.snapshot()
      const resumed = snapshot.operations.find((item) => item.method === 'PATCH' && item.offset_in > TUS_CHUNK_SIZE_BYTES)
      publish({
        scenario: 'connection_cut',
        bytes: bytes.length,
        sha256_source: sourceHash,
        sha256_destination: destination ? sha256(destination) : null,
        offset_final: server.offsetFor(storagePath),
        resume_offset: resumed ? resumed.offset_in : null,
        post_count: server.uploadCount(storagePath),
        operations: snapshot.operations,
      })
      expect(finished).toBe(true)
      expect(sha256(destination)).toBe(sourceHash)
      expect(server.uploadCount(storagePath)).toBe(1)
      expect(snapshot.operations.some((item) => item.status === 'closed' && item.offset_out === TUS_CHUNK_SIZE_BYTES + 128)).toBe(true)
      expect(resumed).toBeTruthy()
      expect(destination.length).toBe(bytes.length)
    } finally {
      await resetPhotoUploadRuntimeRegistryForTests()
      await db.close()
      await server.close()
      await deleteDatabase(dbName)
    }
  })

  test('a new runtime resumes the same upload after the page runtime stops', async () => {
    const server = await startTusLocalServer()
    const dbName = 'duchess-photo-upload-s12-tus-local-return'
    const bytes = syntheticBytes(TUS_CHUNK_SIZE_BYTES + 4096, 11)
    const sourceHash = sha256(bytes)
    const storagePath = 's12-tus-local/s12-tus-return.bin'
    server.arm(storagePath, { holdAfterFirstChunk: true })
    const db = createPhotoUploadDb({ dbName })
    try {
      await db.putRecord(makeRecord('s12-tus-return', bytes))
      const first = acquirePhotoUploadRuntime(runtimeOptions(server, dbName, 's12-owner-return-1'))
      await first.ready
      const held = await waitFor(async () => {
        const row = await db.getRecord({
          queueId: 's12-tus-return',
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })
        return server.holding(storagePath) && row && typeof row.tus_upload_url === 'string'
      }, 15000)
      expect(held).toBe(true)
      expect(server.offsetFor(storagePath)).toBe(TUS_CHUNK_SIZE_BYTES)
      const interruptedUrl = (await db.getRecord({
        queueId: 's12-tus-return',
        actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
        actorScopeId: ACTOR,
      })).tus_upload_url
      await releasePhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER, ACTOR)
      await db.close()
      const released = await waitFor(() => !server.holding(storagePath), 5000)
      expect(released).toBe(true)
      expect(server.offsetFor(storagePath)).toBe(TUS_CHUNK_SIZE_BYTES)

      const secondDb = createPhotoUploadDb({ dbName })
      const second = acquirePhotoUploadRuntime(runtimeOptions(server, dbName, 's12-owner-return-2'))
      await second.ready
      const finished = await waitFor(async () => {
        const row = await secondDb.getRecord({
          queueId: 's12-tus-return',
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })
        return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
      }, 15000)
      const destination = server.bytesFor(storagePath)
      const snapshot = server.snapshot()
      publish({
        scenario: 'runtime_return',
        bytes: bytes.length,
        sha256_source: sourceHash,
        sha256_destination: destination ? sha256(destination) : null,
        interrupted_offset: TUS_CHUNK_SIZE_BYTES,
        offset_final: server.offsetFor(storagePath),
        post_count: server.uploadCount(storagePath),
        same_upload_url: snapshot.operations.filter((item) => item.method === 'POST').length === 1,
        operations: snapshot.operations,
      })
      expect(finished).toBe(true)
      expect(interruptedUrl.startsWith('http://127.0.0.1')).toBe(true)
      expect(server.uploadCount(storagePath)).toBe(1)
      expect(sha256(destination)).toBe(sourceHash)
      expect(snapshot.operations.some((item) => item.method === 'HEAD' && item.offset_out === TUS_CHUNK_SIZE_BYTES)).toBe(true)
      expect(snapshot.operations.some((item) => item.method === 'PATCH' && item.offset_in === TUS_CHUNK_SIZE_BYTES && item.status === 204)).toBe(true)
      await secondDb.close()
    } finally {
      await resetPhotoUploadRuntimeRegistryForTests()
      await server.close()
      await deleteDatabase(dbName)
    }
  })

  test('keeps the runtime through another screen acquire and renews the lease', async () => {
    const server = await startTusLocalServer()
    const dbName = 'duchess-photo-upload-s12-tus-local-lease'
    const bytes = syntheticBytes(24 * 1024, 5)
    const sourceHash = sha256(bytes)
    const storagePath = 's12-tus-local/s12-tus-lease.bin'
    server.arm(storagePath, { delayMs: 12000 })
    const db = createPhotoUploadDb({ dbName })
    try {
      await db.putRecord(makeRecord('s12-tus-lease', bytes))
      const first = acquirePhotoUploadRuntime(runtimeOptions(server, dbName, 's12-owner-lease'))
      const second = acquirePhotoUploadRuntime(runtimeOptions(server, dbName, 's12-owner-lease'))
      expect(second).toBe(first)
      await first.ready
      const uploading = await waitFor(async () => {
        const row = await db.getRecord({
          queueId: 's12-tus-lease',
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })
        return row && row.status === PHOTO_UPLOAD_STATUSES.UPLOADING && server.snapshot().active === 1
      }, 5000)
      expect(uploading).toBe(true)
      const before = await db.getRecord({
        queueId: 's12-tus-lease',
        actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
        actorScopeId: ACTOR,
      })
      await releasePhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER, ACTOR)
      expect(server.snapshot().active).toBe(1)
      await expect(db.claimLease({
        queueId: 's12-tus-lease',
        actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
        actorScopeId: ACTOR,
        leaseOwner: 's12-owner-other',
        now: Date.now(),
        leaseTtlMs: LEASE_TTL_MS,
      })).rejects.toMatchObject({ code: PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_NOT_AVAILABLE })
      let renewedExpiry = null
      const renewed = await waitFor(async () => {
        const row = await db.getRecord({
          queueId: 's12-tus-lease',
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })
        if (!row || !(row.lease_expires_at > before.lease_expires_at)) {
          return false
        }
        renewedExpiry = row.lease_expires_at
        return true
      }, 15000)
      const finished = await waitFor(async () => {
        const row = await db.getRecord({
          queueId: 's12-tus-lease',
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })
        return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
      }, 20000)
      const after = await db.getRecord({
        queueId: 's12-tus-lease',
        actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
        actorScopeId: ACTOR,
      })
      const destination = server.bytesFor(storagePath)
      publish({
        scenario: 'lease_and_navigation',
        bytes: bytes.length,
        sha256_source: sourceHash,
        sha256_destination: destination ? sha256(destination) : null,
        lease_expires_before: before.lease_expires_at,
        lease_expires_renewed: renewedExpiry,
        runtime_stayed_active: true,
        post_count: server.uploadCount(storagePath),
      })
      expect(renewed).toBe(true)
      expect(finished).toBe(true)
      expect(sha256(destination)).toBe(sourceHash)
      expect(renewedExpiry).toBeGreaterThan(before.lease_expires_at)
      expect(after.status).toBe(PHOTO_UPLOAD_STATUSES.DONE)
    } finally {
      await resetPhotoUploadRuntimeRegistryForTests()
      await db.close()
      await server.close()
      await deleteDatabase(dbName)
    }
  })

  test('runs at most two uploads at the same time', async () => {
    const server = await startTusLocalServer()
    const dbName = 'duchess-photo-upload-s12-tus-local-parallel'
    const db = createPhotoUploadDb({ dbName })
    const files = [1, 2, 3].map((seed) => {
      const bytes = syntheticBytes(16 * 1024, seed)
      return {
        id: `s12-tus-parallel-${seed}`,
        bytes,
        hash: sha256(bytes),
      }
    })
    try {
      for (const file of files) {
        const storagePath = `s12-tus-local/${file.id}.bin`
        server.arm(storagePath, { delayMs: 1500 })
        await db.putRecord(makeRecord(file.id, file.bytes))
      }
      const runtime = acquirePhotoUploadRuntime(runtimeOptions(server, dbName, 's12-owner-parallel'))
      await runtime.ready
      const finished = await waitFor(async () => {
        const rows = await Promise.all(files.map((file) => db.getRecord({
          queueId: file.id,
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })))
        return rows.every((row) => row && row.status === PHOTO_UPLOAD_STATUSES.DONE)
      }, 20000)
      const snapshot = server.snapshot()
      const hashes = {}
      files.forEach((file) => {
        const destination = server.bytesFor(`s12-tus-local/${file.id}.bin`)
        hashes[file.id] = {
          source: file.hash,
          destination: destination ? sha256(destination) : null,
          bytes: destination ? destination.length : 0,
        }
      })
      publish({
        scenario: 'concurrency',
        max_concurrent_observed: snapshot.max_concurrent,
        max_concurrent_limit: MAX_CONCURRENT_UPLOADS,
        hashes,
        operations: snapshot.operations,
      })
      expect(finished).toBe(true)
      expect(snapshot.max_concurrent).toBe(MAX_CONCURRENT_UPLOADS)
      files.forEach((file) => {
        expect(hashes[file.id].destination).toBe(file.hash)
        expect(hashes[file.id].bytes).toBe(file.bytes.length)
      })
    } finally {
      await resetPhotoUploadRuntimeRegistryForTests()
      await db.close()
      await server.close()
      await deleteDatabase(dbName)
    }
  })

  test('a second worker does not create another tus upload for the same record', async () => {
    const server = await startTusLocalServer()
    const dbName = 'duchess-photo-upload-s12-tus-local-dup'
    const bytes = syntheticBytes(12 * 1024, 7)
    const sourceHash = sha256(bytes)
    const storagePath = 's12-tus-local/s12-tus-dup.bin'
    server.arm(storagePath, { delayMs: 1200 })
    const db = createPhotoUploadDb({ dbName })
    const other = createPhotoUploadDb({ dbName })
    try {
      await db.putRecord(makeRecord('s12-tus-dup', bytes))
      const first = createPhotoUploadStore(storeOptions(server, db, 's12-owner-dup-a'))
      const pump = first.start()
      if (pump && typeof pump.then === 'function') {
        pump.then(() => {}, () => {})
      }
      const started = await waitFor(() => server.snapshot().active === 1, 5000)
      expect(started).toBe(true)
      const second = createPhotoUploadStore(storeOptions(server, other, 's12-owner-dup-b'))
      const secondPump = second.start()
      if (secondPump && typeof secondPump.then === 'function') {
        secondPump.then(() => {}, () => {})
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(server.uploadCount(storagePath)).toBe(1)
      const finished = await waitFor(async () => {
        const row = await db.getRecord({
          queueId: 's12-tus-dup',
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
          actorScopeId: ACTOR,
        })
        return row && row.status === PHOTO_UPLOAD_STATUSES.DONE
      }, 10000)
      const destination = server.bytesFor(storagePath)
      publish({
        scenario: 'no_duplicate',
        bytes: bytes.length,
        sha256_source: sourceHash,
        sha256_destination: destination ? sha256(destination) : null,
        post_count: server.uploadCount(storagePath),
        operations: server.snapshot().operations,
      })
      expect(finished).toBe(true)
      expect(server.uploadCount(storagePath)).toBe(1)
      expect(sha256(destination)).toBe(sourceHash)
      expect(destination.length).toBe(bytes.length)
      await first.stop()
      await second.stop()
    } finally {
      await db.close()
      await other.close()
      await server.close()
      await deleteDatabase(dbName)
    }
  })

  test('a forwarded LAN host is advertised instead of 127.0.0.1', async () => {
    const server = await startTusLocalServer()
    try {
      const location = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: new URL(server.origin).port,
          path: '/files',
          method: 'POST',
          headers: {
            'Upload-Length': '4',
            'Tus-Resumable': '1.0.0',
            'X-Forwarded-Host': '192.168.1.78:3000',
            'X-Forwarded-Proto': 'http',
            'X-Forwarded-Prefix': '/tus-local',
          },
        }, (res) => {
          res.resume()
          resolve(res.headers.location)
        })
        req.on('error', reject)
        req.end()
      })
      expect(location).toMatch(/^http:\/\/192\.168\.1\.78:3000\/tus-local\/files\/[a-f0-9]+$/)
      expect(location).not.toContain('127.0.0.1')
      expect(location).not.toContain('supabase.co')
    } finally {
      await server.close()
    }
  })
})

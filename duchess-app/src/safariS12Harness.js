import { useEffect, useMemo, useRef, useState } from 'react'
import { PHOTO_UPLOAD_STATUSES } from './lib/photoUploadDomain'
import {
  PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY,
  PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY,
} from './lib/photoUploadDiagnostics'
import { LEASE_TTL_MS, MAX_CONCURRENT_UPLOADS } from './lib/photoUploadManager'
import {
  PHOTO_UPLOAD_DB_NAME,
  PHOTO_UPLOAD_PAYLOAD_STORE,
  PHOTO_UPLOAD_QUEUE_STORE,
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  createPhotoUploadDb,
} from './lib/photoUploadDb'
import { createPhotoUploadStore } from './lib/photoUploadStore'
import {
  HARNESS_META_DB_NAME,
  SAFARI_S12_MIN_BACKGROUND_MS,
  classifyBackgroundCycle,
  closeStaleWorkers,
  combineScenarioNine,
  createVisibilityCycle,
  markDuplicateObserved,
  noteWorkerEnd,
  noteWorkerStart,
  readRecoverableCycle,
  readVisibilityCycle,
  recordHiddenTransition,
  recordVisibleReturn,
  saveArmedSnapshot,
} from './safariS12Recovery'
import {
  EXPECTED_INJECTED_FAULT,
  SAFARI_BLOB_PREPARATION_MESSAGE,
  blobOriginLabel,
  classifyScenario7,
} from './safariS12Scenario7'

const HARNESS_DB_NAME = 'duchess-photo-upload-s12-safari-harness'
const ACTOR_TYPE = 'office_user'
const ACTOR_ID = 's12-harness-actor'
const LEASE_OWNER = 's12-harness-tab'
const ARM_KEY = 'duchess-s12-safari-harness-arm'
const PAGE_TOKEN = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const BLOB_BYTES = (65536 * 2) + 32
const syntheticBlobs = new WeakSet()
const indexedDbBlobs = new WeakSet()
const IDS = Object.freeze({
  single: 's12-01-single',
  concurrent: 's12-02-concurrent',
  lease: 's12-03-lease',
  uploadA: 's12-04-upload-a',
  uploadB: 's12-05-upload-b',
  abort: 's12-06-abort',
  idb: 's12-07-idb',
  payload: 's12-08-payload',
})

const SCENARIOS = [
  { id: '1', mode: 'automatic', title: 'Criar registros V1 sintéticos com Blob inline' },
  { id: '2', mode: 'automatic', title: 'Migrar para V2 e comparar todos os bytes após reabrir' },
  { id: '3', mode: 'automatic', title: 'Duas instâncias migrando ao mesmo tempo' },
  { id: '4', mode: 'automatic', title: 'Lease, heartbeat, status e progresso sem regravar o Blob' },
  { id: '5', mode: 'automatic', title: 'Dois uploads simultâneos no transporte simulado' },
  { id: '6', mode: 'manual', title: 'Safari em segundo plano e retorno da fila' },
  { id: '7', mode: 'automatic', title: 'Abort, erro de IndexedDB e payload indisponível' },
  { id: '8', mode: 'automatic', title: 'Falha local não consome tentativa TUS' },
  { id: '9', mode: 'mixed', title: 'Sem perda de bytes e sem upload duplicado após o retorno' },
]

function assertHarnessDatabase(name) {
  if (name !== HARNESS_DB_NAME || name === PHOTO_UPLOAD_DB_NAME) {
    throw new Error('harness refused the real photo upload database')
  }
}

function installDatabaseTripwire() {
  const nativeOpen = indexedDB.open.bind(indexedDB)
  const nativeDelete = indexedDB.deleteDatabase.bind(indexedDB)
  indexedDB.open = function openHarnessDatabase(name, version) {
    if (name === PHOTO_UPLOAD_DB_NAME) {
      throw new Error('harness blocked the real photo upload database')
    }
    return nativeOpen(name, version)
  }
  indexedDB.deleteDatabase = function deleteHarnessDatabase(name) {
    const synthetic = name === HARNESS_DB_NAME || name === HARNESS_META_DB_NAME
    if (name === PHOTO_UPLOAD_DB_NAME || !synthetic) {
      throw new Error('harness blocked database deletion')
    }
    return nativeDelete(name)
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return true
    }
    await delay(30)
  }
  return Boolean(await predicate())
}

function hostOf(value) {
  try {
    const url = typeof value === 'string' ? value : (value && value.url) || ''
    return new URL(url, window.location.href).host
  } catch (_error) {
    return 'invalid-url'
  }
}

function installHarnessNetworkTripwire() {
  if (window.__safariS12BlockedNetwork) {
    return
  }
  const blocked = []
  window.__safariS12BlockedNetwork = blocked
  window.fetch = (input) => {
    blocked.push({ channel: 'fetch', host: hostOf(input) })
    return Promise.reject(new Error('HARNESS_NETWORK_BLOCKED'))
  }
  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    window.XMLHttpRequest.prototype.open = function blockedOpen() {
      blocked.push({ channel: 'xhr', host: 'xhr' })
      throw new Error('HARNESS_NETWORK_BLOCKED')
    }
  }
  if (window.WebSocket) {
    const NativeWebSocket = window.WebSocket
    const LocalWebSocket = function LocalWebSocket(url, protocols) {
      const host = hostOf(url)
      if (host !== window.location.host) {
        blocked.push({ channel: 'websocket', host })
        throw new Error('HARNESS_NETWORK_BLOCKED')
      }
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
    }
    LocalWebSocket.prototype = NativeWebSocket.prototype
    window.WebSocket = LocalWebSocket
  }
  if (navigator.sendBeacon) {
    navigator.sendBeacon = () => {
      blocked.push({ channel: 'beacon', host: window.location.host })
      return false
    }
  }
}

installHarnessNetworkTripwire()
installDatabaseTripwire()

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('idb request failed'))
  })
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve('complete')
    tx.onabort = () => reject(tx.error || new Error('transaction abort'))
    tx.onerror = () => reject(tx.error || new Error('transaction error'))
  })
}

function openCurrentDatabase() {
  assertHarnessDatabase(HARNESS_DB_NAME)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HARNESS_DB_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('open failed'))
    request.onblocked = () => reject(new Error('harness open blocked'))
  })
}

function deleteHarnessDatabase() {
  assertHarnessDatabase(HARNESS_DB_NAME)
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(HARNESS_DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('delete failed'))
    request.onblocked = () => reject(new Error('harness delete blocked'))
  })
}

async function seedLegacyRecords(records) {
  assertHarnessDatabase(HARNESS_DB_NAME)
  await deleteHarnessDatabase()
  const raw = await new Promise((resolve, reject) => {
    const request = indexedDB.open(HARNESS_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(PHOTO_UPLOAD_QUEUE_STORE, { keyPath: 'queue_id' })
      store.createIndex('by_actor', ['actor_scope_type', 'actor_scope_id'])
      store.createIndex('by_actor_status', ['actor_scope_type', 'actor_scope_id', 'status'])
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('seed open failed'))
    request.onblocked = () => reject(new Error('seed open blocked'))
  })
  const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
  const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
  records.forEach((record) => store.put(record))
  await transactionDone(tx)
  raw.close()
}

function syntheticBlob(mark) {
  const bytes = new Uint8Array(BLOB_BYTES)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index + mark) & 255
  }
  bytes[65536 + 8] = mark & 255
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  syntheticBlobs.add(blob)
  return blob
}

function rememberIndexedDbBlob(value) {
  if (value && value.blob instanceof Blob) {
    indexedDbBlobs.add(value.blob)
  }
}

function blobFields(value) {
  const blob = value && value.blob instanceof Blob ? value.blob : null
  return {
    blob_bytes: blob ? blob.size : 0,
    mime_type: blob ? blob.type : null,
    blob_origin: blobOriginLabel({
      hasBlob: Boolean(blob),
      synthetic: Boolean(blob && syntheticBlobs.has(blob)),
      fromIndexedDb: Boolean(blob && indexedDbBlobs.has(blob)),
    }),
  }
}

function emptyIdbSignals() {
  return {
    request_error: null,
    transaction_error: null,
    transaction_abort: false,
    caller_exception: null,
  }
}

function observeTransaction(tx, signals) {
  if (!tx || !signals) {
    return
  }
  tx.addEventListener('abort', () => {
    signals.transaction_abort = true
    signals.transaction_error = safeNative(tx.error)
  })
  tx.addEventListener('error', (event) => {
    const target = event.target
    if (target && target !== tx && target.error) {
      signals.request_error = safeNative(target.error)
    }
    if (!signals.transaction_error && tx.error) {
      signals.transaction_error = safeNative(tx.error)
    }
  })
}

function clearBackgroundArm() {
  try {
    window.sessionStorage.removeItem(ARM_KEY)
  } catch (_error) {
    return
  }
}

const MISSING_PAYLOAD_ID = 's12-07-missing-payload'

async function deleteKeyObserved(storeName, key) {
  const signals = emptyIdbSignals()
  const raw = await openCurrentDatabase()
  try {
    const tx = raw.transaction(storeName, 'readwrite')
    observeTransaction(tx, signals)
    let request = null
    try {
      request = tx.objectStore(storeName).delete(key)
    } catch (error) {
      signals.caller_exception = safeNative(error)
      return { ok: false, signals, transaction_status: 'caller_exception' }
    }
    request.addEventListener('error', () => {
      signals.request_error = safeNative(request.error)
    })
    const transactionStatus = await new Promise((resolve) => {
      tx.oncomplete = () => resolve('complete')
      tx.onabort = () => resolve('abort')
    })
    return { ok: transactionStatus === 'complete', signals, transaction_status: transactionStatus }
  } finally {
    raw.close()
  }
}

function makeRecord(queueId, blob) {
  const now = 1_700_000_000_000
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: queueId,
    blob,
    file_name: `synthetic-${queueId}.bin`,
    mime_type: 'application/octet-stream',
    file_size: blob.size,
    source_surface: 's12_safari_harness',
    entity_type: 'synthetic',
    entity_id: 's12-synthetic',
    provisional_id: null,
    actor_scope_type: ACTOR_TYPE,
    actor_scope_id: ACTOR_ID,
    run_type: 's12',
    storage_path: `s12/synthetic/${queueId}.bin`,
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
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
}

async function bytesMatch(left, right) {
  if (!(left instanceof Blob) || !(right instanceof Blob)) {
    return false
  }
  if (left.size !== right.size || left.type !== right.type) {
    return false
  }
  let offset = 0
  while (offset < left.size) {
    const end = Math.min(left.size, offset + 65536)
    const leftChunk = new Uint8Array(await left.slice(offset, end).arrayBuffer())
    const rightChunk = new Uint8Array(await right.slice(offset, end).arrayBuffer())
    if (leftChunk.length !== rightChunk.length) {
      return false
    }
    for (let index = 0; index < leftChunk.length; index += 1) {
      if (leftChunk[index] !== rightChunk[index]) {
        return false
      }
    }
    offset = end
  }
  return true
}

async function byteMark(blob) {
  if (!(blob instanceof Blob)) {
    return { byte_length: 0, byte_mark: null }
  }
  let hash = 2166136261
  let offset = 0
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + 65536)
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer())
    for (let index = 0; index < chunk.length; index += 1) {
      hash ^= chunk[index]
      hash = Math.imul(hash, 16777619)
    }
    offset = end
  }
  return { byte_length: blob.size, byte_mark: (hash >>> 0).toString(16) }
}

function queueIdFromPath(storagePath) {
  const name = String(storagePath || '').split('/').pop() || ''
  return name.replace(/\.bin$/, '')
}

function safeNative(error) {
  if (!error) {
    return { native_error: null, native_message: null }
  }
  const name = typeof error.name === 'string' ? error.name : 'Error'
  const raw = typeof error.message === 'string' ? error.message.slice(0, 160) : null
  const unsafe = Boolean(raw && (raw.includes('eyJ') || raw.includes('@')))
  return { native_error: name, native_message: unsafe ? null : raw }
}

function actorArgs(queueId) {
  return {
    queueId,
    actorScopeType: ACTOR_TYPE,
    actorScopeId: ACTOR_ID,
  }
}

async function inlineBlobPresent(queueId) {
  const raw = await openCurrentDatabase()
  try {
    const tx = raw.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readonly')
    const row = await requestToPromise(tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).get(queueId))
    await transactionDone(tx)
    return Boolean(row && row.blob instanceof Blob)
  } finally {
    raw.close()
  }
}

function watchTransactions(log, workers) {
  const original = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function watchedTransaction(storeNames, mode) {
    const tx = original.call(this, storeNames, mode)
    const started = Date.now()
    const stores = Array.isArray(storeNames) ? storeNames.join('+') : String(storeNames || '')
    const finish = (status) => {
      const native = status === 'abort' ? safeNative(tx.error) : { native_error: null, native_message: null }
      log({
        queue_id: null,
        operation: 'indexeddb_transaction',
        state: String(mode || 'unknown'),
        duration_ms: Date.now() - started,
        transaction_status: status,
        worker_count: workers(),
        attempts: null,
        stores,
        ...native,
      })
    }
    tx.addEventListener('complete', () => finish('complete'))
    tx.addEventListener('abort', () => finish('abort'))
    return tx
  }
  return () => {
    IDBDatabase.prototype.transaction = original
  }
}

function createSimulatedTransport(log, workers, attemptsFor, runId) {
  const starts = []
  return {
    starts,
    runId: runId || null,
    startUpload(request) {
      const queueId = queueIdFromPath(request.storagePath)
      const startedAt = Date.now()
      let settled = false
      let rejectDone = () => {}
      const done = new Promise((resolve, reject) => {
        rejectDone = (error) => {
          if (settled) {
            return
          }
          settled = true
          reject(error)
        }
      })
      const entry = { queueId, startedAt, inFlight: true, runId: runId || null }
      starts.push(entry)
      if (runId) {
        void noteWorkerStart(runId, queueId, startedAt).catch(() => {})
      }
      log({
        queue_id: queueId,
        operation: 'tus_simulated_start',
        state: 'in_flight',
        duration_ms: 0,
        native_error: null,
        native_message: null,
        transaction_status: 'n/a',
        worker_count: workers(),
        attempts: attemptsFor(queueId),
        run_id: runId || null,
      })
      return {
        done,
        abort() {
          entry.inFlight = false
          entry.endedAt = Date.now()
          if (runId) {
            void noteWorkerEnd(runId, queueId, startedAt, entry.endedAt).catch(() => {})
          }
          rejectDone(Object.assign(new Error('ABORTED'), { name: 'AbortError', code: 'ABORTED' }))
        },
      }
    },
  }
}

function createHarnessStore(db, transport) {
  return createPhotoUploadStore({
    db,
    transport,
    reconciler: {
      async inspectRemoteObject() {
        throw Object.assign(new Error('HARNESS_RECONCILER_BLOCKED'), { code: 'HARNESS_RECONCILER_BLOCKED' })
      },
      async reconcileEvidencePhotoRow() {
        throw Object.assign(new Error('HARNESS_RECONCILER_BLOCKED'), { code: 'HARNESS_RECONCILER_BLOCKED' })
      },
    },
    actorScopeType: ACTOR_TYPE,
    actorScopeId: ACTOR_ID,
    leaseOwner: LEASE_OWNER,
    getAccessToken: async () => 's12-synthetic-token',
    isOnline: () => true,
    now: () => Date.now(),
    random: () => 0,
  })
}

async function runAutomatic(session, log) {
  const started = Date.now()
  const sources = new Map()
  const attempts = {}
  const records = Object.values(IDS).map((queueId, index) => {
    const blob = syntheticBlob(index + 1)
    sources.set(queueId, blob)
    attempts[queueId] = 0
    return makeRecord(queueId, blob)
  })
  await seedLegacyRecords(records)
  log({
    queue_id: null,
    operation: 'seed_v1',
    state: 'complete',
    duration_ms: Date.now() - started,
    native_error: null,
    native_message: null,
    transaction_status: 'complete',
    worker_count: 0,
    attempts: 0,
    record_count: records.length,
  })
  const seededInline = await inlineBlobPresent(IDS.single)
  return {
    sources,
    attempts,
    seededInline,
    recordCount: records.length,
  }
}

async function migrateOne(session, queueId) {
  const result = await session.db.migrateNextLegacyRecord()
  if (!result || result.queueId !== queueId || result.migrated !== true) {
    throw new Error(`expected ${queueId} to migrate first`)
  }
}

async function verifyReopened(session, queueId, source) {
  await session.db.close()
  session.db = createPhotoUploadDb({ dbName: HARNESS_DB_NAME })
  const stored = await session.db.getRecord(actorArgs(queueId))
  const match = await bytesMatch(source, stored && stored.blob)
  const inline = await inlineBlobPresent(queueId)
  return { match, inline, attempts: stored ? stored.upload_attempt_count : null }
}

async function migrateRemainder(db) {
  for (let step = 0; step < 12; step += 1) {
    const result = await db.migrateNextLegacyRecord()
    if (!result || (result.migrated !== true && !result.queueId)) {
      return
    }
  }
}

async function parkExcept(db, activeIds) {
  const active = new Set(activeIds)
  for (const queueId of Object.values(IDS)) {
    if (active.has(queueId)) {
      continue
    }
    const current = await db.getRecord(actorArgs(queueId))
    if (!current || current.status === PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD) {
      continue
    }
    await db.putRecord({
      ...current,
      blob: null,
      status: PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: Date.now(),
    })
  }
}

async function activateQueued(db, queueId) {
  const current = await db.getRecord(actorArgs(queueId))
  await db.putRecord({
    ...current,
    blob: null,
    status: PHOTO_UPLOAD_STATUSES.QUEUED,
    lease_owner: null,
    lease_expires_at: null,
    next_retry_at: null,
    updated_at: Date.now(),
  })
}

function startCount(transport, queueId) {
  if (!transport) {
    return 0
  }
  return transport.starts.filter((entry) => entry.queueId === queueId).length
}

function inFlightCount(transport, queueId) {
  if (!transport) {
    return 0
  }
  return transport.starts.filter((entry) => entry.queueId === queueId && entry.inFlight).length
}

function readArm() {
  try {
    return JSON.parse(window.sessionStorage.getItem(ARM_KEY) || 'null')
  } catch (_error) {
    return null
  }
}

function workersForRun(cycle, transport, runId) {
  const byKey = new Map()
  for (const worker of (cycle && cycle.workers) || []) {
    if (worker && worker.run_id === runId) {
      byKey.set(`${worker.queue_id}:${worker.started_at}`, worker)
    }
  }
  for (const entry of (transport && transport.starts) || []) {
    if (entry.runId !== runId) {
      continue
    }
    byKey.set(`${entry.queueId}:${entry.startedAt}`, {
      queue_id: entry.queueId,
      run_id: runId,
      started_at: entry.startedAt,
      ended_at: entry.endedAt || null,
      in_flight: entry.inFlight === true,
    })
  }
  return [...byKey.values()]
}

function backgroundDetail(classification, source) {
  if (classification.result === 'pass') {
    return `Retorno por ${source}. Segundo plano de ${classification.hidden_duration_ms} ms. Bytes preservados e um worker por fila.`
  }
  if (classification.reason === 'byte_mismatch') {
    return `Retorno por ${source}. Bytes divergiram.`
  }
  if (classification.reason === 'duplicate_worker') {
    return `Retorno por ${source}. Dois workers ativos para a mesma fila neste ciclo.`
  }
  if (classification.reason === 'improper_resume') {
    return `Retorno por ${source}. Retomada duplicada no mesmo ciclo.`
  }
  if (classification.reason === 'background_shorter_than_required') {
    return `Retorno por ${source}. Segundo plano de ${classification.hidden_duration_ms} ms, abaixo de 10 minutos. Inconclusivo.`
  }
  return `Retorno por ${source}. Sem evidência de segundo plano. Inconclusivo.`
}

export function SafariS12Harness() {
  const [scenarios, setScenarios] = useState(() => SCENARIOS.map((item) => ({ ...item, result: 'pending', detail: '' })))
  const [events, setEvents] = useState([])
  const [running, setRunning] = useState(false)
  const [autoDone, setAutoDone] = useState(false)
  const [runId, setRunId] = useState(null)
  const [backgroundCycle, setBackgroundCycle] = useState('not_started')
  const [statusLine, setStatusLine] = useState('Pronto para o teste isolado.')
  const eventsRef = useRef([])
  const scenariosRef = useRef(scenarios)
  const sessionRef = useRef({ db: null, store: null, transport: null, sources: new Map(), attempts: {}, runId: null })
  const recoveryLockRef = useRef(Promise.resolve())
  const autoCompletedRef = useRef(false)
  const diagnosticSnapshotRef = useRef(null)

  const log = (entry) => {
    const row = { at: new Date().toISOString(), ...entry }
    eventsRef.current = [...eventsRef.current, row]
    setEvents(eventsRef.current)
  }

  const updateScenario = (id, patch) => {
    const next = scenariosRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    scenariosRef.current = next
    setScenarios(next)
  }

  const report = useMemo(() => ({
    harness: 'safari-s12',
    db_name: HARNESS_DB_NAME,
    meta_db_name: HARNESS_META_DB_NAME,
    real_db_name: PHOTO_UPLOAD_DB_NAME,
    real_database_touched: false,
    max_concurrent_uploads: MAX_CONCURRENT_UPLOADS,
    min_background_ms: SAFARI_S12_MIN_BACKGROUND_MS,
    run_id: runId,
    background_cycle: backgroundCycle,
    generated_at: new Date().toISOString(),
    blocked_network: (window.__safariS12BlockedNetwork || []).map((item) => ({
      channel: item.channel,
      host: item.host,
    })),
    scenarios,
    events,
  }), [scenarios, events, runId, backgroundCycle])

  useEffect(() => {
    installDatabaseTripwire()
    try {
      diagnosticSnapshotRef.current = {
        events: window.localStorage.getItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY),
        enabled: window.localStorage.getItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY),
      }
      window.localStorage.setItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY, '0')
    } catch (_error) {
      diagnosticSnapshotRef.current = null
    }
    const restoreDiagnostics = () => {
      const snapshot = diagnosticSnapshotRef.current
      if (!snapshot) {
        return
      }
      try {
        if (snapshot.events === null) {
          window.localStorage.removeItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY)
        } else {
          window.localStorage.setItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY, snapshot.events)
        }
        if (snapshot.enabled === null) {
          window.localStorage.removeItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY)
        } else {
          window.localStorage.setItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY, snapshot.enabled)
        }
      } catch (_error) {
        return
      }
    }
    const persistHidden = () => {
      if (document.visibilityState !== 'hidden') {
        return
      }
      const armed = readArm()
      const activeRunId = sessionRef.current.runId || (armed && armed.run_id) || null
      if (!activeRunId) {
        return
      }
      const hiddenAt = Date.now()
      void recordHiddenTransition(activeRunId, hiddenAt, document.visibilityState).then((cycle) => {
        if (!cycle || !Number.isInteger(cycle.hidden_at)) {
          return
        }
        log({
          queue_id: null,
          operation: 'visibility_hidden',
          state: 'hidden',
          duration_ms: 0,
          native_error: null,
          native_message: null,
          transaction_status: 'complete',
          worker_count: sessionRef.current.store ? sessionRef.current.store.getRuntimeStatus().activeUploadCount : 0,
          attempts: null,
          run_id: activeRunId,
          hidden_at: cycle.hidden_at,
        })
      }, () => {})
    }
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        persistHidden()
        return
      }
      if (document.visibilityState === 'visible') {
        void recoverQueue('visibility', false)
      }
    }
    const onPageHide = () => {
      restoreDiagnostics()
      persistHidden()
    }
    const onPageShow = (event) => {
      void recoverQueue('pageshow', Boolean(event && event.persisted))
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('pagehide', onPageHide)
    void recoverQueue('load', false)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('pagehide', onPageHide)
      restoreDiagnostics()
      const session = sessionRef.current
      if (session.store) {
        void session.store.stop()
      }
      if (session.db) {
        void session.db.close()
      }
    }
  }, [])

  function recoverQueue(source, persisted) {
    const run = recoveryLockRef.current.then(
      () => recoverQueueOnce(source, persisted),
      () => recoverQueueOnce(source, persisted)
    )
    recoveryLockRef.current = run.then(() => undefined, () => undefined)
    return run
  }

  async function recoverQueueOnce(source, persisted) {
    let armed = readArm()
    if (!armed || armed.db_name !== HARNESS_DB_NAME || !armed.run_id) {
      if (source === 'visibility') {
        return
      }
      const storedCycle = await readRecoverableCycle()
      if (!storedCycle || !storedCycle.run_id || !Array.isArray(storedCycle.records)) {
        return
      }
      armed = {
        db_name: HARNESS_DB_NAME,
        page_token: storedCycle.page_token || null,
        run_id: storedCycle.run_id,
        records: storedCycle.records,
        foreground_result: storedCycle.foreground_result || null,
      }
    }
    const samePage = armed.page_token === PAGE_TOKEN
    if (source === 'load' && samePage) {
      return
    }
    const activeRunId = armed.run_id
    setRunId(activeRunId)
    const started = Date.now()
    try {
      let cycle = await readVisibilityCycle(activeRunId)
      const transportBefore = samePage ? sessionRef.current.transport : null
      const workersBefore = workersForRun(cycle, transportBefore, activeRunId)
      const duplicateBefore = workersBefore.some((worker, index) => (
        worker.in_flight && workersBefore.some((other, otherIndex) => (
          otherIndex !== index && other.in_flight && other.queue_id === worker.queue_id && other.run_id === activeRunId
        ))
      ))
      if (duplicateBefore) {
        cycle = await markDuplicateObserved(activeRunId)
      }
      const hadVisibleAt = Boolean(cycle && Number.isInteger(cycle.visible_at))
      const realHidden = Boolean(
        cycle
        && Number.isInteger(cycle.hidden_at)
        && cycle.hidden_visibility_state === 'hidden'
      )
      if (!samePage) {
        cycle = await closeStaleWorkers(activeRunId, Date.now())
      }
      const now = Date.now()
      if (realHidden && !hadVisibleAt) {
        cycle = await recordVisibleReturn(activeRunId, now)
      }
      const db = sessionRef.current.db || createPhotoUploadDb({ dbName: HARNESS_DB_NAME })
      if (!sessionRef.current.db) {
        sessionRef.current.db = db
      }
      const marks = []
      for (const item of armed.records || []) {
        const stored = await db.getRecord(actorArgs(item.queue_id))
        const mark = await byteMark(stored && stored.blob)
        marks.push({
          queue_id: item.queue_id,
          matches: mark.byte_mark === item.byte_mark && mark.byte_length === item.byte_length,
          attempts: stored ? stored.upload_attempt_count : null,
          status: stored ? stored.status : null,
        })
      }
      const hiddenDuration = cycle && Number.isInteger(cycle.hidden_duration_ms) ? cycle.hidden_duration_ms : 0
      const store = sessionRef.current.store
      if (realHidden && !hadVisibleAt && store && samePage && source !== 'load') {
        await store.wake({ hiddenDuration, source, persisted })
        await delay(400)
      }
      cycle = await readVisibilityCycle(activeRunId)
      const workers = workersForRun(cycle, samePage ? sessionRef.current.transport : null, activeRunId)
      const bytesMatch = marks.length > 0 && marks.every((item) => item.matches === true)
      const classification = classifyBackgroundCycle({
        hiddenAt: cycle && cycle.hidden_at,
        hiddenVisibilityState: cycle && cycle.hidden_visibility_state,
        visibleAt: cycle && cycle.visible_at,
        now,
        workers,
        runId: activeRunId,
        bytesMatch,
        armedRecords: armed.records || [],
        duplicateObserved: duplicateBefore || Boolean(cycle && cycle.duplicate_observed),
        leaseTtlMs: LEASE_TTL_MS,
      })
      const detail = backgroundDetail(classification, source)
      const foreground = scenariosRef.current.find((item) => item.id === '9')
      const foregroundResult = (foreground && foreground.foreground_result) || armed.foreground_result || (cycle && cycle.foreground_result) || null
      const scenarioNine = combineScenarioNine(foregroundResult, classification.result)
      updateScenario('6', { result: classification.result, detail })
      updateScenario('9', { result: scenarioNine, detail })
      log({
        queue_id: null,
        operation: 'queue_recovery',
        state: classification.result,
        duration_ms: Date.now() - started,
        native_error: null,
        native_message: null,
        transaction_status: 'n/a',
        worker_count: store ? store.getRuntimeStatus().activeUploadCount : 0,
        attempts: null,
        hidden_duration_ms: classification.hidden_duration_ms,
        hidden_at: cycle && Number.isInteger(cycle.hidden_at) ? cycle.hidden_at : null,
        visible_at: cycle && Number.isInteger(cycle.visible_at) ? cycle.visible_at : null,
        persisted: Boolean(persisted),
        source,
        run_id: activeRunId,
        reason: classification.reason,
      })
      setStatusLine(detail)
    } catch (error) {
      const native = safeNative(error)
      updateScenario('6', { result: 'fail', detail: native.native_message || native.native_error })
      updateScenario('9', { result: 'fail', detail: native.native_message || native.native_error })
    }
  }

  async function runScenarios() {
    if (running) {
      return
    }
    setRunning(true)
    autoCompletedRef.current = false
    setAutoDone(false)
    setBackgroundCycle('not_started')
    sessionRef.current.runId = null
    setRunId(null)
    clearBackgroundArm()
    setStatusLine('Executando cenários automáticos.')
    const session = sessionRef.current
    if (session.store) {
      await session.store.stop()
      session.store = null
    }
    if (session.db) {
      await session.db.close()
      session.db = null
    }
    const unwatch = watchTransactions(log, () => (
      session.store ? session.store.getRuntimeStatus().activeUploadCount : 0
    ))
    try {
      const seeded = await runAutomatic(session, log)
      session.sources = seeded.sources
      session.attempts = seeded.attempts
      updateScenario('1', {
        result: seeded.seededInline && seeded.recordCount === 8 ? 'pass' : 'fail',
        detail: `${seeded.recordCount} registros V1 no banco ${HARNESS_DB_NAME}.`,
      })

      session.db = createPhotoUploadDb({ dbName: HARNESS_DB_NAME })
      const migrationStarted = Date.now()
      await migrateOne(session, IDS.single)
      const reopened = await verifyReopened(session, IDS.single, seeded.sources.get(IDS.single))
      updateScenario('2', {
        result: reopened.match && !reopened.inline ? 'pass' : 'fail',
        detail: reopened.match ? 'Bytes iguais após fechar e reabrir.' : 'Bytes divergiram após a migração.',
      })
      log({
        queue_id: IDS.single,
        operation: 'migrate_reopen',
        state: reopened.match ? 'pass' : 'fail',
        duration_ms: Date.now() - migrationStarted,
        native_error: null,
        native_message: null,
        transaction_status: 'complete',
        worker_count: 0,
        attempts: reopened.attempts,
      })

      await session.db.close()
      session.db = null
      const first = createPhotoUploadDb({ dbName: HARNESS_DB_NAME })
      const second = createPhotoUploadDb({ dbName: HARNESS_DB_NAME })
      const raceStarted = Date.now()
      let left = null
      let right = null
      try {
        ;[left, right] = await Promise.all([
          first.migrateNextLegacyRecord(),
          second.migrateNextLegacyRecord(),
        ])
      } finally {
        await first.close()
        await second.close()
      }
      session.db = createPhotoUploadDb({ dbName: HARNESS_DB_NAME })
      const concurrentStored = await session.db.getRecord(actorArgs(IDS.concurrent))
      const concurrentMatch = await bytesMatch(seeded.sources.get(IDS.concurrent), concurrentStored && concurrentStored.blob)
      const concurrentInline = await inlineBlobPresent(IDS.concurrent)
      const concurrentPass = concurrentMatch && !concurrentInline && Boolean(left && left.migrated || right && right.migrated)
      updateScenario('3', {
        result: concurrentPass ? 'pass' : 'fail',
        detail: `Instâncias: ${left && left.migrated}/${right && right.migrated}. Bytes ${concurrentMatch ? 'iguais' : 'divergentes'}.`,
      })
      log({
        queue_id: IDS.concurrent,
        operation: 'migrate_concurrent',
        state: concurrentPass ? 'pass' : 'fail',
        duration_ms: Date.now() - raceStarted,
        native_error: null,
        native_message: null,
        transaction_status: 'complete',
        worker_count: 2,
        attempts: concurrentStored ? concurrentStored.upload_attempt_count : null,
      })
      await migrateRemainder(session.db)

      const leaseStarted = Date.now()
      const payloadPuts = { count: 0 }
      const queuePuts = { count: 0 }
      const originalPut = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function countedPut(value, key) {
        if (this.name === PHOTO_UPLOAD_PAYLOAD_STORE) {
          payloadPuts.count += 1
        }
        if (this.name === PHOTO_UPLOAD_QUEUE_STORE) {
          queuePuts.count += 1
        }
        return originalPut.call(this, value, key)
      }
      let leasePass = false
      try {
        const claimed = await session.db.claimLease({
          queueId: IDS.lease,
          actorScopeType: ACTOR_TYPE,
          actorScopeId: ACTOR_ID,
          leaseOwner: LEASE_OWNER,
          now: Date.now(),
          leaseTtlMs: LEASE_TTL_MS,
        })
        for (let step = 0; step < 8; step += 1) {
          await session.db.heartbeatLease({
            queueId: IDS.lease,
            actorScopeType: ACTOR_TYPE,
            actorScopeId: ACTOR_ID,
            leaseOwner: LEASE_OWNER,
            leaseGeneration: claimed.lease_generation,
            now: Date.now(),
            leaseTtlMs: LEASE_TTL_MS,
          })
        }
        for (let step = 1; step <= 8; step += 1) {
          const current = await session.db.getRecord(actorArgs(IDS.lease))
          await session.db.putRecordFenced({
            record: {
              ...current,
              blob: null,
              status: PHOTO_UPLOAD_STATUSES.UPLOADING,
              bytes_uploaded: step * 1024,
              updated_at: Date.now(),
            },
            leaseOwner: LEASE_OWNER,
            leaseGeneration: claimed.lease_generation,
          })
        }
        await session.db.releaseLease({
          queueId: IDS.lease,
          actorScopeType: ACTOR_TYPE,
          actorScopeId: ACTOR_ID,
          leaseOwner: LEASE_OWNER,
          leaseGeneration: claimed.lease_generation,
        })
        const afterLease = await session.db.getRecord(actorArgs(IDS.lease))
        leasePass = payloadPuts.count === 0
          && queuePuts.count > 0
          && await bytesMatch(seeded.sources.get(IDS.lease), afterLease && afterLease.blob)
      } finally {
        IDBObjectStore.prototype.put = originalPut
      }
      updateScenario('4', {
        result: leasePass ? 'pass' : 'fail',
        detail: `Gravações de payload durante lease/status/progresso: ${payloadPuts.count}. Fila: ${queuePuts.count}.`,
      })
      log({
        queue_id: IDS.lease,
        operation: 'lease_progress',
        state: leasePass ? 'pass' : 'fail',
        duration_ms: Date.now() - leaseStarted,
        native_error: null,
        native_message: null,
        transaction_status: 'complete',
        worker_count: 0,
        attempts: 0,
        payload_puts: payloadPuts.count,
        queue_puts: queuePuts.count,
      })

      await runHeldUploads(session, log, [IDS.uploadA, IDS.uploadB], 'concurrent_upload')
      const overlap = session.transport
        && session.transport.starts.filter((entry) => entry.queueId === IDS.uploadA || entry.queueId === IDS.uploadB).length >= 2
      const uploadBytes = await bothMatch(session, [IDS.uploadA, IDS.uploadB])
      const uploadAttempts = await attemptValues(session, [IDS.uploadA, IDS.uploadB])
      const uploadPass = overlap && uploadBytes && uploadAttempts.every((value) => value === 0)
      updateScenario('5', {
        result: uploadPass ? 'pass' : 'fail',
        detail: uploadPass ? 'Dois workers simulados. Nenhum byte foi enviado.' : 'Concorrência ou bytes não conferiram.',
      })

      const failureStarted = Date.now()
      let substep = 'abort_test'
      let faultArmed = false
      let faultInjectionExpected = false
      let faultStore = null
      const idbSignals = emptyIdbSignals()
      const scenario7OriginalPut = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function scenario7Put(value, key) {
        if (this.name === PHOTO_UPLOAD_PAYLOAD_STORE) {
          log({
            queue_id: value && value.queue_id ? value.queue_id : null,
            operation: 'payload_put',
            state: substep,
            duration_ms: 0,
            native_error: null,
            native_message: null,
            transaction_status: 'requested',
            worker_count: 0,
            attempts: null,
            store: this.name,
            fault_injection_expected: false,
            ...blobFields(value),
          })
        }
        if (faultArmed && this.name === PHOTO_UPLOAD_QUEUE_STORE) {
          faultArmed = false
          faultInjectionExpected = true
          faultStore = this.name
          observeTransaction(this.transaction, idbSignals)
          log({
            queue_id: value && value.queue_id ? value.queue_id : IDS.idb,
            operation: 'idb_error_test',
            state: 'fault_injected',
            duration_ms: 0,
            native_error: EXPECTED_INJECTED_FAULT.name,
            native_message: EXPECTED_INJECTED_FAULT.message,
            transaction_status: 'injecting',
            worker_count: 0,
            attempts: null,
            store: this.name,
            fault_injection_expected: true,
            ...blobFields(value),
          })
          throw new DOMException(EXPECTED_INJECTED_FAULT.message, EXPECTED_INJECTED_FAULT.name)
        }
        return scenario7OriginalPut.call(this, value, key)
      }
      let abortMatch = false
      let abortAttempts = null
      let unexpectedNative = false
      let unexpectedDetail = ''
      let scenario7Pass = false
      try {
        try {
          await runHeldUploads(session, log, [IDS.abort], 'abort_test')
          const abortStored = await session.db.getRecord(actorArgs(IDS.abort))
          abortMatch = await bytesMatch(seeded.sources.get(IDS.abort), abortStored && abortStored.blob)
          abortAttempts = abortStored ? abortStored.upload_attempt_count : null
          log({
            queue_id: IDS.abort,
            operation: 'abort_test',
            state: abortMatch && abortAttempts === 0 ? 'pass' : 'fail',
            duration_ms: Date.now() - failureStarted,
            native_error: null,
            native_message: null,
            transaction_status: 'complete',
            worker_count: 0,
            attempts: abortAttempts,
            fault_injection_expected: false,
          })
        } catch (error) {
          unexpectedNative = true
          const native = safeNative(error)
          unexpectedDetail = `abort_test ${native.native_error || ''} ${native.native_message || ''}`.trim()
          log({
            queue_id: IDS.abort,
            operation: 'abort_test',
            state: 'fail',
            duration_ms: Date.now() - failureStarted,
            transaction_status: 'caller_exception',
            worker_count: 0,
            attempts: null,
            fault_injection_expected: false,
            caller_exception: native,
            ...native,
          })
        }

        substep = 'idb_error_test'
        faultArmed = true
        let callerName = null
        let callerMessage = null
        try {
          const claimed = await session.db.claimLease({
            queueId: IDS.idb,
            actorScopeType: ACTOR_TYPE,
            actorScopeId: ACTOR_ID,
            leaseOwner: LEASE_OWNER,
            now: Date.now(),
            leaseTtlMs: LEASE_TTL_MS,
          })
          await session.db.heartbeatLease({
            queueId: IDS.idb,
            actorScopeType: ACTOR_TYPE,
            actorScopeId: ACTOR_ID,
            leaseOwner: LEASE_OWNER,
            leaseGeneration: claimed.lease_generation,
            now: Date.now(),
            leaseTtlMs: LEASE_TTL_MS,
          })
        } catch (error) {
          const native = safeNative(error)
          callerMessage = native.native_message
          callerName = error && error.cause && error.cause.name ? error.cause.name : native.native_error
          idbSignals.caller_exception = { native_error: callerName, native_message: callerMessage }
        }
        await delay(50)
        const idbStored = await session.db.getRecord(actorArgs(IDS.idb))
        const idbMatch = await bytesMatch(seeded.sources.get(IDS.idb), idbStored && idbStored.blob)
        const idbAttempts = idbStored ? idbStored.upload_attempt_count : null
        if (callerMessage && callerMessage.indexOf(SAFARI_BLOB_PREPARATION_MESSAGE) !== -1) {
          unexpectedNative = true
          unexpectedDetail = `idb_error_test ${callerMessage}`
        }
        log({
          queue_id: IDS.idb,
          operation: 'idb_error_test',
          state: 'observed',
          duration_ms: Date.now() - failureStarted,
          native_error: callerName,
          native_message: callerMessage,
          transaction_status: idbSignals.transaction_abort ? 'abort' : 'complete',
          worker_count: 0,
          attempts: idbAttempts,
          store: faultStore,
          fault_injection_expected: faultInjectionExpected,
          request_error: idbSignals.request_error,
          transaction_error: idbSignals.transaction_error,
          transaction_abort: idbSignals.transaction_abort,
          caller_exception: idbSignals.caller_exception,
        })

        substep = 'missing_payload_test'
        let payloadWait = false
        let payloadStarts = null
        let payloadAttempts = null
        let payloadInitialMatch = false
        let payloadDiscarded = false
        const missingSource = syntheticBlob(9)
        try {
          await session.db.putRecord(makeRecord(MISSING_PAYLOAD_ID, missingSource))
          const created = await session.db.getRecord(actorArgs(MISSING_PAYLOAD_ID))
          rememberIndexedDbBlob(created)
          payloadInitialMatch = await bytesMatch(missingSource, created && created.blob)
          const attemptsBefore = created ? created.upload_attempt_count : null
          log({
            queue_id: MISSING_PAYLOAD_ID,
            operation: 'missing_payload_test',
            state: payloadInitialMatch ? 'initial_read' : 'initial_read_mismatch',
            duration_ms: 0,
            native_error: null,
            native_message: null,
            transaction_status: 'complete',
            worker_count: 0,
            attempts: attemptsBefore,
            store: PHOTO_UPLOAD_PAYLOAD_STORE,
            fault_injection_expected: false,
            ...blobFields(created),
          })
          if (!payloadInitialMatch) {
            unexpectedNative = true
            unexpectedDetail = 'missing_payload_test leitura inicial nao conferiu'
            await deleteKeyObserved(PHOTO_UPLOAD_PAYLOAD_STORE, MISSING_PAYLOAD_ID)
          } else {
            const removed = await deleteKeyObserved(PHOTO_UPLOAD_PAYLOAD_STORE, MISSING_PAYLOAD_ID)
            log({
              queue_id: MISSING_PAYLOAD_ID,
              operation: 'missing_payload_test',
              state: removed.ok ? 'payload_removed_for_test' : 'payload_remove_failed',
              duration_ms: 0,
              native_error: removed.signals.caller_exception && removed.signals.caller_exception.native_error,
              native_message: (removed.signals.transaction_error && removed.signals.transaction_error.native_message)
                || (removed.signals.request_error && removed.signals.request_error.native_message),
              transaction_status: removed.transaction_status,
              worker_count: 0,
              attempts: attemptsBefore,
              store: PHOTO_UPLOAD_PAYLOAD_STORE,
              fault_injection_expected: false,
              request_error: removed.signals.request_error,
              transaction_error: removed.signals.transaction_error,
              transaction_abort: removed.signals.transaction_abort,
              caller_exception: removed.signals.caller_exception,
            })
            if (!removed.ok) {
              unexpectedNative = true
              unexpectedDetail = 'missing_payload_test a remocao do payload falhou'
            } else {
              if (session.store) {
                await session.store.stop()
              }
              session.transport = createSimulatedTransport(
                log,
                () => (session.store ? session.store.getRuntimeStatus().activeUploadCount : 0),
                (queueId) => session.attempts[queueId] || 0
              )
              session.store = createHarnessStore(session.db, session.transport)
              const pump = session.store.start()
              if (pump && typeof pump.then === 'function') {
                pump.then(() => {}, () => {})
              }
              payloadWait = await waitFor(async () => {
                const stored = await session.db.getRecord(actorArgs(MISSING_PAYLOAD_ID))
                return stored && stored.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT
              }, 5000)
              await session.store.stop()
              session.store = null
              const payloadStored = await session.db.getRecord(actorArgs(MISSING_PAYLOAD_ID))
              payloadStarts = startCount(session.transport, MISSING_PAYLOAD_ID)
              payloadAttempts = payloadStored ? payloadStored.upload_attempt_count : null
            }
          }
          const discarded = await deleteKeyObserved(PHOTO_UPLOAD_QUEUE_STORE, MISSING_PAYLOAD_ID)
          const gone = await session.db.getRecord(actorArgs(MISSING_PAYLOAD_ID))
          payloadDiscarded = discarded.ok && !gone
          log({
            queue_id: MISSING_PAYLOAD_ID,
            operation: 'missing_payload_test',
            state: payloadDiscarded ? 'discarded' : 'discard_failed',
            duration_ms: Date.now() - failureStarted,
            native_error: discarded.signals.caller_exception && discarded.signals.caller_exception.native_error,
            native_message: (discarded.signals.transaction_error && discarded.signals.transaction_error.native_message)
              || (discarded.signals.request_error && discarded.signals.request_error.native_message),
            transaction_status: discarded.transaction_status,
            worker_count: 0,
            attempts: payloadAttempts,
            store: PHOTO_UPLOAD_QUEUE_STORE,
            fault_injection_expected: false,
            request_error: discarded.signals.request_error,
            transaction_error: discarded.signals.transaction_error,
            transaction_abort: discarded.signals.transaction_abort,
            caller_exception: discarded.signals.caller_exception,
          })
          if (!payloadDiscarded) {
            unexpectedNative = true
            unexpectedDetail = unexpectedDetail || 'missing_payload_test o registro sintetico nao foi descartado'
          }
        } catch (error) {
          unexpectedNative = true
          const native = safeNative(error)
          unexpectedDetail = unexpectedDetail || `missing_payload_test ${native.native_message || native.native_error || ''}`.trim()
          await deleteKeyObserved(PHOTO_UPLOAD_PAYLOAD_STORE, MISSING_PAYLOAD_ID)
          await deleteKeyObserved(PHOTO_UPLOAD_QUEUE_STORE, MISSING_PAYLOAD_ID)
          log({
            queue_id: MISSING_PAYLOAD_ID,
            operation: 'missing_payload_test',
            state: 'fail',
            duration_ms: Date.now() - failureStarted,
            transaction_status: 'caller_exception',
            worker_count: 0,
            attempts: payloadAttempts,
            fault_injection_expected: false,
            caller_exception: native,
            ...native,
          })
        }
        const decision = classifyScenario7({
          abortBytesMatch: abortMatch,
          abortAttempts,
          faultInjectionExpected,
          faultStore,
          callerName,
          callerMessage,
          idbBytesMatch: idbMatch,
          idbAttempts,
          payloadInitialMatch,
          payloadObserved: payloadWait,
          payloadStarts,
          payloadAttempts,
          payloadDiscarded,
          unexpectedNative,
        })
        scenario7Pass = decision.result === 'pass'
        updateScenario('7', {
          result: decision.result,
          detail: decision.reason === 'unexpected_native_error'
            ? `Falha nativa inesperada. ${unexpectedDetail} fault_injection_expected=false.`
            : `Abort bytes=${abortMatch}. Falha injetada=${faultInjectionExpected}. Observada=${callerName || 'sem erro'}. Payload ausente starts=${payloadStarts}.`,
        })
        updateScenario('8', {
          result: abortAttempts === 0 && idbAttempts === 0 && payloadAttempts === 0 ? 'pass' : 'fail',
          detail: `Tentativas abort/idb/payload: ${abortAttempts}/${idbAttempts}/${payloadAttempts}.`,
        })
        log({
          queue_id: MISSING_PAYLOAD_ID,
          operation: 'local_failures',
          state: decision.result,
          duration_ms: Date.now() - failureStarted,
          native_error: callerName,
          native_message: unexpectedNative ? unexpectedDetail : callerMessage,
          transaction_status: idbSignals.transaction_abort ? 'abort' : 'complete',
          worker_count: 0,
          attempts: payloadAttempts,
          fault_injection_expected: faultInjectionExpected,
          reason: decision.reason,
        })
      } finally {
        IDBObjectStore.prototype.put = scenario7OriginalPut
      }

      const foregroundOk = uploadPass && scenario7Pass && reopened.match && concurrentMatch
      updateScenario('9', {
        foreground_result: foregroundOk ? 'pass' : 'fail',
        result: 'pending',
        detail: 'Conferência em primeiro plano feita. Falta uma suspensão real de pelo menos 10 minutos.',
      })
      autoCompletedRef.current = true
      setAutoDone(true)
      setBackgroundCycle('not_armed')
      setStatusLine('Automático concluído. Arme o segundo plano no iPhone.')
    } catch (error) {
      const native = safeNative(error)
      autoCompletedRef.current = false
      setAutoDone(false)
      setBackgroundCycle('invalid_interrupted_run')
      session.runId = null
      setRunId(null)
      clearBackgroundArm()
      const pendingSeven = scenariosRef.current.find((item) => item.id === '7' && item.result === 'pending')
      if (pendingSeven) {
        updateScenario('7', {
          result: 'fail',
          detail: `Interrompido antes de concluir. ${native.native_message || native.native_error}`,
        })
      }
      log({
        queue_id: null,
        operation: 'automatic_run',
        state: 'fail',
        duration_ms: 0,
        transaction_status: 'abort',
        worker_count: 0,
        attempts: null,
        fault_injection_expected: false,
        background_cycle: 'invalid_interrupted_run',
        ...native,
      })
      setStatusLine(native.native_message || native.native_error || 'Falha no automático.')
    } finally {
      unwatch()
      setRunning(false)
    }
  }

  async function bothMatch(session, queueIds) {
    for (const queueId of queueIds) {
      const stored = await session.db.getRecord(actorArgs(queueId))
      const match = await bytesMatch(session.sources.get(queueId), stored && stored.blob)
      if (!match) {
        return false
      }
    }
    return true
  }

  async function attemptValues(session, queueIds) {
    const values = []
    for (const queueId of queueIds) {
      const stored = await session.db.getRecord(actorArgs(queueId))
      values.push(stored ? stored.upload_attempt_count : null)
    }
    return values
  }

  async function runHeldUploads(session, logEntry, queueIds, operation) {
    await parkExcept(session.db, queueIds)
    for (const queueId of queueIds) {
      await activateQueued(session.db, queueId)
    }
    if (session.store) {
      await session.store.stop()
    }
    const started = Date.now()
    session.transport = createSimulatedTransport(
      logEntry,
      () => (session.store ? session.store.getRuntimeStatus().activeUploadCount : 0),
      (queueId) => session.attempts[queueId] || 0
    )
    session.store = createHarnessStore(session.db, session.transport)
    const pump = session.store.start()
    if (pump && typeof pump.then === 'function') {
      pump.then(() => {}, () => {})
    }
    const ready = await waitFor(
      () => session.store.getRuntimeStatus().activeUploadCount >= Math.min(queueIds.length, MAX_CONCURRENT_UPLOADS)
        && session.transport.starts.length >= queueIds.length,
      5000
    )
    logEntry({
      queue_id: queueIds.join(','),
      operation,
      state: ready ? 'in_flight' : 'timeout',
      duration_ms: Date.now() - started,
      native_error: null,
      native_message: null,
      transaction_status: 'n/a',
      worker_count: session.store.getRuntimeStatus().activeUploadCount,
      attempts: 0,
    })
    session.transport.starts.slice().forEach((entry) => {
      entry.inFlight = false
    })
    await session.store.stop()
    await waitFor(() => session.store.getRuntimeStatus().activeUploadCount === 0, 3000)
  }

  async function armBackground() {
    const session = sessionRef.current
    if (!session.db || running || autoCompletedRef.current !== true) {
      return
    }
    setRunning(true)
    setStatusLine('Armando dois uploads. Aguarde os workers.')
    const activeRunId = `s12-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
    let published = false
    try {
      if (session.store) {
        await session.store.stop()
      }
      session.runId = activeRunId
      setRunId(activeRunId)
      await createVisibilityCycle(activeRunId)
      await parkExcept(session.db, [IDS.uploadA, IDS.uploadB])
      await activateQueued(session.db, IDS.uploadA)
      await activateQueued(session.db, IDS.uploadB)
      session.transport = createSimulatedTransport(
        log,
        () => (session.store ? session.store.getRuntimeStatus().activeUploadCount : 0),
        () => 0,
        activeRunId
      )
      session.store = createHarnessStore(session.db, session.transport)
      const pump = session.store.start()
      if (pump && typeof pump.then === 'function') {
        pump.then(() => {}, () => {})
      }
      const armedIds = [IDS.uploadA, IDS.uploadB]
      const ready = await waitFor(
        () => session.store.getRuntimeStatus().activeUploadCount === 2
          && armedIds.every((queueId) => inFlightCount(session.transport, queueId) === 1),
        5000
      )
      if (!ready) {
        await session.store.stop()
        session.runId = null
        setRunId(null)
        updateScenario('6', { result: 'fail', detail: 'Não houve um worker ativo para cada fila.' })
        setStatusLine('Não foi possível armar os dois workers.')
        return
      }
      await Promise.all(session.transport.starts.map((entry) => (
        noteWorkerStart(activeRunId, entry.queueId, entry.startedAt)
      )))
      const records = []
      for (const queueId of armedIds) {
        const stored = await session.db.getRecord(actorArgs(queueId))
        const mark = await byteMark(stored && stored.blob)
        records.push({
          queue_id: queueId,
          ...mark,
          start_count: startCount(session.transport, queueId),
        })
      }
      const foregroundResult = (scenariosRef.current.find((item) => item.id === '9') || {}).foreground_result || null
      const cycle = await saveArmedSnapshot(activeRunId, records, PAGE_TOKEN, foregroundResult)
      const activeCounts = {}
      for (const worker of (cycle && cycle.workers) || []) {
        if (worker.in_flight && worker.run_id === activeRunId) {
          activeCounts[worker.queue_id] = (activeCounts[worker.queue_id] || 0) + 1
        }
      }
      const duplicated = Object.values(activeCounts).some((count) => count > 1)
      if (duplicated) {
        await session.store.stop()
        session.runId = null
        setRunId(null)
        updateScenario('6', { result: 'fail', detail: 'Dois workers ativos para a mesma fila neste ciclo.' })
        setStatusLine('O ciclo foi interrompido porque a mesma fila tinha dois workers.')
        return
      }
      window.sessionStorage.setItem(ARM_KEY, JSON.stringify({
        db_name: HARNESS_DB_NAME,
        page_token: PAGE_TOKEN,
        run_id: activeRunId,
        foreground_result: foregroundResult,
        records,
      }))
      published = true
      setBackgroundCycle('armed')
      updateScenario('6', {
        result: 'pending',
        detail: `Ciclo ${activeRunId}. Um worker por fila. Saia do Safari por pelo menos 10 minutos.`,
      })
      setStatusLine(`Ciclo ${activeRunId}. Saia do Safari por pelo menos 10 minutos e volte.`)
    } catch (error) {
      if (!published) {
        session.runId = null
        setRunId(null)
      }
      const native = safeNative(error)
      updateScenario('6', { result: 'fail', detail: native.native_message || native.native_error })
    } finally {
      setRunning(false)
    }
  }

  function copyReport() {
    const text = JSON.stringify(report, null, 2)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setStatusLine('JSON copiado.')
      }, () => {
        setStatusLine('Selecione o JSON abaixo e copie.')
      })
      return
    }
    setStatusLine('Selecione o JSON abaixo e copie.')
  }

  return (
    <main style={pageStyle}>
      <h1 style={titleStyle}>Safari S1.2 — teste isolado</h1>
      <p style={textStyle}>
        Banco exclusivo: <strong>{HARNESS_DB_NAME}</strong>.
        O horário de hidden fica em <strong>{HARNESS_META_DB_NAME}</strong>.
        O banco real <strong>{PHOTO_UPLOAD_DB_NAME}</strong> não é aberto.
        O transporte TUS só registra a operação e não envia arquivos.
        Ciclo: <strong>{runId || 'ainda não armado'}</strong>.
      </p>
      <p style={statusStyle}>{statusLine}</p>
      <div style={buttonRowStyle}>
        <button type="button" style={buttonStyle} disabled={running} onClick={() => { void runScenarios() }}>
          Executar automático
        </button>
        <button type="button" style={buttonStyle} disabled={running || !autoDone} onClick={() => { void armBackground() }}>
          Armar segundo plano
        </button>
        <button type="button" style={buttonStyle} onClick={copyReport}>
          Copiar JSON
        </button>
      </div>
      <ol style={listStyle}>
        {scenarios.map((item) => (
          <li key={item.id} style={itemStyle}>
            <strong>{item.id}. {item.title}</strong>
            <div>{item.mode === 'automatic' ? 'Automático' : item.mode === 'manual' ? 'Manual no iPhone' : 'Automático e manual'} — {item.result}</div>
            <div>{item.detail}</div>
          </li>
        ))}
      </ol>
      <h2 style={titleStyle}>Como executar no iPhone</h2>
      <ol style={textStyle}>
        <li>No computador, na pasta duchess-app do repositório S1, rode npm run start:safari-s12.</li>
        <li>No iPhone, na mesma rede Wi-Fi, abra http://IP-DO-COMPUTADOR:3000/</li>
        <li>Toque em Executar automático e espere a lista.</li>
        <li>Toque em Armar segundo plano e espere o identificador do ciclo com um worker por fila.</li>
        <li>Saia para a tela inicial, bloqueie o iPhone e deixe o Safari em segundo plano por pelo menos 10 minutos.</li>
        <li>Desbloqueie, volte a esta página e espere o resultado. Sem hidden persistido, ou com menos de 10 minutos, o cenário fica inconclusivo. Arme de novo para outro ciclo.</li>
        <li>Toque em Copiar JSON. O relatório não contém bytes nem dados pessoais.</li>
      </ol>
      <textarea readOnly value={JSON.stringify(report, null, 2)} style={reportStyle} />
    </main>
  )
}

const pageStyle = {
  fontFamily: 'system-ui, sans-serif',
  padding: '16px',
  maxWidth: '720px',
  margin: '0 auto',
  color: '#1c1915',
  background: '#f6f3ee',
  minHeight: '100vh',
}
const titleStyle = { fontSize: '22px', lineHeight: 1.3, margin: '0 0 12px' }
const textStyle = { fontSize: '16px', lineHeight: 1.45, margin: '0 0 12px' }
const statusStyle = { fontSize: '16px', fontWeight: 600, margin: '0 0 12px' }
const buttonRowStyle = { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }
const buttonStyle = { fontSize: '18px', padding: '14px 16px', borderRadius: '10px', border: '1px solid #8a7350', background: '#fff' }
const listStyle = { paddingLeft: '18px', margin: '0 0 16px' }
const itemStyle = { marginBottom: '10px' }
const reportStyle = { width: '100%', minHeight: '240px', fontFamily: 'ui-monospace, monospace', fontSize: '12px' }

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase as applicationSupabase } from '../lib/supabase'
import { PHOTO_UPLOAD_STATUSES } from '../lib/photoUploadDomain'
import { PHOTO_UPLOAD_RECORD_SCHEMA_VERSION, createPhotoUploadDb } from '../lib/photoUploadDb'
import { createPhotoUploadTransport } from '../lib/photoUploadTransport'
import { createPhotoUploadReconciler } from '../lib/photoUploadReconciler'
import { createPhotoUploadStore } from '../lib/photoUploadStore'

export const DRIVER_EVIDENCE_SOURCE_SURFACE = 'driver_evidence'
export const DRIVER_EVIDENCE_ENTITY_TYPE = 'job'
export const DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE = 'driver_portal'

export const DRIVER_EVIDENCE_MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})

export const DRIVER_EVIDENCE_QUEUE_ERROR_CODES = Object.freeze({
  DRIVER_ID_REQUIRED: 'DRIVER_ID_REQUIRED',
  JOB_ID_REQUIRED: 'JOB_ID_REQUIRED',
  UNSUPPORTED_MIME: 'UNSUPPORTED_MIME',
  QUEUE_WRITE_FAILED: 'QUEUE_WRITE_FAILED',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
})

export const DRIVER_DONE_OBSERVER_POLL_MS = 1000

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function isSupportedDriverEvidenceMime(mimeType) {
  return Object.prototype.hasOwnProperty.call(DRIVER_EVIDENCE_MIME_EXTENSIONS, mimeType)
}

export function buildDriverEvidenceStoragePath({ jobId, runType, queueId, mimeType }) {
  const ext = DRIVER_EVIDENCE_MIME_EXTENSIONS[mimeType]
  return `${jobId}/${runType}_${queueId}.${ext}`
}

export function buildDriverEvidenceQueueRecord({
  file,
  queueId,
  jobId,
  jobTable,
  crmsRef,
  eventName,
  runType,
  actorScopeId,
  driverName,
  nowMs,
}) {
  const mimeType = file.type
  const fileName = isNonEmptyString(file.name) ? file.name : `evidence.${DRIVER_EVIDENCE_MIME_EXTENSIONS[mimeType]}`
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: queueId,
    blob: file,
    file_name: fileName,
    mime_type: mimeType,
    file_size: file.size,
    source_surface: DRIVER_EVIDENCE_SOURCE_SURFACE,
    entity_type: DRIVER_EVIDENCE_ENTITY_TYPE,
    entity_id: jobId,
    provisional_id: null,
    actor_scope_type: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
    actor_scope_id: actorScopeId,
    run_type: runType,
    storage_path: buildDriverEvidenceStoragePath({
      jobId,
      runType,
      queueId,
      mimeType,
    }),
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
    bytes_total: file.size,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: {
      order_id: jobId,
      job_table: jobTable,
      crms_ref: crmsRef || null,
      event_name: eventName || null,
      run_type: runType,
      uploaded_by_name: driverName || 'Driver',
      driver_name: driverName || null,
    },
    lease_owner: null,
    lease_generation: 0,
    lease_expires_at: null,
    remote_reconciliation_status: null,
    remote_cleanup_attempt_count: 0,
    remote_cleanup_last_error: null,
    created_at: nowMs,
    updated_at: nowMs,
    completed_at: null,
  }
}

export async function resolveDriverSupabaseBearer(supabaseClient) {
  const result = await supabaseClient.auth.getSession()
  const session = result && result.data ? result.data.session : null
  if (session && isNonEmptyString(session.access_token)) {
    return session.access_token
  }
  if (supabaseClient && isNonEmptyString(supabaseClient.supabaseKey)) {
    return supabaseClient.supabaseKey
  }
  return null
}

function isDriverEvidenceActorRecord(record, actorId) {
  return Boolean(
    record
    && record.actor_scope_type === DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE
    && record.actor_scope_id === actorId
    && record.source_surface === DRIVER_EVIDENCE_SOURCE_SURFACE
    && isNonEmptyString(record.queue_id)
  )
}

function toRemoteDoneNotification(record) {
  return {
    queue_id: record.queue_id,
    entity_id: record.entity_id,
    status: record.status,
  }
}

export function createDriverPhotoUploadQueueController(options = {}) {
  const supabaseClient = options.supabaseClient || applicationSupabase
  const createDb = options.createDb || createPhotoUploadDb
  const createTransport = options.createTransport || createPhotoUploadTransport
  const createReconciler = options.createReconciler || createPhotoUploadReconciler
  const createStore = options.createStore || createPhotoUploadStore
  const now = typeof options.now === 'function' ? options.now : Date.now
  const randomUUID = typeof options.randomUUID === 'function'
    ? options.randomUUID
    : () => crypto.randomUUID()
  const createLeaseOwner = typeof options.createLeaseOwner === 'function'
    ? options.createLeaseOwner
    : () => crypto.randomUUID()
  const isOnline = typeof options.isOnline === 'function'
    ? options.isOnline
    : () => (typeof navigator === 'undefined' || navigator.onLine !== false)
  const setTimeoutImpl = typeof options.setTimeoutImpl === 'function'
    ? options.setTimeoutImpl
    : setTimeout
  const clearTimeoutImpl = typeof options.clearTimeoutImpl === 'function'
    ? options.clearTimeoutImpl
    : clearTimeout
  const onRemoteDone = typeof options.onRemoteDone === 'function'
    ? options.onRemoteDone
    : null

  let db = null
  let store = null
  let stopped = false
  let constructionError = null
  const leaseOwner = createLeaseOwner()
  let actorScopeId = null
  const pendingObservation = new Set()
  const notifiedDone = new Set()
  let pollTimer = null
  let inspectInFlight = false

  async function getAccessToken() {
    return resolveDriverSupabaseBearer(supabaseClient)
  }

  function ensureDb() {
    if (constructionError) {
      throw constructionError
    }
    if (!db) {
      try {
        db = createDb()
      } catch (error) {
        constructionError = error
        throw error
      }
    }
    return db
  }

  function cancelObserverTimer() {
    if (pollTimer == null) {
      return
    }
    clearTimeoutImpl(pollTimer)
    pollTimer = null
  }

  function scheduleObserver() {
    if (stopped || pendingObservation.size === 0) {
      cancelObserverTimer()
      return
    }
    if (pollTimer != null || inspectInFlight) {
      return
    }
    pollTimer = setTimeoutImpl(() => {
      pollTimer = null
      void inspectPending()
    }, DRIVER_DONE_OBSERVER_POLL_MS)
  }

  function emitRemoteDone(record) {
    if (stopped || typeof onRemoteDone !== 'function') {
      return
    }
    onRemoteDone(toRemoteDoneNotification(record))
  }

  async function inspectPending() {
    if (stopped || inspectInFlight) {
      return
    }
    if (pendingObservation.size === 0) {
      cancelObserverTimer()
      return
    }
    inspectInFlight = true
    try {
      const handle = db
      const actorId = actorScopeId
      if (!handle || !actorId || typeof handle.getRecord !== 'function') {
        return
      }
      const queueIds = Array.from(pendingObservation)
      for (const queueId of queueIds) {
        if (stopped) {
          return
        }
        let record = null
        try {
          record = await handle.getRecord({
            queueId,
            actorScopeType: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
            actorScopeId: actorId,
          })
        } catch (_error) {
          continue
        }
        if (!record) {
          continue
        }
        if (!isDriverEvidenceActorRecord(record, actorId)) {
          pendingObservation.delete(queueId)
          continue
        }
        if (record.status !== PHOTO_UPLOAD_STATUSES.DONE) {
          continue
        }
        pendingObservation.delete(queueId)
        if (notifiedDone.has(queueId)) {
          continue
        }
        notifiedDone.add(queueId)
        emitRemoteDone(record)
      }
    } finally {
      inspectInFlight = false
      if (!stopped && pendingObservation.size > 0) {
        scheduleObserver()
      } else {
        cancelObserverTimer()
      }
    }
  }

  async function seedPendingFromExisting(driverId) {
    const handle = db
    if (!handle || typeof handle.listRecordsForActor !== 'function') {
      return
    }
    let records
    try {
      records = await handle.listRecordsForActor({
        actorScopeType: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
        actorScopeId: driverId,
      })
    } catch (_error) {
      return
    }
    for (const record of Array.isArray(records) ? records : []) {
      if (!isDriverEvidenceActorRecord(record, driverId)) {
        continue
      }
      if (record.status === PHOTO_UPLOAD_STATUSES.DONE) {
        notifiedDone.add(record.queue_id)
        continue
      }
      pendingObservation.add(record.queue_id)
    }
  }

  async function startRuntime(nextDriverId) {
    if (stopped) {
      return
    }
    if (!isNonEmptyString(nextDriverId)) {
      return
    }
    ensureDb()
    if (store && actorScopeId && actorScopeId !== nextDriverId) {
      if (typeof store.stop === 'function') {
        await store.stop()
      }
      store = null
      actorScopeId = null
      pendingObservation.clear()
      notifiedDone.clear()
      cancelObserverTimer()
    }
    if (!store) {
      try {
        const transport = createTransport()
        const reconciler = createReconciler({ supabaseClient })
        store = createStore({
          db,
          transport,
          reconciler,
          actorScopeType: DRIVER_EVIDENCE_ACTOR_SCOPE_TYPE,
          actorScopeId: nextDriverId,
          leaseOwner,
          getAccessToken,
          isOnline,
          now,
        })
        actorScopeId = nextDriverId
      } catch (error) {
        constructionError = error
        throw error
      }
    }
    return store.start()
  }

  async function boot({ driverId } = {}) {
    if (stopped) {
      return
    }
    if (!isNonEmptyString(driverId)) {
      return
    }
    await startRuntime(driverId)
    await seedPendingFromExisting(driverId)
    await inspectPending()
  }

  async function enqueueFiles({
    files,
    driverId,
    jobId,
    jobTable = 'crms_jobs',
    crmsRef,
    eventName,
    runType,
    driverName,
  }) {
    const list = Array.from(files || [])
    const accepted = []
    const rejected = []

    if (constructionError) {
      return {
        accepted,
        rejected: list.map((file) => ({
          fileName: file && file.name,
          code: DRIVER_EVIDENCE_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
        })),
      }
    }

    if (!isNonEmptyString(driverId)) {
      return {
        accepted,
        rejected: list.map((file) => ({
          fileName: file && file.name,
          code: DRIVER_EVIDENCE_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED,
        })),
      }
    }

    if (!isNonEmptyString(jobId)) {
      return {
        accepted,
        rejected: list.map((file) => ({
          fileName: file && file.name,
          code: DRIVER_EVIDENCE_QUEUE_ERROR_CODES.JOB_ID_REQUIRED,
        })),
      }
    }

    let handle
    try {
      handle = ensureDb()
    } catch (_error) {
      return {
        accepted,
        rejected: list.map((file) => ({
          fileName: file && file.name,
          code: DRIVER_EVIDENCE_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
        })),
      }
    }

    for (const file of list) {
      const mimeType = file && file.type
      if (!isSupportedDriverEvidenceMime(mimeType)) {
        rejected.push({
          fileName: file && file.name,
          code: DRIVER_EVIDENCE_QUEUE_ERROR_CODES.UNSUPPORTED_MIME,
        })
        continue
      }
      const queueId = randomUUID()
      const record = buildDriverEvidenceQueueRecord({
        file,
        queueId,
        jobId,
        jobTable,
        crmsRef,
        eventName,
        runType,
        actorScopeId: driverId,
        driverName,
        nowMs: now(),
      })
      try {
        await handle.putRecord(record)
        pendingObservation.add(record.queue_id)
        accepted.push({
          queueId: record.queue_id,
          storagePath: record.storage_path,
          fileName: record.file_name,
        })
      } catch (_error) {
        rejected.push({
          fileName: record.file_name,
          code: DRIVER_EVIDENCE_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED,
        })
      }
    }

    if (accepted.length > 0) {
      try {
        await startRuntime(driverId)
      } catch (_error) {
        await inspectPending()
        return { accepted, rejected }
      }
      await inspectPending()
    }

    return { accepted, rejected }
  }

  async function dispose() {
    stopped = true
    cancelObserverTimer()
    pendingObservation.clear()
    if (store && typeof store.stop === 'function') {
      await store.stop()
    }
    store = null
    actorScopeId = null
    if (db && typeof db.close === 'function') {
      await db.close()
    }
    db = null
  }

  return {
    boot,
    enqueueFiles,
    dispose,
    inspectPending,
    getAccessToken,
    getLeaseOwner: () => leaseOwner,
    getActorScopeId: () => actorScopeId,
    getPendingObservationQueueIds: () => Array.from(pendingObservation),
    getObserverTimerPending: () => pollTimer != null,
  }
}

export function useDriverPhotoUploadQueue({
  driverId,
  jobId,
  jobTable = 'crms_jobs',
  crmsRef,
  eventName,
  runType,
  driverName,
  onRemoteDone,
  supabaseClient,
  createDb,
  createTransport,
  createReconciler,
  createStore,
  now,
  randomUUID,
  createLeaseOwner,
  isOnline,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  const controllerRef = useRef(null)
  const onRemoteDoneRef = useRef(onRemoteDone)
  onRemoteDoneRef.current = onRemoteDone
  const [busy, setBusy] = useState(false)
  const [lastResult, setLastResult] = useState(null)

  useEffect(() => {
    if (!isNonEmptyString(driverId)) {
      controllerRef.current = null
      return undefined
    }
    const controller = createDriverPhotoUploadQueueController({
      supabaseClient,
      createDb,
      createTransport,
      createReconciler,
      createStore,
      now,
      randomUUID,
      createLeaseOwner,
      isOnline,
      setTimeoutImpl,
      clearTimeoutImpl,
      onRemoteDone: (payload) => {
        if (typeof onRemoteDoneRef.current === 'function') {
          onRemoteDoneRef.current(payload)
        }
      },
    })
    controllerRef.current = controller
    void controller.boot({ driverId })
    return () => {
      void controller.dispose()
      controllerRef.current = null
    }
  }, [
    driverId,
    supabaseClient,
    createDb,
    createTransport,
    createReconciler,
    createStore,
    now,
    randomUUID,
    createLeaseOwner,
    isOnline,
    setTimeoutImpl,
    clearTimeoutImpl,
  ])

  const enqueueFiles = useCallback(async (files) => {
    const controller = controllerRef.current
    if (!controller) {
      const rejected = Array.from(files || []).map((file) => ({
        fileName: file && file.name,
        code: isNonEmptyString(driverId)
          ? DRIVER_EVIDENCE_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE
          : DRIVER_EVIDENCE_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED,
      }))
      const result = { accepted: [], rejected }
      setLastResult(result)
      return result
    }
    setBusy(true)
    try {
      const result = await controller.enqueueFiles({
        files,
        driverId,
        jobId,
        jobTable,
        crmsRef,
        eventName,
        runType,
        driverName,
      })
      setLastResult(result)
      return result
    } finally {
      setBusy(false)
    }
  }, [driverId, jobId, jobTable, crmsRef, eventName, runType, driverName])

  return {
    enqueueFiles,
    busy,
    lastResult,
  }
}

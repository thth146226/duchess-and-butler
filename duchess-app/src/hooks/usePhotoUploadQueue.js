import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase as applicationSupabase } from '../lib/supabase'
import { PHOTO_UPLOAD_STATUSES } from '../lib/photoUploadDomain'
import { PHOTO_UPLOAD_RECORD_SCHEMA_VERSION, createPhotoUploadDb } from '../lib/photoUploadDb'
import { createPhotoUploadTransport } from '../lib/photoUploadTransport'
import { createPhotoUploadReconciler } from '../lib/photoUploadReconciler'
import { createPhotoUploadStore } from '../lib/photoUploadStore'

export const OFFICE_EVIDENCE_SOURCE_SURFACE = 'office_evidence'
export const OFFICE_EVIDENCE_ENTITY_TYPE = 'job'
export const OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE = 'office_user'

export const OFFICE_EVIDENCE_MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})

export const OFFICE_EVIDENCE_QUEUE_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  JOB_ID_REQUIRED: 'JOB_ID_REQUIRED',
  UNSUPPORTED_MIME: 'UNSUPPORTED_MIME',
  QUEUE_WRITE_FAILED: 'QUEUE_WRITE_FAILED',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
})

export const DONE_OBSERVER_POLL_MS = 1000

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function isSupportedOfficeEvidenceMime(mimeType) {
  return Object.prototype.hasOwnProperty.call(OFFICE_EVIDENCE_MIME_EXTENSIONS, mimeType)
}

export function buildOfficeEvidenceStoragePath({ jobId, runType, queueId, mimeType }) {
  const ext = OFFICE_EVIDENCE_MIME_EXTENSIONS[mimeType]
  return `${jobId}/${runType}_${queueId}.${ext}`
}

export function buildOfficeEvidenceQueueRecord({
  file,
  queueId,
  jobId,
  jobTable,
  crmsRef,
  eventName,
  runType,
  actorScopeId,
  profile,
  nowMs,
}) {
  const mimeType = file.type
  const fileName = isNonEmptyString(file.name) ? file.name : `evidence.${OFFICE_EVIDENCE_MIME_EXTENSIONS[mimeType]}`
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: queueId,
    blob: file,
    file_name: fileName,
    mime_type: mimeType,
    file_size: file.size,
    source_surface: OFFICE_EVIDENCE_SOURCE_SURFACE,
    entity_type: OFFICE_EVIDENCE_ENTITY_TYPE,
    entity_id: jobId,
    provisional_id: null,
    actor_scope_type: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
    actor_scope_id: actorScopeId,
    run_type: runType,
    storage_path: buildOfficeEvidenceStoragePath({
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
      uploaded_by: (profile && profile.id) || null,
      uploaded_by_name: (profile && profile.name) || 'Team',
      driver_name: (profile && profile.name) || null,
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

async function readSessionUserAndToken(supabaseClient) {
  const result = await supabaseClient.auth.getSession()
  const session = result && result.data ? result.data.session : null
  const userId = session && session.user && isNonEmptyString(session.user.id) ? session.user.id : null
  const accessToken = session && isNonEmptyString(session.access_token) ? session.access_token : null
  return { userId, accessToken }
}

function isOfficeEvidenceActorRecord(record, actorId) {
  return Boolean(
    record
    && record.actor_scope_type === OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE
    && record.actor_scope_id === actorId
    && record.source_surface === OFFICE_EVIDENCE_SOURCE_SURFACE
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

export function createPhotoUploadQueueController(options = {}) {
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
  let envWakeCleanup = null

  async function resolveActorId() {
    const { userId } = await readSessionUserAndToken(supabaseClient)
    return userId
  }

  async function getAccessToken() {
    const { accessToken } = await readSessionUserAndToken(supabaseClient)
    return accessToken
  }

  function environmentIsPlausiblyUsable() {
    try {
      if (typeof isOnline === 'function' && isOnline() === false) {
        return false
      }
    } catch (_error) {
      return false
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false
    }
    return true
  }

  async function requestResumePausedUploads() {
    if (stopped) {
      return
    }
    try {
      if (!environmentIsPlausiblyUsable()) {
        return
      }
      if (!store || typeof store.resumePausedUploads !== 'function') {
        return
      }
      const currentUserId = await resolveActorId()
      if (!isNonEmptyString(currentUserId) || currentUserId !== actorScopeId) {
        return
      }
      const token = await getAccessToken()
      if (!isNonEmptyString(token)) {
        return
      }
      await store.resumePausedUploads()
    } catch (_error) {
      return
    }
  }

  function attachEnvironmentalWake() {
    if (stopped || envWakeCleanup) {
      return
    }
    const cleanups = []
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onOnline = () => {
        void requestResumePausedUploads()
      }
      window.addEventListener('online', onOnline)
      cleanups.push(() => {
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('online', onOnline)
        }
      })
    }
    const auth = supabaseClient && supabaseClient.auth
    if (auth && typeof auth.onAuthStateChange === 'function') {
      try {
        const result = auth.onAuthStateChange(() => {
          void requestResumePausedUploads()
        })
        const subscription = result && result.data ? result.data.subscription : null
        if (subscription && typeof subscription.unsubscribe === 'function') {
          cleanups.push(() => {
            subscription.unsubscribe()
          })
        }
      } catch (_error) {
        // existing client does not support auth wake
      }
    }
    envWakeCleanup = () => {
      for (const fn of cleanups) {
        try {
          fn()
        } catch (_cleanupError) {
          // ignore
        }
      }
      envWakeCleanup = null
    }
  }

  function detachEnvironmentalWake() {
    if (typeof envWakeCleanup === 'function') {
      envWakeCleanup()
    }
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
    }, DONE_OBSERVER_POLL_MS)
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
      const actorId = actorScopeId || await resolveActorId()
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
            actorScopeType: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
            actorScopeId: actorId,
          })
        } catch (_error) {
          continue
        }
        if (!record) {
          continue
        }
        if (!isOfficeEvidenceActorRecord(record, actorId)) {
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

  async function seedPendingFromExisting(userId) {
    const handle = db
    if (!handle || typeof handle.listRecordsForActor !== 'function') {
      return
    }
    let records
    try {
      records = await handle.listRecordsForActor({
        actorScopeType: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
        actorScopeId: userId,
      })
    } catch (_error) {
      return
    }
    for (const record of Array.isArray(records) ? records : []) {
      if (!isOfficeEvidenceActorRecord(record, userId)) {
        continue
      }
      if (record.status === PHOTO_UPLOAD_STATUSES.DONE) {
        notifiedDone.add(record.queue_id)
        continue
      }
      pendingObservation.add(record.queue_id)
    }
  }

  async function startRuntime(nextActorId) {
    if (stopped) {
      return
    }
    ensureDb()
    if (!store) {
      try {
        const transport = createTransport()
        const reconciler = createReconciler({ supabaseClient })
        store = createStore({
          db,
          transport,
          reconciler,
          actorScopeType: OFFICE_EVIDENCE_ACTOR_SCOPE_TYPE,
          actorScopeId: nextActorId,
          leaseOwner,
          getAccessToken,
          isOnline,
          now,
        })
        actorScopeId = nextActorId
      } catch (error) {
        constructionError = error
        throw error
      }
    }
    return store.start()
  }

  async function boot() {
    if (stopped) {
      return
    }
    const userId = await resolveActorId()
    if (!userId) {
      return
    }
    await startRuntime(userId)
    attachEnvironmentalWake()
    await requestResumePausedUploads()
    await seedPendingFromExisting(userId)
    await inspectPending()
  }

  async function enqueueFiles({
    files,
    jobId,
    jobTable = 'crms_jobs',
    crmsRef,
    eventName,
    runType,
    profile,
  }) {
    const list = Array.from(files || [])
    const accepted = []
    const rejected = []

    if (constructionError) {
      return {
        accepted,
        rejected: list.map((file) => ({
          fileName: file && file.name,
          code: OFFICE_EVIDENCE_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
        })),
      }
    }

    if (!isNonEmptyString(jobId)) {
      return {
        accepted,
        rejected: list.map((file) => ({
          fileName: file && file.name,
          code: OFFICE_EVIDENCE_QUEUE_ERROR_CODES.JOB_ID_REQUIRED,
        })),
      }
    }

    const userId = await resolveActorId()
    if (!userId) {
      return {
        accepted,
        rejected: list.map((file) => ({
          fileName: file && file.name,
          code: OFFICE_EVIDENCE_QUEUE_ERROR_CODES.AUTH_REQUIRED,
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
          code: OFFICE_EVIDENCE_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
        })),
      }
    }

    for (const file of list) {
      const mimeType = file && file.type
      if (!isSupportedOfficeEvidenceMime(mimeType)) {
        rejected.push({
          fileName: file && file.name,
          code: OFFICE_EVIDENCE_QUEUE_ERROR_CODES.UNSUPPORTED_MIME,
        })
        continue
      }
      const queueId = randomUUID()
      const record = buildOfficeEvidenceQueueRecord({
        file,
        queueId,
        jobId,
        jobTable,
        crmsRef,
        eventName,
        runType,
        actorScopeId: userId,
        profile,
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
          code: OFFICE_EVIDENCE_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED,
        })
      }
    }

    if (accepted.length > 0) {
      try {
        await startRuntime(userId)
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
    detachEnvironmentalWake()
    cancelObserverTimer()
    pendingObservation.clear()
    if (store && typeof store.stop === 'function') {
      await store.stop()
    }
    store = null
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

export function usePhotoUploadQueue({
  jobId,
  jobTable = 'crms_jobs',
  crmsRef,
  eventName,
  runType,
  profile,
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
    const controller = createPhotoUploadQueueController({
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
    void controller.boot()
    return () => {
      void controller.dispose()
      controllerRef.current = null
    }
  }, [
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
        code: OFFICE_EVIDENCE_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }))
      const result = { accepted: [], rejected }
      setLastResult(result)
      return result
    }
    setBusy(true)
    try {
      const result = await controller.enqueueFiles({
        files,
        jobId,
        jobTable,
        crmsRef,
        eventName,
        runType,
        profile,
      })
      setLastResult(result)
      return result
    } finally {
      setBusy(false)
    }
  }, [jobId, jobTable, crmsRef, eventName, runType, profile])

  return {
    enqueueFiles,
    busy,
    lastResult,
  }
}

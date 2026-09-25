import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase as applicationSupabase } from '../lib/supabase'
import { PHOTO_UPLOAD_STATUSES } from '../lib/photoUploadDomain'
import { PHOTO_UPLOAD_RECORD_SCHEMA_VERSION, createPhotoUploadDb } from '../lib/photoUploadDb'
import {
  getPhotoUploadRuntimeStore,
  wakePhotoUploadRuntime,
} from '../lib/photoUploadRuntime'

export const OFFICE_REPORT_SOURCE_SURFACES = Object.freeze({
  OFFICE_REPORTS: 'office_reports',
  OFFICE_SCHEDULE_REPORT: 'office_schedule_report',
})

export const OFFICE_REPORT_ENTITY_TYPE = 'report'
export const OFFICE_REPORT_ACTOR_SCOPE_TYPE = 'office_user'
export const OFFICE_REPORT_PHOTO_RUN_TYPE = 'after_col'

export const OFFICE_REPORT_MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})

export const OFFICE_REPORT_QUEUE_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  REPORT_ID_REQUIRED: 'REPORT_ID_REQUIRED',
  QUEUE_ID_REQUIRED: 'QUEUE_ID_REQUIRED',
  INVALID_SOURCE_SURFACE: 'INVALID_SOURCE_SURFACE',
  UNSUPPORTED_MIME: 'UNSUPPORTED_MIME',
  QUEUE_WRITE_FAILED: 'QUEUE_WRITE_FAILED',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
})

export const OFFICE_REPORT_DONE_OBSERVER_POLL_MS = 1000

const EMPTY_QUEUE_RECORDS = []

const VALID_SOURCE_SURFACES = new Set(Object.values(OFFICE_REPORT_SOURCE_SURFACES))

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function isOfficeReportSourceSurface(value) {
  return VALID_SOURCE_SURFACES.has(value)
}

export function isSupportedOfficeReportMime(mimeType) {
  return Object.prototype.hasOwnProperty.call(OFFICE_REPORT_MIME_EXTENSIONS, mimeType)
}

export function buildOfficeReportStoragePath({ reportId, queueId, mimeType }) {
  const ext = OFFICE_REPORT_MIME_EXTENSIONS[mimeType]
  return `reports/${reportId}/${queueId}.${ext}`
}

export function buildOfficeReportMetadataPayload({
  reportId,
  crmsRef,
  eventName,
  uploadedByName,
}) {
  return {
    order_id: reportId,
    run_type: OFFICE_REPORT_PHOTO_RUN_TYPE,
    uploaded_by_name: uploadedByName || 'Admin',
    event_name: eventName || '',
    crms_ref: crmsRef || '',
  }
}

export function buildOfficeReportQueueRecord({
  file,
  queueId,
  sourceSurface,
  reportId,
  actorScopeId,
  crmsRef,
  eventName,
  uploadedByName,
  nowMs,
}) {
  const mimeType = file.type
  const fileName = isNonEmptyString(file.name)
    ? file.name
    : `report.${OFFICE_REPORT_MIME_EXTENSIONS[mimeType]}`
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: queueId,
    blob: file,
    file_name: fileName,
    mime_type: mimeType,
    file_size: file.size,
    source_surface: sourceSurface,
    entity_type: OFFICE_REPORT_ENTITY_TYPE,
    entity_id: reportId,
    provisional_id: null,
    actor_scope_type: OFFICE_REPORT_ACTOR_SCOPE_TYPE,
    actor_scope_id: actorScopeId,
    run_type: OFFICE_REPORT_PHOTO_RUN_TYPE,
    storage_path: buildOfficeReportStoragePath({ reportId, queueId, mimeType }),
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
    metadata_payload: buildOfficeReportMetadataPayload({
      reportId,
      crmsRef,
      eventName,
      uploadedByName,
    }),
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
  const userId = session && session.user && isNonEmptyString(session.user.id)
    ? session.user.id
    : null
  const accessToken = session && isNonEmptyString(session.access_token)
    ? session.access_token
    : null
  return { userId, accessToken }
}

function isOfficeReportActorRecord(record, actorId, sourceSurface) {
  return Boolean(
    record
    && record.actor_scope_type === OFFICE_REPORT_ACTOR_SCOPE_TYPE
    && record.actor_scope_id === actorId
    && record.source_surface === sourceSurface
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

export function createOfficeReportPhotoUploadQueueController(options = {}) {
  const supabaseClient = options.supabaseClient || applicationSupabase
  const createDb = options.createDb || createPhotoUploadDb
  const getRuntime = options.getRuntime
  const now = typeof options.now === 'function' ? options.now : Date.now
  const randomUUID = typeof options.randomUUID === 'function'
    ? options.randomUUID
    : () => crypto.randomUUID()
  const createLeaseOwner = typeof options.createLeaseOwner === 'function'
    ? options.createLeaseOwner
    : () => crypto.randomUUID()
  const setTimeoutImpl = typeof options.setTimeoutImpl === 'function'
    ? options.setTimeoutImpl
    : setTimeout
  const clearTimeoutImpl = typeof options.clearTimeoutImpl === 'function'
    ? options.clearTimeoutImpl
    : clearTimeout
  const onRemoteDone = typeof options.onRemoteDone === 'function'
    ? options.onRemoteDone
    : null
  const sourceSurface = options.sourceSurface

  let db = null
  let stopped = false
  let constructionError = null
  const leaseOwner = createLeaseOwner()
  let actorScopeId = null
  const pendingObservation = new Set()
  const notifiedDone = new Set()
  let pollTimer = null
  let inspectInFlight = false

  function sharedStore() {
    return getPhotoUploadRuntimeStore(
      OFFICE_REPORT_ACTOR_SCOPE_TYPE,
      actorScopeId,
      getRuntime,
    )
  }

  async function resolveActorId() {
    const { userId } = await readSessionUserAndToken(supabaseClient)
    return userId
  }

  async function getAccessToken() {
    const { accessToken } = await readSessionUserAndToken(supabaseClient)
    return accessToken
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
    }, OFFICE_REPORT_DONE_OBSERVER_POLL_MS)
  }

  function emitRemoteDone(record) {
    if (stopped || typeof onRemoteDone !== 'function') {
      return
    }
    if (record.status !== PHOTO_UPLOAD_STATUSES.DONE) {
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
            actorScopeType: OFFICE_REPORT_ACTOR_SCOPE_TYPE,
            actorScopeId: actorId,
          })
        } catch (_error) {
          continue
        }
        if (!record) {
          continue
        }
        if (!isOfficeReportActorRecord(record, actorId, sourceSurface)) {
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
        actorScopeType: OFFICE_REPORT_ACTOR_SCOPE_TYPE,
        actorScopeId: userId,
      })
    } catch (_error) {
      return
    }
    for (const record of Array.isArray(records) ? records : []) {
      if (!isOfficeReportActorRecord(record, userId, sourceSurface)) {
        continue
      }
      if (record.status === PHOTO_UPLOAD_STATUSES.DONE) {
        notifiedDone.add(record.queue_id)
        continue
      }
      pendingObservation.add(record.queue_id)
    }
  }

  async function boot() {
    if (stopped) {
      return
    }
    if (!isOfficeReportSourceSurface(sourceSurface)) {
      return
    }
    const userId = await resolveActorId()
    if (!userId) {
      return
    }
    actorScopeId = userId
    ensureDb()
    await seedPendingFromExisting(userId)
    await inspectPending()
  }

  function rejectAll(list, code) {
    return {
      accepted: [],
      rejected: list.map((file) => ({
        fileName: file && file.name,
        code,
      })),
    }
  }

  async function enqueueFiles({
    files,
    reportId,
    crmsRef,
    eventName,
    profile,
  }) {
    const list = Array.from(files || [])
    const accepted = []
    const rejected = []

    if (constructionError) {
      return rejectAll(list, OFFICE_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE)
    }

    if (!isOfficeReportSourceSurface(sourceSurface)) {
      return rejectAll(list, OFFICE_REPORT_QUEUE_ERROR_CODES.INVALID_SOURCE_SURFACE)
    }

    if (!isNonEmptyString(reportId)) {
      return rejectAll(list, OFFICE_REPORT_QUEUE_ERROR_CODES.REPORT_ID_REQUIRED)
    }

    const userId = await resolveActorId()
    if (!userId) {
      return rejectAll(list, OFFICE_REPORT_QUEUE_ERROR_CODES.AUTH_REQUIRED)
    }

    let handle
    try {
      handle = ensureDb()
    } catch (_error) {
      return rejectAll(list, OFFICE_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE)
    }

    const uploadedByName = (profile && profile.name) || 'Admin'

    for (const file of list) {
      const mimeType = file && file.type
      if (!isSupportedOfficeReportMime(mimeType)) {
        rejected.push({
          fileName: file && file.name,
          code: OFFICE_REPORT_QUEUE_ERROR_CODES.UNSUPPORTED_MIME,
        })
        continue
      }
      const queueId = randomUUID()
      const record = buildOfficeReportQueueRecord({
        file,
        queueId,
        sourceSurface,
        reportId,
        actorScopeId: userId,
        crmsRef,
        eventName,
        uploadedByName,
        nowMs: now(),
      })
      try {
        await handle.putRecord(record)
        pendingObservation.add(record.queue_id)
        accepted.push({
          queueId: record.queue_id,
          storagePath: record.storage_path,
          fileName: record.file_name,
          status: record.status,
        })
      } catch (_error) {
        rejected.push({
          fileName: record.file_name,
          code: OFFICE_REPORT_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED,
        })
      }
    }

    if (accepted.length > 0) {
      actorScopeId = userId
      await wakePhotoUploadRuntime(
        OFFICE_REPORT_ACTOR_SCOPE_TYPE,
        userId,
        getRuntime,
      )
      await inspectPending()
    }

    return { accepted, rejected }
  }

  async function dispose() {
    stopped = true
    cancelObserverTimer()
    pendingObservation.clear()
    actorScopeId = null
    if (db && typeof db.close === 'function') {
      await db.close()
    }
    db = null
  }

  async function manualUploadRetry({ queueId } = {}) {
    if (!isNonEmptyString(actorScopeId)) {
      return {
        ok: false,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.AUTH_REQUIRED,
      }
    }
    if (!isNonEmptyString(queueId)) {
      return {
        ok: false,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.QUEUE_ID_REQUIRED,
      }
    }
    const shared = sharedStore()
    if (!shared || typeof shared.manualUploadRetry !== 'function') {
      return {
        ok: false,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }
    return shared.manualUploadRetry({ queueId })
  }

  async function manualDbRetry({ queueId } = {}) {
    if (!isNonEmptyString(actorScopeId)) {
      return {
        ok: false,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.AUTH_REQUIRED,
      }
    }
    if (!isNonEmptyString(queueId)) {
      return {
        ok: false,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.QUEUE_ID_REQUIRED,
      }
    }
    const shared = sharedStore()
    if (!shared || typeof shared.manualDbRetry !== 'function') {
      return {
        ok: false,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }
    return shared.manualDbRetry({ queueId })
  }

  async function getQueueSnapshot({ sourceSurface, entityType, entityId } = {}) {
    if (!isNonEmptyString(actorScopeId)) {
      return { records: EMPTY_QUEUE_RECORDS }
    }
    if (!db || typeof db.listRecordsForActor !== 'function') {
      return { records: EMPTY_QUEUE_RECORDS }
    }
    let records
    try {
      records = await db.listRecordsForActor({
        actorScopeType: OFFICE_REPORT_ACTOR_SCOPE_TYPE,
        actorScopeId,
      })
    } catch (_error) {
      return { records: EMPTY_QUEUE_RECORDS }
    }
    const filtered = (Array.isArray(records) ? records : []).filter((record) => (
      record
      && record.actor_scope_type === OFFICE_REPORT_ACTOR_SCOPE_TYPE
      && record.actor_scope_id === actorScopeId
      && record.status !== PHOTO_UPLOAD_STATUSES.DONE
      && record.status !== PHOTO_UPLOAD_STATUSES.DISCARD_PENDING
      && (!isNonEmptyString(sourceSurface) || record.source_surface === sourceSurface)
      && (!isNonEmptyString(entityType) || record.entity_type === entityType)
      && (!isNonEmptyString(entityId) || record.entity_id === entityId)
    ))
    return {
      records: filtered.length > 0
        ? filtered.map((record) => ({
          queue_id: record.queue_id,
          status: record.status,
          progress_pct: record.status === PHOTO_UPLOAD_STATUSES.UPLOADING
            ? (record.bytes_total > 0 ? Math.round((record.bytes_uploaded / record.bytes_total) * 100) : 0)
            : 0,
          source_surface: record.source_surface,
          entity_type: record.entity_type,
          entity_id: record.entity_id,
          provisional_id: record.provisional_id,
          created_at: record.created_at,
        }))
        : EMPTY_QUEUE_RECORDS,
    }
  }

  return {
    boot,
    enqueueFiles,
    dispose,
    inspectPending,
    manualUploadRetry,
    manualDbRetry,
    getQueueSnapshot,
    getAccessToken,
    getLeaseOwner: () => leaseOwner,
    getActorScopeId: () => actorScopeId,
    getPendingObservationQueueIds: () => Array.from(pendingObservation),
    getObserverTimerPending: () => pollTimer != null,
  }
}

export function useOfficeReportPhotoUploadQueue({
  sourceSurface,
  reportId,
  crmsRef,
  eventName,
  profile,
  onRemoteDone,
  supabaseClient,
  createDb,
  createTransport,
  createReconciler,
  createStore, getRuntime,
  now,
  randomUUID,
  createLeaseOwner,
  isOnline,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  const controllerRef = useRef(null)
  const bootPromiseRef = useRef(null)
  const onRemoteDoneRef = useRef(onRemoteDone)
  onRemoteDoneRef.current = onRemoteDone
  const [busy, setBusy] = useState(false)
  const [lastResult, setLastResult] = useState(null)
  const [queueRecords, setQueueRecords] = useState(EMPTY_QUEUE_RECORDS)

  const snapshotFilter = useMemo(() => ({
    sourceSurface,
    entityType: OFFICE_REPORT_ENTITY_TYPE,
    entityId: reportId,
  }), [sourceSurface, reportId])

  useEffect(() => {
    const controller = createOfficeReportPhotoUploadQueueController({
      sourceSurface,
      supabaseClient,
      createDb,
      createTransport,
      createReconciler,
      createStore, getRuntime,
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
    bootPromiseRef.current = controller.boot()
    return () => {
      void controller.dispose()
      controllerRef.current = null
      bootPromiseRef.current = null
    }
  }, [
    sourceSurface,
    supabaseClient,
    createDb,
    createTransport,
    createReconciler,
    createStore, getRuntime,
    now,
    randomUUID,
    createLeaseOwner,
    isOnline,
    setTimeoutImpl,
    clearTimeoutImpl,
  ])

  useEffect(() => {
    let cancelled = false
    let timer = null
    async function tick() {
      if (cancelled) return
      const controller = controllerRef.current
      if (controller && typeof controller.getQueueSnapshot === 'function') {
        const snapshot = await controller.getQueueSnapshot(snapshotFilter)
        if (!cancelled) {
          setQueueRecords(snapshot.records || EMPTY_QUEUE_RECORDS)
        }
      }
      if (!cancelled) {
        timer = setTimeout(tick, 1000)
      }
    }
    async function start() {
      const bootPromise = bootPromiseRef.current
      if (!bootPromise) return
      try {
        await bootPromise
      } catch (_error) {
        return
      }
      if (cancelled) return
      tick()
    }
    start()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      setQueueRecords(EMPTY_QUEUE_RECORDS)
    }
  }, [snapshotFilter])

  const enqueueFiles = useCallback(async (files) => {
    const controller = controllerRef.current
    if (!controller) {
      const rejected = Array.from(files || []).map((file) => ({
        fileName: file && file.name,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }))
      const result = { accepted: [], rejected }
      setLastResult(result)
      return result
    }
    setBusy(true)
    try {
      const result = await controller.enqueueFiles({
        files,
        reportId,
        crmsRef,
        eventName,
        profile,
      })
      setLastResult(result)
      const snapshot = await controller.getQueueSnapshot(snapshotFilter)
      setQueueRecords(snapshot.records || EMPTY_QUEUE_RECORDS)
      return result
    } finally {
      setBusy(false)
    }
  }, [reportId, crmsRef, eventName, profile, snapshotFilter])

  const manualUploadRetry = useCallback(async (queueId) => {
    const controller = controllerRef.current
    if (!controller) {
      return {
        ok: false,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }
    const result = await controller.manualUploadRetry({ queueId })
    const snapshot = await controller.getQueueSnapshot(snapshotFilter)
    setQueueRecords(snapshot.records || EMPTY_QUEUE_RECORDS)
    return result
  }, [snapshotFilter])

  const manualDbRetry = useCallback(async (queueId) => {
    const controller = controllerRef.current
    if (!controller) {
      return {
        ok: false,
        code: OFFICE_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }
    const result = await controller.manualDbRetry({ queueId })
    const snapshot = await controller.getQueueSnapshot(snapshotFilter)
    setQueueRecords(snapshot.records || EMPTY_QUEUE_RECORDS)
    return result
  }, [snapshotFilter])

  return {
    enqueueFiles,
    manualUploadRetry,
    manualDbRetry,
    queueRecords,
    busy,
    lastResult,
  }
}

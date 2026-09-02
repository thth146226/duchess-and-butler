import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase as applicationSupabase } from '../lib/supabase'
import { PHOTO_UPLOAD_EVENTS, PHOTO_UPLOAD_STATUSES, transitionPhotoUpload } from '../lib/photoUploadDomain'
import { PHOTO_UPLOAD_RECORD_SCHEMA_VERSION, createPhotoUploadDb } from '../lib/photoUploadDb'
import { createPhotoUploadTransport } from '../lib/photoUploadTransport'
import { createPhotoUploadReconciler } from '../lib/photoUploadReconciler'
import { createPhotoUploadStore } from '../lib/photoUploadStore'
import { resolveDriverSupabaseBearer } from './useDriverPhotoUploadQueue'

export const DRIVER_REPORT_SOURCE_SURFACES = Object.freeze({
  DRIVER_REPORT_MODE: 'driver_report_mode',
  DRIVER_REPORT_TAB: 'driver_report_tab',
})

export const DRIVER_REPORT_ENTITY_TYPE = 'report'
export const DRIVER_REPORT_ACTOR_SCOPE_TYPE = 'driver_portal'
export const DRIVER_REPORT_PHOTO_RUN_TYPE = 'after_col'

export const DRIVER_REPORT_MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})

export const DRIVER_REPORT_QUEUE_ERROR_CODES = Object.freeze({
  DRIVER_ID_REQUIRED: 'DRIVER_ID_REQUIRED',
  REPORT_ID_REQUIRED: 'REPORT_ID_REQUIRED',
  PROVISIONAL_ID_REQUIRED: 'PROVISIONAL_ID_REQUIRED',
  INVALID_SOURCE_SURFACE: 'INVALID_SOURCE_SURFACE',
  UNSUPPORTED_MIME: 'UNSUPPORTED_MIME',
  QUEUE_WRITE_FAILED: 'QUEUE_WRITE_FAILED',
  LINK_WRITE_FAILED: 'LINK_WRITE_FAILED',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  UNSAFE_COMPOSITION: 'UNSAFE_COMPOSITION',
})

export const DRIVER_REPORT_DONE_OBSERVER_POLL_MS = 1000

const VALID_SOURCE_SURFACES = new Set(Object.values(DRIVER_REPORT_SOURCE_SURFACES))
const LINKABLE_STATUSES = new Set([
  PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED,
  PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN,
])

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function isDriverReportSourceSurface(value) {
  return VALID_SOURCE_SURFACES.has(value)
}

export function isSupportedDriverReportMime(mimeType) {
  return Object.prototype.hasOwnProperty.call(DRIVER_REPORT_MIME_EXTENSIONS, mimeType)
}

export function buildDriverReportStoragePath({ reportId, queueId, mimeType }) {
  const ext = DRIVER_REPORT_MIME_EXTENSIONS[mimeType]
  return `reports/${reportId}/${queueId}.${ext}`
}

export function buildDriverReportMetadataPayload({
  reportId,
  crmsRef,
  eventName,
  uploadedByName,
  includeCrmsRef,
}) {
  const payload = {
    run_type: DRIVER_REPORT_PHOTO_RUN_TYPE,
    uploaded_by_name: uploadedByName || 'Driver',
    event_name: eventName || '',
  }
  if (isNonEmptyString(reportId)) {
    payload.order_id = reportId
  }
  if (includeCrmsRef) {
    payload.crms_ref = crmsRef || ''
  }
  return payload
}

export function buildDriverReportQueueRecord({
  file,
  queueId,
  sourceSurface,
  reportId,
  provisionalId,
  actorScopeId,
  crmsRef,
  eventName,
  uploadedByName,
  nowMs,
}) {
  const mimeType = file.type
  const fileName = isNonEmptyString(file.name)
    ? file.name
    : `report.${DRIVER_REPORT_MIME_EXTENSIONS[mimeType]}`
  const isDraft = !isNonEmptyString(reportId)
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: queueId,
    blob: file,
    file_name: fileName,
    mime_type: mimeType,
    file_size: file.size,
    source_surface: sourceSurface,
    entity_type: DRIVER_REPORT_ENTITY_TYPE,
    entity_id: isDraft ? null : reportId,
    provisional_id: isDraft ? provisionalId : null,
    actor_scope_type: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
    actor_scope_id: actorScopeId,
    run_type: DRIVER_REPORT_PHOTO_RUN_TYPE,
    storage_path: isDraft
      ? null
      : buildDriverReportStoragePath({ reportId, queueId, mimeType }),
    status: isDraft ? PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED : PHOTO_UPLOAD_STATUSES.QUEUED,
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
    metadata_payload: buildDriverReportMetadataPayload({
      reportId: isDraft ? null : reportId,
      crmsRef,
      eventName,
      uploadedByName,
      includeCrmsRef: sourceSurface === DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
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

function isDriverReportActorRecord(record, actorId, sourceSurface) {
  return Boolean(
    record
    && record.actor_scope_type === DRIVER_REPORT_ACTOR_SCOPE_TYPE
    && record.actor_scope_id === actorId
    && record.source_surface === sourceSurface
    && isNonEmptyString(record.queue_id)
  )
}

function isNeverUploadedReportModeDraft(record, provisionalId) {
  return Boolean(
    record
    && record.source_surface === DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE
    && record.provisional_id === provisionalId
    && record.status === PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED
    && record.entity_id == null
    && record.storage_path == null
    && record.upload_attempt_count === 0
    && record.tus_upload_url == null
    && record.remote_public_url == null
    && record.db_row_id == null
  )
}

function toRemoteDoneNotification(record) {
  return {
    queue_id: record.queue_id,
    entity_id: record.entity_id,
    status: record.status,
  }
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

export function createDriverReportPhotoUploadQueueController(options = {}) {
  const supabaseClient = options.supabaseClient || applicationSupabase
  const createDb = options.createDb || createPhotoUploadDb
  const createTransport = options.createTransport || createPhotoUploadTransport
  const createReconciler = options.createReconciler || createPhotoUploadReconciler
  const createStore = options.createStore || createPhotoUploadStore
  const now = typeof options.now === 'function' ? options.now : Date.now
  const randomUUID = typeof options.randomUUID === 'function'
    ? options.randomUUID
    : () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `qid-${now()}`)
  const createLeaseOwner = typeof options.createLeaseOwner === 'function'
    ? options.createLeaseOwner
    : () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `lease-${now()}`)
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
  const sourceSurface = options.sourceSurface

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

  async function getAccessToken() {
    return resolveDriverSupabaseBearer(supabaseClient)
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
      if (!isNonEmptyString(actorScopeId)) {
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
    }, DRIVER_REPORT_DONE_OBSERVER_POLL_MS)
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
            actorScopeType: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
            actorScopeId: actorId,
          })
        } catch (_error) {
          continue
        }
        if (!record) {
          continue
        }
        if (!isDriverReportActorRecord(record, actorId, sourceSurface)) {
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
        actorScopeType: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
        actorScopeId: driverId,
      })
    } catch (_error) {
      return
    }
    for (const record of Array.isArray(records) ? records : []) {
      if (!isDriverReportActorRecord(record, driverId, sourceSurface)) {
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
          actorScopeType: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
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
    if (!isDriverReportSourceSurface(sourceSurface)) {
      return
    }
    if (!isNonEmptyString(driverId)) {
      return
    }
    await startRuntime(driverId)
    attachEnvironmentalWake()
    await requestResumePausedUploads()
    await seedPendingFromExisting(driverId)
    await inspectPending()
  }

  async function enqueueFiles({
    files,
    driverId,
    reportId,
    provisionalId,
    crmsRef,
    eventName,
    driverName,
  }) {
    const list = Array.from(files || [])
    const accepted = []
    const rejected = []

    if (constructionError) {
      return rejectAll(list, DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE)
    }

    if (!isDriverReportSourceSurface(sourceSurface)) {
      return rejectAll(list, DRIVER_REPORT_QUEUE_ERROR_CODES.INVALID_SOURCE_SURFACE)
    }

    if (!isNonEmptyString(driverId)) {
      return rejectAll(list, DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED)
    }

    const isModeA = sourceSurface === DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_TAB
    if (isModeA && !isNonEmptyString(reportId)) {
      return rejectAll(list, DRIVER_REPORT_QUEUE_ERROR_CODES.REPORT_ID_REQUIRED)
    }
    if (!isModeA && !isNonEmptyString(provisionalId)) {
      return rejectAll(list, DRIVER_REPORT_QUEUE_ERROR_CODES.PROVISIONAL_ID_REQUIRED)
    }

    let handle
    try {
      handle = ensureDb()
    } catch (_error) {
      return rejectAll(list, DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE)
    }

    const uploadedByName = driverName || 'Driver'

    for (const file of list) {
      const mimeType = file && file.type
      if (!isSupportedDriverReportMime(mimeType)) {
        rejected.push({
          fileName: file && file.name,
          code: DRIVER_REPORT_QUEUE_ERROR_CODES.UNSUPPORTED_MIME,
        })
        continue
      }
      const queueId = randomUUID()
      if (!isModeA && (queueId === provisionalId || provisionalId === driverId)) {
        rejected.push({
          fileName: file && file.name,
          code: DRIVER_REPORT_QUEUE_ERROR_CODES.PROVISIONAL_ID_REQUIRED,
        })
        continue
      }
      const record = buildDriverReportQueueRecord({
        file,
        queueId,
        sourceSurface,
        reportId: isModeA ? reportId : null,
        provisionalId: isModeA ? null : provisionalId,
        actorScopeId: driverId,
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
          provisionalId: record.provisional_id,
        })
      } catch (_error) {
        rejected.push({
          fileName: record.file_name,
          code: DRIVER_REPORT_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED,
        })
      }
    }

    if (accepted.length > 0 && isModeA) {
      try {
        await startRuntime(driverId)
      } catch (_error) {
        await inspectPending()
        return { accepted, rejected }
      }
      await inspectPending()
    } else if (accepted.length > 0) {
      actorScopeId = actorScopeId || driverId
      await inspectPending()
    }

    return { accepted, rejected }
  }

  async function proveReportId({ driverId, provisionalId, reportId }) {
    const linked = []
    const failed = []
    if (!isNonEmptyString(driverId)) {
      return { linked, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED }
    }
    if (!isNonEmptyString(provisionalId)) {
      return { linked, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.PROVISIONAL_ID_REQUIRED }
    }
    if (!isNonEmptyString(reportId)) {
      return { linked, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.REPORT_ID_REQUIRED }
    }

    let handle
    try {
      handle = ensureDb()
    } catch (_error) {
      return { linked, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE }
    }

    let records
    try {
      records = await handle.listRecordsForActor({
        actorScopeType: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
        actorScopeId: driverId,
      })
    } catch (_error) {
      return { linked, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE }
    }

    const targets = (Array.isArray(records) ? records : []).filter((record) => (
      isDriverReportActorRecord(record, driverId, sourceSurface)
      && record.provisional_id === provisionalId
      && LINKABLE_STATUSES.has(record.status)
    ))

    for (const record of targets) {
      try {
        const decision = transitionPhotoUpload(record.status, PHOTO_UPLOAD_EVENTS.REPORT_ID_PROVEN)
        if (decision.kind !== 'STATE' || decision.status !== PHOTO_UPLOAD_STATUSES.QUEUED) {
          failed.push({
            queueId: record.queue_id,
            code: DRIVER_REPORT_QUEUE_ERROR_CODES.LINK_WRITE_FAILED,
          })
          continue
        }
        const next = {
          ...record,
          blob: record.blob,
          entity_id: reportId,
          storage_path: buildDriverReportStoragePath({
            reportId,
            queueId: record.queue_id,
            mimeType: record.mime_type,
          }),
          status: PHOTO_UPLOAD_STATUSES.QUEUED,
          metadata_payload: {
            ...(record.metadata_payload || {}),
            order_id: reportId,
          },
          updated_at: now(),
        }
        await handle.putRecord(next)
        pendingObservation.add(next.queue_id)
        linked.push({
          queueId: next.queue_id,
          storagePath: next.storage_path,
          status: next.status,
          entityId: next.entity_id,
        })
      } catch (_error) {
        failed.push({
          queueId: record.queue_id,
          code: DRIVER_REPORT_QUEUE_ERROR_CODES.LINK_WRITE_FAILED,
        })
      }
    }

    if (linked.length > 0) {
      try {
        await startRuntime(driverId)
      } catch (_error) {
        await inspectPending()
        return { linked, failed }
      }
      await inspectPending()
    }

    return { linked, failed }
  }

  async function markReportResultAmbiguous({ driverId, provisionalId }) {
    const updated = []
    const failed = []
    if (!isNonEmptyString(driverId)) {
      return { updated, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED }
    }
    if (!isNonEmptyString(provisionalId)) {
      return { updated, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.PROVISIONAL_ID_REQUIRED }
    }

    let handle
    try {
      handle = ensureDb()
    } catch (_error) {
      return { updated, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE }
    }

    let records
    try {
      records = await handle.listRecordsForActor({
        actorScopeType: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
        actorScopeId: driverId,
      })
    } catch (_error) {
      return { updated, failed, code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE }
    }

    const targets = (Array.isArray(records) ? records : []).filter((record) => (
      isDriverReportActorRecord(record, driverId, sourceSurface)
      && record.provisional_id === provisionalId
      && record.status === PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED
    ))

    for (const record of targets) {
      try {
        const decision = transitionPhotoUpload(
          record.status,
          PHOTO_UPLOAD_EVENTS.REPORT_RESULT_AMBIGUOUS,
        )
        if (decision.kind !== 'STATE' || decision.status !== PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN) {
          failed.push({ queueId: record.queue_id })
          continue
        }
        const next = {
          ...record,
          blob: record.blob,
          entity_id: null,
          storage_path: null,
          status: PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN,
          updated_at: now(),
        }
        await handle.putRecord(next)
        updated.push({
          queueId: next.queue_id,
          status: next.status,
        })
      } catch (_error) {
        failed.push({
          queueId: record.queue_id,
          code: DRIVER_REPORT_QUEUE_ERROR_CODES.LINK_WRITE_FAILED,
        })
      }
    }

    return { updated, failed }
  }

  async function discardNeverUploadedDrafts({ provisionalId } = {}) {
    const deleted = []
    if (!isNonEmptyString(actorScopeId)) {
      return {
        ok: false,
        deleted,
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED,
      }
    }
    if (!isNonEmptyString(provisionalId)) {
      return {
        ok: false,
        deleted,
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.PROVISIONAL_ID_REQUIRED,
      }
    }

    let handle
    try {
      handle = ensureDb()
    } catch (_error) {
      return {
        ok: false,
        deleted,
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }

    if (!handle || typeof handle.listRecordsForActor !== 'function') {
      return {
        ok: false,
        deleted,
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }

    let records
    try {
      records = await handle.listRecordsForActor({
        actorScopeType: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
        actorScopeId,
      })
    } catch (_error) {
      return {
        ok: false,
        deleted,
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }

    const sameProvisional = (Array.isArray(records) ? records : []).filter((record) => (
      record
      && record.actor_scope_type === DRIVER_REPORT_ACTOR_SCOPE_TYPE
      && record.actor_scope_id === actorScopeId
      && record.source_surface === DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE
      && record.provisional_id === provisionalId
    ))

    if (sameProvisional.length === 0) {
      return { ok: true, deleted, code: null }
    }

    if (sameProvisional.some((record) => !isNeverUploadedReportModeDraft(record, provisionalId))) {
      return {
        ok: false,
        deleted,
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.UNSAFE_COMPOSITION,
      }
    }

    if (typeof handle.deleteLocalRecord !== 'function') {
      return {
        ok: false,
        deleted,
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }

    for (const record of sameProvisional) {
      let decision
      try {
        decision = transitionPhotoUpload(record.status, PHOTO_UPLOAD_EVENTS.DISCARD_REQUESTED)
      } catch (_error) {
        return {
          ok: false,
          deleted,
          code: DRIVER_REPORT_QUEUE_ERROR_CODES.UNSAFE_COMPOSITION,
        }
      }
      if (!decision || decision.kind !== 'DELETE_LOCAL') {
        return {
          ok: false,
          deleted,
          code: DRIVER_REPORT_QUEUE_ERROR_CODES.UNSAFE_COMPOSITION,
        }
      }
      try {
        await handle.deleteLocalRecord({
          queueId: record.queue_id,
          actorScopeType: DRIVER_REPORT_ACTOR_SCOPE_TYPE,
          actorScopeId,
        })
        pendingObservation.delete(record.queue_id)
        deleted.push(record.queue_id)
      } catch (_error) {
        return {
          ok: false,
          deleted,
          code: DRIVER_REPORT_QUEUE_ERROR_CODES.QUEUE_WRITE_FAILED,
        }
      }
    }

    return { ok: true, deleted, code: null }
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
    actorScopeId = null
    if (db && typeof db.close === 'function') {
      await db.close()
    }
    db = null
  }

  return {
    boot,
    enqueueFiles,
    proveReportId,
    markReportResultAmbiguous,
    discardNeverUploadedDrafts,
    dispose,
    inspectPending,
    getAccessToken,
    getLeaseOwner: () => leaseOwner,
    getActorScopeId: () => actorScopeId,
    getPendingObservationQueueIds: () => Array.from(pendingObservation),
    getObserverTimerPending: () => pollTimer != null,
  }
}

export function useDriverReportPhotoUploadQueue({
  sourceSurface,
  driverId,
  reportId,
  provisionalId,
  crmsRef,
  eventName,
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
    const controller = createDriverReportPhotoUploadQueueController({
      sourceSurface,
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
    void controller.boot({ driverId }).catch(() => {})
    return () => {
      void controller.dispose()
      controllerRef.current = null
    }
  }, [
    driverId,
    sourceSurface,
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
          ? DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE
          : DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED,
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
        reportId,
        provisionalId,
        crmsRef,
        eventName,
        driverName,
      })
      setLastResult(result)
      return result
    } finally {
      setBusy(false)
    }
  }, [driverId, reportId, provisionalId, crmsRef, eventName, driverName])

  const proveReportId = useCallback(async (nextReportId) => {
    const controller = controllerRef.current
    if (!controller) {
      return { linked: [], failed: [], code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE }
    }
    return controller.proveReportId({
      driverId,
      provisionalId,
      reportId: nextReportId,
    })
  }, [driverId, provisionalId])

  const markReportResultAmbiguous = useCallback(async () => {
    const controller = controllerRef.current
    if (!controller) {
      return { updated: [], failed: [], code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE }
    }
    return controller.markReportResultAmbiguous({
      driverId,
      provisionalId,
    })
  }, [driverId, provisionalId])

  const discardNeverUploadedDrafts = useCallback(async ({ provisionalId: nextProvisionalId } = {}) => {
    if (!isNonEmptyString(driverId)) {
      return {
        ok: false,
        deleted: [],
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.DRIVER_ID_REQUIRED,
      }
    }
    const controller = controllerRef.current
    if (!controller) {
      return {
        ok: false,
        deleted: [],
        code: DRIVER_REPORT_QUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE,
      }
    }
    return controller.discardNeverUploadedDrafts({
      provisionalId: nextProvisionalId,
    })
  }, [driverId])

  return {
    enqueueFiles,
    proveReportId,
    markReportResultAmbiguous,
    discardNeverUploadedDrafts,
    busy,
    lastResult,
  }
}

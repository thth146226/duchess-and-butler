import {
  PHOTO_UPLOAD_EVENTS,
  PHOTO_UPLOAD_STATUSES,
  transitionPhotoUpload,
} from './photoUploadDomain'
import { PHOTO_UPLOAD_DB_ERROR_CODES } from './photoUploadDb'
import { createPhotoUploadManager } from './photoUploadManager'

export const MAX_MANAGER_UPLOAD_ATTEMPTS = 5
export const MAX_DB_ATTEMPTS = 5
export const MANAGER_UPLOAD_BACKOFF_BASE_MS = 5000
export const MANAGER_UPLOAD_BACKOFF_MAX_MS = 300000
export const MANAGER_DB_BACKOFF_BASE_MS = 5000
export const MANAGER_DB_BACKOFF_MAX_MS = 300000
export const PROGRESS_PERSIST_THROTTLE_MS = 1000
export const BACKOFF_JITTER = 'FULL_JITTER_0_TO_CALCULATED_DELAY'

export const PHOTO_UPLOAD_RETRY_PHASES = Object.freeze({
  UPLOAD: 'UPLOAD',
  DB: 'DB',
})

export const PHOTO_UPLOAD_WORKER_OUTCOMES = Object.freeze({
  WORKER_FENCED: 'WORKER_FENCED',
  OK: 'OK',
})

export const PHOTO_UPLOAD_RUNTIME_ERROR_CODES = Object.freeze({
  MAX_UPLOAD_ATTEMPTS_REACHED: 'MAX_UPLOAD_ATTEMPTS_REACHED',
  MAX_DB_ATTEMPTS_REACHED: 'MAX_DB_ATTEMPTS_REACHED',
  REMOTE_STORAGE_INVARIANT_BROKEN: 'REMOTE_STORAGE_INVARIANT_BROKEN',
  OFFLINE: 'OFFLINE',
  ACCESS_TOKEN_UNAVAILABLE: 'ACCESS_TOKEN_UNAVAILABLE',
  DONE_BLOB_CLEANUP_FAILED: 'DONE_BLOB_CLEANUP_FAILED',
})

const TRANSPORT_CODES = Object.freeze({
  TUS_COMPLETE: 'TUS_COMPLETE',
  TUS_CONFLICT: 'TUS_CONFLICT',
  AUTH_OR_PERMISSION: 'AUTH_OR_PERMISSION',
  RETRYABLE_TRANSPORT: 'RETRYABLE_TRANSPORT',
  PERMANENT_TRANSPORT: 'PERMANENT_TRANSPORT',
  ABORTED: 'ABORTED',
})

const REMOTE_KINDS = Object.freeze({
  REMOTE_COMPLETE: 'REMOTE_COMPLETE',
  REMOTE_INCOMPLETE: 'REMOTE_INCOMPLETE',
  DB_ROW_FOUND: 'DB_ROW_FOUND',
  DB_INSERT_SUCCEEDED: 'DB_INSERT_SUCCEEDED',
})

const REMOTE_ERROR_CODES = Object.freeze({
  REMOTE_AUTH_OR_PERMISSION: 'REMOTE_AUTH_OR_PERMISSION',
  REMOTE_RETRYABLE: 'REMOTE_RETRYABLE',
  REMOTE_PERMANENT: 'REMOTE_PERMANENT',
  DB_AUTH_OR_PERMISSION: 'DB_AUTH_OR_PERMISSION',
  DB_RETRYABLE: 'DB_RETRYABLE',
  DB_INSERT_AMBIGUOUS: 'DB_INSERT_AMBIGUOUS',
  DB_PERMANENT: 'DB_PERMANENT',
  DB_MULTIPLE_ROWS: 'DB_MULTIPLE_ROWS',
})

const SKIP_PERSIST = Symbol('SKIP_PERSIST')

function isFenceConflict(error) {
  return Boolean(error && error.code === PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_FENCE_CONFLICT)
}

function errorCode(error) {
  if (!error) {
    return null
  }
  if (typeof error.code === 'string' && error.code.length > 0) {
    return error.code
  }
  return null
}

function errorHttpStatus(error) {
  if (!error || !Number.isInteger(error.httpStatus)) {
    return null
  }
  return error.httpStatus
}

function sanitizedError(code) {
  const normalized = String(code)
  return {
    code: normalized,
    message: normalized,
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function calculateBackoffDelayMs(attempt, baseMs, maxMs, random) {
  const n = Math.max(1, attempt)
  const calculatedDelay = Math.min(maxMs, baseMs * (2 ** (n - 1)))
  const unit = typeof random === 'function' ? random() : 0
  const bounded = unit >= 0 && unit <= 1 ? unit : 0
  return Math.floor(bounded * calculatedDelay)
}

function applyEvent(record, event, nowMs, extras = {}) {
  const decision = transitionPhotoUpload(record.status, event)
  const next = {
    ...record,
    ...extras,
    status: decision.status,
    updated_at: nowMs,
  }
  return next
}

function abortHandle(handle) {
  if (!handle || typeof handle.abort !== 'function') {
    return
  }
  try {
    handle.abort(false)
  } catch (_error) {
    return
  }
}

function createPhotoUploadStore(options = {}) {
  const db = options.db
  const transport = options.transport
  const reconciler = options.reconciler
  const actorScopeType = options.actorScopeType
  const actorScopeId = options.actorScopeId
  const managerFactory = options.managerFactory || createPhotoUploadManager
  const getAccessToken = options.getAccessToken
  const isOnline = typeof options.isOnline === 'function' ? options.isOnline : () => true
  const now = typeof options.now === 'function' ? options.now : Date.now
  const random = typeof options.random === 'function' ? options.random : Math.random
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout
  const leaseOwner = isNonEmptyString(options.leaseOwner)
    ? options.leaseOwner
    : (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `photo-upload-runtime-${now()}`)

  if (!db || typeof db.putRecordFenced !== 'function') {
    throw new Error('db is required')
  }
  if (!transport || typeof transport.startUpload !== 'function') {
    throw new Error('transport is required')
  }
  if (
    !reconciler
    || typeof reconciler.inspectRemoteObject !== 'function'
    || typeof reconciler.reconcileEvidencePhotoRow !== 'function'
  ) {
    throw new Error('reconciler is required')
  }
  if (!isNonEmptyString(actorScopeType) || !isNonEmptyString(actorScopeId)) {
    throw new Error('actor scope is required')
  }
  if (typeof getAccessToken !== 'function') {
    throw new Error('getAccessToken is required')
  }

  let started = false
  let stopped = false
  let manager = null
  let lastWorkerOutcome = null
  const activeUploads = new Map()

  function runtimeStatus() {
    return {
      actorScopeType,
      actorScopeId,
      leaseOwner,
      started,
      stopped,
      activeUploadCount: activeUploads.size,
      lastWorkerOutcome,
    }
  }

  function unregisterUpload(queueId) {
    activeUploads.delete(queueId)
  }

  function abortAllUploads() {
    const handles = [...activeUploads.values()]
    activeUploads.clear()
    for (const handle of handles) {
      abortHandle(handle)
    }
  }

  function createSession(record, fence) {
    const session = {
      leaseOwner: fence && isNonEmptyString(fence.leaseOwner) ? fence.leaseOwner : record.lease_owner,
      leaseGeneration: fence && Number.isInteger(fence.leaseGeneration)
        ? fence.leaseGeneration
        : record.lease_generation,
      record: { ...record },
      fenced: false,
      persistChain: Promise.resolve(),
      lastProgressAt: null,
    }

    function enqueue(mutator) {
      session.persistChain = session.persistChain
        .then(async () => {
          if (session.fenced) {
            lastWorkerOutcome = PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
            return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
          }
          const candidate = mutator({ ...session.record })
          if (candidate === SKIP_PERSIST) {
            return PHOTO_UPLOAD_WORKER_OUTCOMES.OK
          }
          try {
            const saved = await db.putRecordFenced({
              record: candidate,
              leaseOwner: session.leaseOwner,
              leaseGeneration: session.leaseGeneration,
            })
            session.record = saved
            return PHOTO_UPLOAD_WORKER_OUTCOMES.OK
          } catch (error) {
            if (isFenceConflict(error)) {
              session.fenced = true
              lastWorkerOutcome = PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
              const handle = activeUploads.get(session.record.queue_id)
              abortHandle(handle)
              unregisterUpload(session.record.queue_id)
              return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
            }
            throw error
          }
        })
        .catch((error) => {
          if (session.fenced || isFenceConflict(error)) {
            session.fenced = true
            lastWorkerOutcome = PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
            const handle = activeUploads.get(session.record.queue_id)
            abortHandle(handle)
            unregisterUpload(session.record.queue_id)
            return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
          }
          throw error
        })
      return session.persistChain
    }

    async function drain() {
      try {
        await session.persistChain
      } catch (_error) {
        if (session.fenced) {
          return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
        }
        throw _error
      }
      if (session.fenced) {
        return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
      }
      return PHOTO_UPLOAD_WORKER_OUTCOMES.OK
    }

    return { session, enqueue, drain }
  }

  function scheduleUploadRetry(record, attemptCount, nowMs) {
    const delay = calculateBackoffDelayMs(
      attemptCount,
      MANAGER_UPLOAD_BACKOFF_BASE_MS,
      MANAGER_UPLOAD_BACKOFF_MAX_MS,
      random
    )
    return applyEvent(record, PHOTO_UPLOAD_EVENTS.UPLOAD_RETRYABLE_FAILURE, nowMs, {
      retry_phase: PHOTO_UPLOAD_RETRY_PHASES.UPLOAD,
      next_retry_at: nowMs + delay,
      failure_stage: PHOTO_UPLOAD_RETRY_PHASES.UPLOAD,
    })
  }

  function scheduleDbRetry(record, attemptCount, nowMs, extras = {}) {
    const delay = calculateBackoffDelayMs(
      Math.max(1, attemptCount),
      MANAGER_DB_BACKOFF_BASE_MS,
      MANAGER_DB_BACKOFF_MAX_MS,
      random
    )
    return applyEvent(record, PHOTO_UPLOAD_EVENTS.DB_RETRYABLE_FAILURE, nowMs, {
      retry_phase: PHOTO_UPLOAD_RETRY_PHASES.DB,
      next_retry_at: nowMs + delay,
      failure_stage: PHOTO_UPLOAD_RETRY_PHASES.DB,
      ...extras,
    })
  }

  async function persistPause(enqueue, code) {
    const nowMs = now()
    return enqueue((record) => applyEvent(record, PHOTO_UPLOAD_EVENTS.UPLOAD_AUTH_OR_OFFLINE_PAUSE, nowMs, {
      last_error: sanitizedError(code),
      last_http_status: null,
      retry_phase: null,
      next_retry_at: null,
      failure_stage: null,
    }))
  }

  async function persistUploadPermanent(enqueue, code, httpStatus) {
    const nowMs = now()
    return enqueue((record) => applyEvent(record, PHOTO_UPLOAD_EVENTS.UPLOAD_PERMANENT_FAILURE, nowMs, {
      last_error: sanitizedError(code),
      last_http_status: httpStatus,
      retry_phase: null,
      next_retry_at: null,
      failure_stage: PHOTO_UPLOAD_RETRY_PHASES.UPLOAD,
    }))
  }

  async function persistDbPermanent(enqueue, code, extras = {}) {
    const nowMs = now()
    return enqueue((record) => applyEvent(record, PHOTO_UPLOAD_EVENTS.DB_PERMANENT_FAILURE, nowMs, {
      last_error: sanitizedError(code),
      retry_phase: null,
      next_retry_at: null,
      failure_stage: PHOTO_UPLOAD_RETRY_PHASES.DB,
      ...extras,
    }))
  }

  async function mapUploadRetryable(enqueue, code, httpStatus, alreadyCounted) {
    const nowMs = now()
    return enqueue((record) => {
      const nextCount = alreadyCounted ? record.upload_attempt_count : record.upload_attempt_count + 1
      const withCount = {
        ...record,
        upload_attempt_count: nextCount,
        last_error: sanitizedError(code),
        last_http_status: httpStatus,
        updated_at: nowMs,
      }
      if (nextCount >= MAX_MANAGER_UPLOAD_ATTEMPTS) {
        return applyEvent(withCount, PHOTO_UPLOAD_EVENTS.UPLOAD_PERMANENT_FAILURE, nowMs, {
          retry_phase: null,
          next_retry_at: null,
          failure_stage: PHOTO_UPLOAD_RETRY_PHASES.UPLOAD,
          last_error: sanitizedError(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_UPLOAD_ATTEMPTS_REACHED),
        })
      }
      return scheduleUploadRetry(withCount, nextCount, nowMs)
    })
  }

  async function bumpUploadAttempt(enqueue, extras = {}) {
    const nowMs = now()
    return enqueue((record) => ({
      ...record,
      ...extras,
      upload_attempt_count: record.upload_attempt_count + 1,
      updated_at: nowMs,
    }))
  }

  async function mapRemoteInspectDuringUpload(enqueue, drain, inspectResult) {
    if (inspectResult && inspectResult.kind === REMOTE_KINDS.REMOTE_COMPLETE) {
      const nowMs = now()
      const persisted = await enqueue((record) => applyEvent(
        record,
        PHOTO_UPLOAD_EVENTS.REMOTE_COMPLETE_RECONCILED,
        nowMs,
        {
          remote_public_url: inspectResult.publicUrl,
          remote_reconciliation_status: REMOTE_KINDS.REMOTE_COMPLETE,
          retry_phase: null,
          next_retry_at: null,
          last_error: null,
        }
      ))
      if (persisted === PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED) {
        return persisted
      }
      const began = await enqueue((record) => applyEvent(
        record,
        PHOTO_UPLOAD_EVENTS.BEGIN_DB_PHASE,
        now()
      ))
      return began
    }
    if (inspectResult && inspectResult.kind === REMOTE_KINDS.REMOTE_INCOMPLETE) {
      const nowMs = now()
      return enqueue((record) => applyEvent(
        record,
        PHOTO_UPLOAD_EVENTS.REMOTE_INCOMPLETE_RECONCILED,
        nowMs,
        {
          remote_reconciliation_status: REMOTE_KINDS.REMOTE_INCOMPLETE,
          retry_phase: null,
          next_retry_at: null,
        }
      ))
    }
    return drain()
  }

  async function handleRemoteErrorDuringUpload(enqueue, error) {
    const code = errorCode(error)
    const httpStatus = errorHttpStatus(error)
    if (code === REMOTE_ERROR_CODES.REMOTE_AUTH_OR_PERMISSION) {
      return persistPause(enqueue, code)
    }
    if (code === REMOTE_ERROR_CODES.REMOTE_PERMANENT) {
      const nowMs = now()
      return enqueue((record) => applyEvent(record, PHOTO_UPLOAD_EVENTS.UPLOAD_PERMANENT_FAILURE, nowMs, {
        last_error: sanitizedError(code),
        last_http_status: httpStatus,
        retry_phase: null,
        next_retry_at: null,
        failure_stage: PHOTO_UPLOAD_RETRY_PHASES.UPLOAD,
      }))
    }
    return mapUploadRetryable(enqueue, code || REMOTE_ERROR_CODES.REMOTE_RETRYABLE, httpStatus, true)
  }

  async function finishDone(enqueue, drain, session, event, dbRowId) {
    const nowMs = now()
    const persisted = await enqueue((record) => applyEvent(record, event, nowMs, {
      db_row_id: dbRowId,
      completed_at: nowMs,
      retry_phase: null,
      next_retry_at: null,
      last_error: null,
      failure_stage: null,
    }))
    if (persisted === PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED) {
      return persisted
    }
    try {
      await db.clearDoneBlob({
        queueId: session.record.queue_id,
        actorScopeType,
        actorScopeId,
        updatedAt: now(),
      })
      session.record = {
        ...session.record,
        blob: null,
      }
    } catch (_error) {
      await enqueue((record) => ({
        ...record,
        last_error: sanitizedError(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.DONE_BLOB_CLEANUP_FAILED),
        updated_at: now(),
      }))
    }
    return drain()
  }

  async function runDbPhase(enqueue, drain, session) {
    if (session.fenced || stopped) {
      return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
    }
    if (session.record.status !== PHOTO_UPLOAD_STATUSES.DB_PENDING) {
      return drain()
    }
    if (session.record.db_attempt_count >= MAX_DB_ATTEMPTS) {
      return persistDbPermanent(enqueue, PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_DB_ATTEMPTS_REACHED)
    }

    if (!isNonEmptyString(session.record.remote_public_url)) {
      let inspectResult
      try {
        inspectResult = await reconciler.inspectRemoteObject({
          storagePath: session.record.storage_path,
          expectedSize: session.record.file_size,
        })
      } catch (error) {
        const code = errorCode(error)
        if (code === REMOTE_ERROR_CODES.REMOTE_AUTH_OR_PERMISSION) {
          const nowMs = now()
          return enqueue((record) => scheduleDbRetry(record, record.db_attempt_count, nowMs, {
            last_error: sanitizedError(code),
            last_http_status: errorHttpStatus(error),
          }))
        }
        if (code === REMOTE_ERROR_CODES.REMOTE_PERMANENT) {
          return persistDbPermanent(enqueue, PHOTO_UPLOAD_RUNTIME_ERROR_CODES.REMOTE_STORAGE_INVARIANT_BROKEN)
        }
        const nowMs = now()
        return enqueue((record) => {
          const nextCount = record.db_attempt_count + 1
          const withCount = {
            ...record,
            db_attempt_count: nextCount,
            last_error: sanitizedError(code || REMOTE_ERROR_CODES.REMOTE_RETRYABLE),
            updated_at: nowMs,
          }
          if (nextCount >= MAX_DB_ATTEMPTS) {
            return applyEvent(withCount, PHOTO_UPLOAD_EVENTS.DB_PERMANENT_FAILURE, nowMs, {
              retry_phase: null,
              next_retry_at: null,
              failure_stage: PHOTO_UPLOAD_RETRY_PHASES.DB,
              last_error: sanitizedError(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_DB_ATTEMPTS_REACHED),
            })
          }
          return scheduleDbRetry(withCount, nextCount, nowMs)
        })
      }
      if (session.fenced) {
        return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
      }
      if (!inspectResult || inspectResult.kind !== REMOTE_KINDS.REMOTE_COMPLETE || !isNonEmptyString(inspectResult.publicUrl)) {
        return persistDbPermanent(enqueue, PHOTO_UPLOAD_RUNTIME_ERROR_CODES.REMOTE_STORAGE_INVARIANT_BROKEN)
      }
      const urlPersisted = await enqueue((record) => ({
        ...record,
        remote_public_url: inspectResult.publicUrl,
        remote_reconciliation_status: REMOTE_KINDS.REMOTE_COMPLETE,
        updated_at: now(),
      }))
      if (urlPersisted === PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED) {
        return urlPersisted
      }
    }

    let dbResult
    try {
      dbResult = await reconciler.reconcileEvidencePhotoRow({
        storagePath: session.record.storage_path,
        publicUrl: session.record.remote_public_url,
        metadataPayload: session.record.metadata_payload,
      })
    } catch (error) {
      if (session.fenced) {
        return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
      }
      const code = errorCode(error)
      const httpStatus = errorHttpStatus(error)
      if (code === REMOTE_ERROR_CODES.DB_AUTH_OR_PERMISSION) {
        const nowMs = now()
        return enqueue((record) => scheduleDbRetry(record, record.db_attempt_count, nowMs, {
          last_error: sanitizedError(code),
          last_http_status: httpStatus,
        }))
      }
      if (code === REMOTE_ERROR_CODES.DB_PERMANENT || code === REMOTE_ERROR_CODES.DB_MULTIPLE_ROWS) {
        const nowMs = now()
        return enqueue((record) => {
          const nextCount = record.db_attempt_count + 1
          return applyEvent({
            ...record,
            db_attempt_count: nextCount,
            last_http_status: httpStatus,
            updated_at: nowMs,
          }, PHOTO_UPLOAD_EVENTS.DB_PERMANENT_FAILURE, nowMs, {
            last_error: sanitizedError(code),
            retry_phase: null,
            next_retry_at: null,
            failure_stage: PHOTO_UPLOAD_RETRY_PHASES.DB,
          })
        })
      }
      const nowMs = now()
      return enqueue((record) => {
        const nextCount = record.db_attempt_count + 1
        const withCount = {
          ...record,
          db_attempt_count: nextCount,
          last_error: sanitizedError(code || REMOTE_ERROR_CODES.DB_RETRYABLE),
          last_http_status: httpStatus,
          updated_at: nowMs,
        }
        if (nextCount >= MAX_DB_ATTEMPTS) {
          return applyEvent(withCount, PHOTO_UPLOAD_EVENTS.DB_PERMANENT_FAILURE, nowMs, {
            retry_phase: null,
            next_retry_at: null,
            failure_stage: PHOTO_UPLOAD_RETRY_PHASES.DB,
            last_error: sanitizedError(PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_DB_ATTEMPTS_REACHED),
          })
        }
        return scheduleDbRetry(withCount, nextCount, nowMs)
      })
    }

    if (session.fenced) {
      return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
    }

    const nowMs = now()
    await enqueue((record) => ({
      ...record,
      db_attempt_count: record.db_attempt_count + 1,
      updated_at: nowMs,
    }))
    if (session.fenced) {
      return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
    }

    const rowId = dbResult && isNonEmptyString(dbResult.id) ? dbResult.id : null
    if (dbResult && dbResult.kind === REMOTE_KINDS.DB_ROW_FOUND) {
      return finishDone(enqueue, drain, session, PHOTO_UPLOAD_EVENTS.DB_ROW_FOUND, rowId)
    }
    if (dbResult && dbResult.kind === REMOTE_KINDS.DB_INSERT_SUCCEEDED) {
      return finishDone(enqueue, drain, session, PHOTO_UPLOAD_EVENTS.DB_INSERT_SUCCEEDED, rowId)
    }
    return persistDbPermanent(enqueue, REMOTE_ERROR_CODES.DB_PERMANENT)
  }

  async function runUploadPhase(enqueue, drain, session) {
    if (session.record.status !== PHOTO_UPLOAD_STATUSES.UPLOADING) {
      return drain()
    }

    let online = true
    try {
      online = isOnline() !== false
    } catch (_error) {
      online = false
    }
    if (!online) {
      await persistPause(enqueue, PHOTO_UPLOAD_RUNTIME_ERROR_CODES.OFFLINE)
      return drain()
    }

    let accessToken = null
    try {
      accessToken = await getAccessToken({
        actorScopeType,
        actorScopeId,
      })
    } catch (_error) {
      accessToken = null
    }
    if (!isNonEmptyString(accessToken)) {
      await persistPause(enqueue, PHOTO_UPLOAD_RUNTIME_ERROR_CODES.ACCESS_TOKEN_UNAVAILABLE)
      return drain()
    }

    if (session.record.upload_attempt_count >= MAX_MANAGER_UPLOAD_ATTEMPTS) {
      await persistUploadPermanent(enqueue, PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_UPLOAD_ATTEMPTS_REACHED, null)
      return drain()
    }

    if (
      !(session.record.blob instanceof Blob)
      || !isNonEmptyString(session.record.storage_path)
      || !isNonEmptyString(session.record.mime_type)
    ) {
      await persistUploadPermanent(enqueue, PHOTO_UPLOAD_RUNTIME_ERROR_CODES.MAX_UPLOAD_ATTEMPTS_REACHED, null)
      return drain()
    }

    const handle = transport.startUpload({
      blob: session.record.blob,
      storagePath: session.record.storage_path,
      mimeType: session.record.mime_type,
      accessToken,
      tusUploadUrl: session.record.tus_upload_url,
      tusCreatedAt: session.record.tus_created_at,
      now: now(),
      onUploadUrl({ uploadUrl, createdAt }) {
        if (!isNonEmptyString(uploadUrl)) {
          return
        }
        const created = Number.isInteger(createdAt) ? createdAt : now()
        void enqueue((record) => {
          if (record.status !== PHOTO_UPLOAD_STATUSES.UPLOADING) {
            return SKIP_PERSIST
          }
          return {
            ...record,
            tus_upload_url: uploadUrl,
            tus_created_at: created,
            updated_at: now(),
          }
        })
      },
      onProgress({ bytesUploaded, bytesTotal }) {
        if (!Number.isInteger(bytesUploaded) || !Number.isInteger(bytesTotal)) {
          return
        }
        const observedAt = now()
        if (
          session.lastProgressAt != null
          && observedAt - session.lastProgressAt < PROGRESS_PERSIST_THROTTLE_MS
        ) {
          return
        }
        session.lastProgressAt = observedAt
        void enqueue((record) => {
          if (record.status !== PHOTO_UPLOAD_STATUSES.UPLOADING) {
            return SKIP_PERSIST
          }
          return {
            ...record,
            bytes_uploaded: bytesUploaded,
            bytes_total: bytesTotal,
            updated_at: observedAt,
          }
        })
      },
    })

    activeUploads.set(session.record.queue_id, handle)

    let transportResult = null
    let transportError = null
    try {
      transportResult = await handle.done
    } catch (error) {
      transportError = error
    } finally {
      unregisterUpload(session.record.queue_id)
    }

    const drained = await drain()
    if (drained === PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED || session.fenced) {
      abortHandle(handle)
      return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
    }

    if (stopped) {
      return drain()
    }

    if (transportError) {
      const code = errorCode(transportError)
      if (code === TRANSPORT_CODES.ABORTED) {
        lastWorkerOutcome = TRANSPORT_CODES.ABORTED
        return drain()
      }
      if (code === TRANSPORT_CODES.AUTH_OR_PERMISSION) {
        await persistPause(enqueue, code)
        return drain()
      }
      if (code === TRANSPORT_CODES.PERMANENT_TRANSPORT) {
        const nowMs = now()
        await enqueue((record) => {
          const nextCount = record.upload_attempt_count + 1
          return applyEvent({
            ...record,
            upload_attempt_count: nextCount,
            updated_at: nowMs,
          }, PHOTO_UPLOAD_EVENTS.UPLOAD_PERMANENT_FAILURE, nowMs, {
            last_error: sanitizedError(code),
            last_http_status: errorHttpStatus(transportError),
            retry_phase: null,
            next_retry_at: null,
            failure_stage: PHOTO_UPLOAD_RETRY_PHASES.UPLOAD,
          })
        })
        return drain()
      }
      if (code === TRANSPORT_CODES.TUS_CONFLICT) {
        return reconcileAfterTransfer(enqueue, drain, session, {
          bytesTotal: session.record.bytes_total,
        })
      }
      await mapUploadRetryable(
        enqueue,
        code || TRANSPORT_CODES.RETRYABLE_TRANSPORT,
        errorHttpStatus(transportError)
      )
      return drain()
    }

    const kind = transportResult && transportResult.kind
    if (kind === TRANSPORT_CODES.TUS_CONFLICT || kind === TRANSPORT_CODES.TUS_COMPLETE) {
      return reconcileAfterTransfer(enqueue, drain, session, transportResult)
    }
    await mapUploadRetryable(enqueue, TRANSPORT_CODES.RETRYABLE_TRANSPORT, null)
    return drain()
  }

  async function reconcileAfterTransfer(enqueue, drain, session, transportResult) {
    const finalBytes = Number.isInteger(transportResult && transportResult.bytesTotal)
      ? transportResult.bytesTotal
      : session.record.bytes_total
    await bumpUploadAttempt(enqueue, {
      bytes_uploaded: finalBytes,
      bytes_total: finalBytes,
    })
    if (session.fenced) {
      return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
    }

    let inspectResult
    try {
      inspectResult = await reconciler.inspectRemoteObject({
        storagePath: session.record.storage_path,
        expectedSize: session.record.file_size,
      })
    } catch (error) {
      await handleRemoteErrorDuringUpload(enqueue, error)
      return drain()
    }

    if (session.fenced) {
      return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
    }

    const mapped = await mapRemoteInspectDuringUpload(enqueue, drain, inspectResult)
    if (mapped === PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED || session.fenced) {
      return PHOTO_UPLOAD_WORKER_OUTCOMES.WORKER_FENCED
    }
    if (session.record.status === PHOTO_UPLOAD_STATUSES.DB_PENDING) {
      return runDbPhase(enqueue, drain, session)
    }
    return drain()
  }

  async function executeClaimedRecord(record, fence = {}) {
    const { session, enqueue, drain } = createSession(record, fence)
    try {
      if (record.status === PHOTO_UPLOAD_STATUSES.UPLOADING) {
        lastWorkerOutcome = await runUploadPhase(enqueue, drain, session)
      } else if (record.status === PHOTO_UPLOAD_STATUSES.DB_PENDING) {
        lastWorkerOutcome = await runDbPhase(enqueue, drain, session)
      } else {
        lastWorkerOutcome = await drain()
      }
      return lastWorkerOutcome
    } finally {
      unregisterUpload(record.queue_id)
    }
  }

  function start() {
    if (stopped) {
      return
    }
    if (!manager) {
      manager = managerFactory({
        db,
        actorScopeType,
        actorScopeId,
        leaseOwner,
        executeClaimedRecord,
        now,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
    }
    started = true
    return manager.pump()
  }

  async function stop() {
    stopped = true
    abortAllUploads()
    if (manager && typeof manager.stop === 'function') {
      await manager.stop()
    }
  }

  return {
    start,
    stop,
    getRuntimeStatus: runtimeStatus,
  }
}

export { createPhotoUploadStore }

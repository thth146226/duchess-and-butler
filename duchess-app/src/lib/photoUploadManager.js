import {
  PHOTO_UPLOAD_EVENTS,
  PHOTO_UPLOAD_STATUSES,
  transitionPhotoUpload,
} from './photoUploadDomain'
import { PHOTO_UPLOAD_DB_ERROR_CODES } from './photoUploadDb'

export const MAX_CONCURRENT_UPLOADS = 2
export const LEASE_TTL_MS = 30000
export const LEASE_HEARTBEAT_MS = 10000

function isFenceConflict(error) {
  return Boolean(error && error.code === PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_FENCE_CONFLICT)
}

function isLeaseUnavailable(error) {
  return Boolean(error && error.code === PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_NOT_AVAILABLE)
}

function compareEligibleRecords(left, right) {
  const createdDelta = (left.created_at || 0) - (right.created_at || 0)
  if (createdDelta !== 0) {
    return createdDelta
  }
  if (left.queue_id < right.queue_id) {
    return -1
  }
  if (left.queue_id > right.queue_id) {
    return 1
  }
  return 0
}

function isRetryDue(record, nowMs) {
  return Number.isInteger(record.next_retry_at) && record.next_retry_at <= nowMs
}

function isLeaseExpired(record, nowMs) {
  return record.lease_expires_at === null || record.lease_expires_at <= nowMs
}

function hasForeignUnexpiredLease(record, nowMs, leaseOwner) {
  if (record.lease_owner === null) {
    return false
  }
  if (isLeaseExpired(record, nowMs)) {
    return false
  }
  return record.lease_owner !== leaseOwner
}

function isEligible(record, nowMs, leaseOwner) {
  if (hasForeignUnexpiredLease(record, nowMs, leaseOwner)) {
    return false
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.QUEUED) {
    return true
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.UPLOADING) {
    return true
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT) {
    return isRetryDue(record, nowMs)
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE) {
    return true
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.DB_PENDING) {
    return true
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT) {
    return isRetryDue(record, nowMs)
  }
  return false
}

function applyRequiredTransition(record, nowMs) {
  if (record.status === PHOTO_UPLOAD_STATUSES.QUEUED) {
    const decision = transitionPhotoUpload(record.status, PHOTO_UPLOAD_EVENTS.WORKER_CLAIMED)
    return {
      ...record,
      status: decision.status,
      updated_at: nowMs,
    }
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT) {
    const decision = transitionPhotoUpload(record.status, PHOTO_UPLOAD_EVENTS.UPLOAD_RETRY_DUE)
    return {
      ...record,
      status: decision.status,
      updated_at: nowMs,
      retry_phase: null,
      next_retry_at: null,
    }
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE) {
    const decision = transitionPhotoUpload(record.status, PHOTO_UPLOAD_EVENTS.BEGIN_DB_PHASE)
    return {
      ...record,
      status: decision.status,
      updated_at: nowMs,
    }
  }
  if (record.status === PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT) {
    const decision = transitionPhotoUpload(record.status, PHOTO_UPLOAD_EVENTS.DB_RETRY_DUE)
    return {
      ...record,
      status: decision.status,
      updated_at: nowMs,
      retry_phase: null,
      next_retry_at: null,
    }
  }
  return record
}

export function createPhotoUploadManager(options = {}) {
  const db = options.db
  const actorScopeType = options.actorScopeType
  const actorScopeId = options.actorScopeId
  const leaseOwner = options.leaseOwner
  const executeClaimedRecord = options.executeClaimedRecord
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout

  if (!db || typeof db.claimLease !== 'function') {
    throw new Error('db is required')
  }
  if (typeof actorScopeType !== 'string' || actorScopeType.length === 0) {
    throw new Error('actorScopeType is required')
  }
  if (typeof actorScopeId !== 'string' || actorScopeId.length === 0) {
    throw new Error('actorScopeId is required')
  }
  if (typeof leaseOwner !== 'string' || leaseOwner.length === 0) {
    throw new Error('leaseOwner is required')
  }
  if (typeof executeClaimedRecord !== 'function') {
    throw new Error('executeClaimedRecord is required')
  }

  let stopped = false
  let pumping = false
  let pumpAgain = false
  let pumpChain = Promise.resolve()
  const activeSlots = new Map()
  const locallyExecuted = new Set()
  const openTimers = new Set()

  function scheduleTimeout(callback, delay) {
    const id = setTimeoutImpl(() => {
      openTimers.delete(id)
      callback()
    }, delay)
    openTimers.add(id)
    return id
  }

  function cancelTimeout(id) {
    if (id == null) {
      return
    }
    openTimers.delete(id)
    clearTimeoutImpl(id)
  }

  function clearAllTimers() {
    for (const id of [...openTimers]) {
      cancelTimeout(id)
    }
  }

  async function safeRelease(slot) {
    if (!slot || slot.stale) {
      return
    }
    try {
      await db.releaseLease({
        queueId: slot.queueId,
        actorScopeType,
        actorScopeId,
        leaseOwner,
        leaseGeneration: slot.generation,
      })
    } catch (error) {
      if (!isFenceConflict(error)) {
        return
      }
    }
  }

  async function beat(slot) {
    if (stopped || slot.stale) {
      return
    }
    try {
      await db.heartbeatLease({
        queueId: slot.queueId,
        actorScopeType,
        actorScopeId,
        leaseOwner,
        leaseGeneration: slot.generation,
        now: now(),
        leaseTtlMs: LEASE_TTL_MS,
      })
    } catch (error) {
      if (isFenceConflict(error)) {
        slot.stale = true
      }
      return
    }
    if (stopped || slot.stale) {
      return
    }
    slot.heartbeatTimer = scheduleTimeout(() => {
      void beat(slot)
    }, LEASE_HEARTBEAT_MS)
  }

  function startHeartbeat(slot) {
    slot.heartbeatTimer = scheduleTimeout(() => {
      void beat(slot)
    }, LEASE_HEARTBEAT_MS)
  }

  function stopHeartbeat(slot) {
    if (slot.heartbeatTimer != null) {
      cancelTimeout(slot.heartbeatTimer)
      slot.heartbeatTimer = null
    }
  }

  async function runSlot(slot, record) {
    try {
      if (!stopped && !slot.stale) {
        locallyExecuted.add(slot.queueId)
        await executeClaimedRecord(record, {
          leaseOwner,
          leaseGeneration: slot.generation,
        })
      }
    } catch (_error) {
      return
    } finally {
      stopHeartbeat(slot)
      if (!slot.stale && !stopped) {
        await safeRelease(slot)
      }
      activeSlots.delete(slot.queueId)
      if (!stopped) {
        await pump()
      }
    }
  }

  async function claimAndStart(candidate) {
    const claimed = await db.claimLease({
      queueId: candidate.queue_id,
      actorScopeType,
      actorScopeId,
      leaseOwner,
      now: now(),
      leaseTtlMs: LEASE_TTL_MS,
    })
    const generation = claimed.lease_generation
    let workRecord = claimed

    if (
      claimed.status === PHOTO_UPLOAD_STATUSES.QUEUED ||
      claimed.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT ||
      claimed.status === PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE ||
      claimed.status === PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT
    ) {
      workRecord = applyRequiredTransition(claimed, now())
      try {
        await db.putRecordFenced({
          record: workRecord,
          leaseOwner,
          leaseGeneration: generation,
        })
      } catch (error) {
        if (!isFenceConflict(error)) {
          await safeRelease({
            queueId: claimed.queue_id,
            generation,
            stale: false,
          })
        }
        return false
      }
    } else if (
      claimed.status !== PHOTO_UPLOAD_STATUSES.UPLOADING &&
      claimed.status !== PHOTO_UPLOAD_STATUSES.DB_PENDING
    ) {
      await safeRelease({
        queueId: claimed.queue_id,
        generation,
        stale: false,
      })
      return false
    }

    if (stopped) {
      await safeRelease({
        queueId: claimed.queue_id,
        generation,
        stale: false,
      })
      return false
    }

    const slot = {
      queueId: claimed.queue_id,
      generation,
      stale: false,
      heartbeatTimer: null,
    }
    activeSlots.set(slot.queueId, slot)
    startHeartbeat(slot)
    void runSlot(slot, workRecord)
    return true
  }

  async function fillSlots() {
    const attempted = new Set(activeSlots.keys())
    while (!stopped && activeSlots.size < MAX_CONCURRENT_UPLOADS) {
      const records = await db.listRecordsForActor({
        actorScopeType,
        actorScopeId,
      })
      const nowMs = now()
      const candidate = records
        .filter((record) => (
          !attempted.has(record.queue_id)
          && !locallyExecuted.has(record.queue_id)
          && isEligible(record, nowMs, leaseOwner)
        ))
        .sort(compareEligibleRecords)[0]
      if (!candidate) {
        break
      }
      attempted.add(candidate.queue_id)
      try {
        await claimAndStart(candidate)
      } catch (error) {
        if (isLeaseUnavailable(error) || isFenceConflict(error)) {
          continue
        }
        throw error
      }
    }
  }

  async function pumpOnce() {
    if (stopped) {
      return
    }
    if (pumping) {
      pumpAgain = true
      return
    }
    pumping = true
    try {
      do {
        pumpAgain = false
        await fillSlots()
        if (stopped) {
          break
        }
      } while (pumpAgain)
    } finally {
      pumping = false
    }
  }

  function pump() {
    if (stopped) {
      return pumpChain
    }
    pumpChain = pumpChain.then(pumpOnce, pumpOnce)
    return pumpChain
  }

  async function stop() {
    stopped = true
    clearAllTimers()
    for (const slot of activeSlots.values()) {
      stopHeartbeat(slot)
    }
    try {
      await pumpChain
    } catch (_error) {
      return
    }
    for (const slot of [...activeSlots.values()]) {
      stopHeartbeat(slot)
      if (!slot.stale) {
        await safeRelease(slot)
        slot.stale = true
      }
    }
  }

  return {
    pump,
    stop,
  }
}

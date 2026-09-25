import {
  PHOTO_UPLOAD_EVENTS,
  PHOTO_UPLOAD_STATUSES,
  transitionPhotoUpload,
} from './photoUploadDomain'
import { PHOTO_UPLOAD_DB_ERROR_CODES } from './photoUploadDb'
import { abbreviateQueueId, recordPhotoUploadDiagnostic } from './photoUploadDiagnostics'

function trace(event, data) {
  try {
    recordPhotoUploadDiagnostic(event, data)
  } catch (_error) {
    return
  }
}

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
  const abortLocalUpload = options.abortLocalUpload
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
  let retryWakeTimer = null
  let retryWakeAt = null

  function scheduleTimeout(callback, delay) {
    const id = setTimeoutImpl(() => {
      openTimers.delete(id)
      callback()
    }, delay)
    openTimers.add(id)
    return id
  }

  function slotSnapshot() {
    return {
      active_slots: activeSlots.size,
      locally_executed: locallyExecuted.size,
      free_slots: MAX_CONCURRENT_UPLOADS - activeSlots.size,
      max_concurrent: MAX_CONCURRENT_UPLOADS,
    }
  }

  function eligibilityCounts(records, nowMs) {
    const counts = {
      actor_record_count: records.length,
      eligible_record_count: 0,
      status_not_eligible: 0,
      locally_executed_blocked: 0,
      lease_not_eligible: 0,
      retry_not_due: 0,
      other: 0,
    }
    for (const record of records) {
      if (locallyExecuted.has(record.queue_id)) {
        counts.locally_executed_blocked += 1
        continue
      }
      if (hasForeignUnexpiredLease(record, nowMs, leaseOwner)) {
        counts.lease_not_eligible += 1
        continue
      }
      if (
        (record.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT
          || record.status === PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT)
        && !isRetryDue(record, nowMs)
      ) {
        counts.retry_not_due += 1
        continue
      }
      if (!isEligible(record, nowMs, leaseOwner)) {
        counts.status_not_eligible += 1
        continue
      }
      counts.eligible_record_count += 1
    }
    return counts
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

  function clearRetryWakeTimer() {
    if (retryWakeTimer != null) {
      cancelTimeout(retryWakeTimer)
      retryWakeTimer = null
    }
    retryWakeAt = null
  }

  function armRetryWakeTimer(wakeAt) {
    const delay = Math.max(0, wakeAt - now())
    retryWakeAt = wakeAt
    retryWakeTimer = scheduleTimeout(() => {
      retryWakeTimer = null
      retryWakeAt = null
      if (stopped) {
        return
      }
      void pump()
    }, delay)
  }

  async function scheduleRetryWake() {
    if (stopped) {
      return
    }
    let records
    try {
      records = await db.listRecordsForActor({
        actorScopeType,
        actorScopeId,
      })
    } catch (_error) {
      return
    }
    const nowMs = now()
    let earliest = null
    for (const record of Array.isArray(records) ? records : []) {
      if (
        record.status !== PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT
        && record.status !== PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT
      ) {
        continue
      }
      if (!Number.isInteger(record.next_retry_at) || record.next_retry_at <= nowMs) {
        continue
      }
      if (earliest === null || record.next_retry_at < earliest) {
        earliest = record.next_retry_at
      }
    }
    if (earliest === null) {
      clearRetryWakeTimer()
      return
    }
    if (retryWakeTimer != null && retryWakeAt != null && earliest >= retryWakeAt) {
      return
    }
    clearRetryWakeTimer()
    armRetryWakeTimer(earliest)
  }

  function getRetryWakeState() {
    return {
      pending: retryWakeTimer != null,
      wakeAt: retryWakeAt,
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
      trace('SLOT_FINALLY_BEGIN', {
        queue_fragment: abbreviateQueueId(slot.queueId),
        active_slots_before: activeSlots.size,
        locally_executed_before: locallyExecuted.size,
      })
      stopHeartbeat(slot)
      if (!slot.stale && !stopped) {
        await safeRelease(slot)
      }
      activeSlots.delete(slot.queueId)
      if (!stopped) {
        try {
          if (typeof db.getRecord === 'function') {
            const durable = await db.getRecord({
              queueId: slot.queueId,
              actorScopeType,
              actorScopeId,
            })
            if (
              slot.lifecycleRetire
              && (!durable || durable.status === PHOTO_UPLOAD_STATUSES.UPLOADING)
            ) {
              locallyExecuted.delete(slot.queueId)
            } else if (
              durable
              && durable.status === PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED
            ) {
              locallyExecuted.delete(slot.queueId)
            } else if (
              durable
              && (
                durable.status === PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT
                || durable.status === PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT
              )
              && Number.isInteger(durable.next_retry_at)
              && durable.next_retry_at > now()
            ) {
              locallyExecuted.delete(slot.queueId)
            }
          } else if (slot.lifecycleRetire) {
            locallyExecuted.delete(slot.queueId)
          }
        } catch (_readError) {
          if (slot.lifecycleRetire) {
            locallyExecuted.delete(slot.queueId)
          }
        }
        trace('SLOT_FINALLY_END', {
          queue_fragment: abbreviateQueueId(slot.queueId),
          active_slots_after: activeSlots.size,
          locally_executed_after: locallyExecuted.size,
        })
        trace('PUMP_REQUEST_FROM_SLOT_FINALLY', slotSnapshot())
        await pump()
      } else {
        trace('SLOT_FINALLY_END', {
          queue_fragment: abbreviateQueueId(slot.queueId),
          active_slots_after: activeSlots.size,
          locally_executed_after: locallyExecuted.size,
        })
      }
    }
  }

  async function retireLifecycleStaleSlots() {
    const slots = [...activeSlots.values()]
    trace('RETIRE_STALE_BEGIN', {
      active_slots_before: activeSlots.size,
      locally_executed_before: locallyExecuted.size,
    })
    if (slots.length === 0) {
      trace('RETIRE_STALE_END', {
        active_slots_after: activeSlots.size,
        locally_executed_after: locallyExecuted.size,
      })
      return
    }
    for (const slot of slots) {
      slot.lifecycleRetire = true
    }
    if (typeof abortLocalUpload === 'function') {
      for (const slot of slots) {
        try {
          abortLocalUpload(slot.queueId)
        } catch (_error) {
          // The slot finally still clears bookkeeping if the handle cannot abort.
        }
      }
    } else {
      for (const slot of slots) {
        trace('RETIRE_SLOT_ABORT_REQUEST', {
          queue_fragment: abbreviateQueueId(slot.queueId),
          has_handle: false,
        })
      }
    }
    for (const slot of slots) {
      trace('RETIRE_SLOT_WAIT_SETTLED', { queue_fragment: abbreviateQueueId(slot.queueId) })
    }
    await Promise.all(slots.map((slot) => slot.settled))
    for (const slot of slots) {
      trace('RETIRE_SLOT_SETTLED', { queue_fragment: abbreviateQueueId(slot.queueId) })
    }
    trace('RETIRE_STALE_END', {
      active_slots_after: activeSlots.size,
      locally_executed_after: locallyExecuted.size,
    })
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

    let resolveSettled = () => {}
    const settled = new Promise((resolve) => {
      resolveSettled = resolve
    })
    const slot = {
      queueId: claimed.queue_id,
      generation,
      stale: false,
      heartbeatTimer: null,
      lifecycleRetire: false,
      settled,
    }
    activeSlots.set(slot.queueId, slot)
    startHeartbeat(slot)
    void runSlot(slot, workRecord).finally(resolveSettled)
    return true
  }

  async function fillSlots(started) {
    const attempted = new Set(activeSlots.keys())
    if (!stopped && activeSlots.size >= MAX_CONCURRENT_UPLOADS) {
      trace('PUMP_NO_WORK', { ...slotSnapshot(), reason: 'NO_FREE_SLOTS' })
    }
    while (!stopped && activeSlots.size < MAX_CONCURRENT_UPLOADS) {
      const records = await db.listRecordsForActor({
        actorScopeType,
        actorScopeId,
      })
      const nowMs = now()
      try {
        trace('PUMP_SCAN', { ...slotSnapshot(), ...eligibilityCounts(records, nowMs) })
      } catch (_error) {
        // Eligibility counts are diagnostic only.
      }
      const candidate = records
        .filter((record) => (
          !attempted.has(record.queue_id)
          && !locallyExecuted.has(record.queue_id)
          && isEligible(record, nowMs, leaseOwner)
        ))
        .sort(compareEligibleRecords)[0]
      if (!candidate) {
        trace('PUMP_NO_WORK', { ...slotSnapshot(), reason: 'NO_ELIGIBLE_RECORDS' })
        break
      }
      attempted.add(candidate.queue_id)
      trace('PUMP_SLOT_SELECTED', {
        queue_fragment: abbreviateQueueId(candidate.queue_id),
        status: candidate.status,
        active_slots_before_start: activeSlots.size,
      })
      try {
        const startedSlot = await claimAndStart(candidate)
        if (startedSlot) {
          started.count += 1
        }
      } catch (error) {
        if (isLeaseUnavailable(error) || isFenceConflict(error)) {
          continue
        }
        throw error
      }
    }
  }

  async function pumpOnce() {
    const started = { count: 0 }
    trace('PUMP_BEGIN', slotSnapshot())
    if (stopped) {
      trace('PUMP_NO_WORK', { ...slotSnapshot(), reason: 'STOPPED' })
      trace('PUMP_END', { ...slotSnapshot(), started_count: 0 })
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
        await fillSlots(started)
        if (stopped) {
          break
        }
        await scheduleRetryWake()
      } while (pumpAgain)
    } finally {
      pumping = false
      trace('PUMP_END', { ...slotSnapshot(), started_count: started.count })
    }
  }

  function pump() {
    if (stopped) {
      trace('PUMP_BEGIN', slotSnapshot())
      trace('PUMP_NO_WORK', { ...slotSnapshot(), reason: 'STOPPED' })
      trace('PUMP_END', { ...slotSnapshot(), started_count: 0 })
      return pumpChain
    }
    pumpChain = pumpChain.then(pumpOnce, pumpOnce)
    return pumpChain
  }

  async function stop() {
    stopped = true
    clearRetryWakeTimer()
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
    retireLifecycleStaleSlots,
    getRetryWakeState,
  }
}

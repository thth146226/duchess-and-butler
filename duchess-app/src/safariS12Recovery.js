export const HARNESS_META_DB_NAME = 'duchess-photo-upload-s12-safari-harness-meta'
export const SAFARI_S12_MIN_BACKGROUND_MS = 10 * 60 * 1000
const VISIBILITY_STORE = 'visibility'

let writeChain = Promise.resolve()

export function activeWorkerCounts(workers, runId) {
  const counts = {}
  for (const worker of workers || []) {
    if (!worker || worker.run_id !== runId || worker.in_flight !== true || !worker.queue_id) {
      continue
    }
    counts[worker.queue_id] = (counts[worker.queue_id] || 0) + 1
  }
  return counts
}

export function hasDuplicateActiveWorker(workers, runId) {
  return Object.values(activeWorkerCounts(workers, runId)).some((count) => count > 1)
}

function resumeExceeded(workers, runId, armedRecords, duration, leaseTtlMs) {
  const list = (workers || []).filter((worker) => worker && worker.run_id === runId)
  const allowResume = Number.isInteger(duration) && duration >= leaseTtlMs
  for (const record of armedRecords || []) {
    const seen = list.filter((worker) => worker.queue_id === record.queue_id).length
    const baseline = Number.isInteger(record.start_count) ? record.start_count : 0
    const allowed = baseline + (allowResume ? 1 : 0)
    if (seen > allowed) {
      return true
    }
  }
  return false
}

export function classifyBackgroundCycle({
  hiddenAt,
  hiddenVisibilityState,
  visibleAt,
  now,
  workers,
  runId,
  bytesMatch,
  armedRecords,
  duplicateObserved,
  minDurationMs = SAFARI_S12_MIN_BACKGROUND_MS,
  leaseTtlMs = 30000,
}) {
  const realHidden = Number.isInteger(hiddenAt) && hiddenAt > 0 && hiddenVisibilityState === 'hidden'
  let duration = null
  if (realHidden && Number.isInteger(now)) {
    const end = Number.isInteger(visibleAt) ? visibleAt : now
    duration = end - hiddenAt
  }
  if (bytesMatch === false) {
    return { result: 'fail', hidden_duration_ms: duration, reason: 'byte_mismatch' }
  }
  if (duplicateObserved === true || hasDuplicateActiveWorker(workers, runId)) {
    return { result: 'fail', hidden_duration_ms: duration, reason: 'duplicate_worker' }
  }
  if (resumeExceeded(workers, runId, armedRecords, duration, leaseTtlMs)) {
    return { result: 'fail', hidden_duration_ms: duration, reason: 'improper_resume' }
  }
  if (!realHidden || duration === null || duration < 0) {
    return { result: 'inconclusive', hidden_duration_ms: null, reason: 'no_hidden_transition' }
  }
  if (duration < minDurationMs) {
    return { result: 'inconclusive', hidden_duration_ms: duration, reason: 'background_shorter_than_required' }
  }
  return { result: 'pass', hidden_duration_ms: duration, reason: 'background_observed' }
}

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

function openMeta() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HARNESS_META_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(VISIBILITY_STORE)) {
        db.createObjectStore(VISIBILITY_STORE, { keyPath: 'run_id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('meta open failed'))
    request.onblocked = () => reject(new Error('meta open blocked'))
  })
}

async function updateVisibilityCycleOnce(runId, mutator) {
  const db = await openMeta()
  try {
    const tx = db.transaction(VISIBILITY_STORE, 'readwrite')
    const store = tx.objectStore(VISIBILITY_STORE)
    const current = await requestToPromise(store.get(runId))
    const next = mutator(current || null)
    if (next) {
      store.put(next)
    }
    await transactionDone(tx)
    return next
  } finally {
    db.close()
  }
}

export function updateVisibilityCycle(runId, mutator) {
  const run = writeChain.then(() => updateVisibilityCycleOnce(runId, mutator))
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

export function createVisibilityCycle(runId) {
  return updateVisibilityCycle(runId, (current) => {
    if (current) {
      return current
    }
    return {
      run_id: runId,
      hidden_at: null,
      hidden_visibility_state: null,
      visible_at: null,
      hidden_duration_ms: null,
      records: [],
      workers: [],
    }
  })
}

export function readVisibilityCycle(runId) {
  return updateVisibilityCycle(runId, (current) => current)
}

async function readRecoverableCycleOnce() {
  const db = await openMeta()
  try {
    const tx = db.transaction(VISIBILITY_STORE, 'readonly')
    const rows = await requestToPromise(tx.objectStore(VISIBILITY_STORE).getAll())
    await transactionDone(tx)
    const pending = (rows || []).filter((row) => (
      row
      && Number.isInteger(row.hidden_at)
      && row.hidden_visibility_state === 'hidden'
      && !Number.isInteger(row.visible_at)
    ))
    pending.sort((left, right) => right.hidden_at - left.hidden_at)
    return pending[0] || null
  } finally {
    db.close()
  }
}

export function readRecoverableCycle() {
  const run = writeChain.then(() => readRecoverableCycleOnce())
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

export function recordHiddenTransition(runId, hiddenAt, visibilityState) {
  if (visibilityState !== 'hidden' || !Number.isInteger(hiddenAt) || hiddenAt <= 0) {
    return readVisibilityCycle(runId)
  }
  return updateVisibilityCycle(runId, (current) => {
    if (!current) {
      return current
    }
    if (Number.isInteger(current.hidden_at) && current.hidden_visibility_state === 'hidden') {
      return current
    }
    return {
      ...current,
      hidden_at: hiddenAt,
      hidden_visibility_state: 'hidden',
    }
  })
}

export function recordVisibleReturn(runId, visibleAt) {
  if (!Number.isInteger(visibleAt)) {
    return readVisibilityCycle(runId)
  }
  return updateVisibilityCycle(runId, (current) => {
    if (!current || !Number.isInteger(current.hidden_at) || current.hidden_visibility_state !== 'hidden') {
      return current
    }
    if (Number.isInteger(current.visible_at)) {
      return current
    }
    return {
      ...current,
      visible_at: visibleAt,
      hidden_duration_ms: visibleAt - current.hidden_at,
    }
  })
}

export function combineScenarioNine(foregroundResult, classificationResult) {
  return foregroundResult === 'fail' ? 'fail' : classificationResult
}

export function saveArmedSnapshot(runId, records, pageToken, foregroundResult) {
  return updateVisibilityCycle(runId, (current) => {
    if (!current) {
      return current
    }
    return {
      ...current,
      page_token: pageToken,
      records: records || [],
      foreground_result: foregroundResult === 'fail' ? 'fail' : foregroundResult || null,
    }
  })
}

export function noteWorkerStart(runId, queueId, startedAt) {
  return updateVisibilityCycle(runId, (current) => {
    if (!current) {
      return current
    }
    const workers = current.workers || []
    const exists = workers.some((worker) => (
      worker.queue_id === queueId && worker.started_at === startedAt && worker.run_id === runId
    ))
    if (exists) {
      return current
    }
    return {
      ...current,
      workers: [...workers, {
        queue_id: queueId,
        run_id: runId,
        started_at: startedAt,
        ended_at: null,
        in_flight: true,
      }],
    }
  })
}

export function noteWorkerEnd(runId, queueId, startedAt, endedAt) {
  return updateVisibilityCycle(runId, (current) => {
    if (!current) {
      return current
    }
    return {
      ...current,
      workers: (current.workers || []).map((worker) => (
        worker.queue_id === queueId && worker.started_at === startedAt && worker.in_flight
          ? { ...worker, in_flight: false, ended_at: endedAt }
          : worker
      )),
    }
  })
}

export function markDuplicateObserved(runId) {
  return updateVisibilityCycle(runId, (current) => {
    if (!current || current.duplicate_observed === true) {
      return current
    }
    return {
      ...current,
      duplicate_observed: true,
    }
  })
}

export function closeStaleWorkers(runId, endedAt) {
  return updateVisibilityCycle(runId, (current) => {
    if (!current) {
      return current
    }
    return {
      ...current,
      workers: (current.workers || []).map((worker) => (
        worker.in_flight
          ? { ...worker, in_flight: false, ended_at: endedAt, ended_reason: 'reloaded' }
          : worker
      )),
    }
  })
}

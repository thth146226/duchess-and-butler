export const PHOTO_UPLOAD_DIAGNOSTICS_LIMIT = 250
export const PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY = 'photo_upload_v1_diagnostics'
export const PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY = 'photo_upload_v1_diagnostics_enabled'

const SAFE_KEYS = new Set([
  'actor_scope_type',
  'refs_after',
  'refs_before',
  'hidden_since',
  'now',
  'computed_hidden_duration',
  'hidden_duration',
  'timestamp',
  'persisted',
  'runtime_found',
  'found',
  'woke',
  'resumed_count',
  'duration_ms',
  'source',
  'stopped',
  'manager_installed',
  'lease_ttl_ms',
  'will_retire',
  'active_slots',
  'locally_executed',
  'active_slots_before',
  'active_slots_before_start',
  'locally_executed_before',
  'active_slots_after',
  'locally_executed_after',
  'free_slots',
  'max_concurrent',
  'actor_record_count',
  'eligible_record_count',
  'status_not_eligible',
  'locally_executed_blocked',
  'lease_not_eligible',
  'retry_not_due',
  'other',
  'status',
  'queue_fragment',
  'started_count',
  'reason',
  'has_handle',
  'file_count',
  'accepted_count',
  'rejected_count',
  'rejected_codes',
  'error_class',
])

let memoryEvents = []
let memoryEnabled = false
let sequence = 0
let sessionStartedAt = Date.now()
const listeners = new Set()

function storage() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) {
      return null
    }
    return localStorage
  } catch (_error) {
    return null
  }
}

function hydrate() {
  const store = storage()
  if (!store) {
    return
  }
  try {
    const raw = store.getItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY)
    if (!raw) {
      return
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return
    }
    memoryEvents = parsed.slice(-PHOTO_UPLOAD_DIAGNOSTICS_LIMIT)
    sequence = memoryEvents.reduce((max, event) => Math.max(max, Number(event && event.sequence) || 0), 0)
  } catch (_error) {
    return
  }
}

hydrate()

function persist() {
  const store = storage()
  if (!store) {
    return
  }
  store.setItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY, JSON.stringify(memoryEvents))
}

function notify() {
  for (const listener of listeners) {
    try {
      listener()
    } catch (_error) {
      // Panel refresh must not affect the upload runtime.
    }
  }
}

export function abbreviateQueueId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  if (value.length <= 12) {
    return value.slice(0, 6)
  }
  return `${value.slice(0, 6)}…${value.slice(-6)}`
}

function sanitize(data) {
  if (!data || typeof data !== 'object') {
    return {}
  }
  const safe = {}
  for (const key of Object.keys(data)) {
    if (!SAFE_KEYS.has(key)) {
      continue
    }
    const value = data[key]
    if (key === 'rejected_codes' && value && typeof value === 'object') {
      const counts = {}
      for (const code of Object.keys(value)) {
        if (typeof code === 'string' && code.length > 0 && code.length <= 64) {
          counts[code] = Number(value[code]) || 0
        }
      }
      safe.rejected_codes = counts
      continue
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value
      continue
    }
    if (typeof value === 'string' && value.length <= 80) {
      safe[key] = value
    }
  }
  return safe
}

export function isPhotoUploadDiagnosticsEnabled() {
  const store = storage()
  if (store) {
    try {
      const flag = store.getItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY)
      if (flag === '1') {
        return true
      }
      if (flag === '0') {
        return false
      }
    } catch (_error) {
      return memoryEnabled
    }
  }
  return memoryEnabled
}

export function setPhotoUploadDiagnosticsEnabled(enabled) {
  memoryEnabled = Boolean(enabled)
  const store = storage()
  if (!store) {
    return
  }
  try {
    store.setItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY, memoryEnabled ? '1' : '0')
  } catch (_error) {
    return
  }
}

export function enablePhotoUploadDiagnosticsFromSearch(search) {
  try {
    const params = new URLSearchParams(typeof search === 'string' ? search : '')
    if (params.get('photoUploadDebug') === '1') {
      setPhotoUploadDiagnosticsEnabled(true)
    }
  } catch (_error) {
    return
  }
}

export function recordPhotoUploadDiagnostic(event, data) {
  try {
    if (!isPhotoUploadDiagnosticsEnabled()) {
      return
    }
    sequence += 1
    const nowMs = Date.now()
    memoryEvents.push({
      sequence,
      timestamp_ms: nowMs,
      relative_ms: nowMs - sessionStartedAt,
      event: typeof event === 'string' ? event.slice(0, 80) : '',
      ...sanitize(data),
    })
    if (memoryEvents.length > PHOTO_UPLOAD_DIAGNOSTICS_LIMIT) {
      memoryEvents = memoryEvents.slice(-PHOTO_UPLOAD_DIAGNOSTICS_LIMIT)
    }
    try {
      persist()
    } catch (_error) {
      // Persistence is best-effort. The in-memory trace remains.
    }
    notify()
  } catch (_error) {
    return
  }
}

export function readPhotoUploadDiagnostics() {
  try {
    return memoryEvents.map((event) => ({ ...event }))
  } catch (_error) {
    return []
  }
}

export function clearPhotoUploadDiagnostics() {
  try {
    memoryEvents = []
    sequence = 0
    const store = storage()
    if (store) {
      try {
        store.removeItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY)
      } catch (_error) {
        // Clearing storage is best-effort.
      }
    }
    notify()
  } catch (_error) {
    return
  }
}

export function subscribePhotoUploadDiagnostics(listener) {
  if (typeof listener !== 'function') {
    return () => {}
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function lastEvent(events, name) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index] && events[index].event === name) {
      return events[index]
    }
  }
  return null
}

export function summarizePhotoUploadDiagnostics(events) {
  const list = Array.isArray(events) ? events : []
  const hidden = lastEvent(list, 'VISIBILITY_HIDDEN')
  const visible = lastEvent(list, 'VISIBILITY_VISIBLE')
  const pageshow = lastEvent(list, 'PAGESHOW')
  const wakeBegin = lastEvent(list, 'WAKE_BEGIN')
  const wakeEnd = lastEvent(list, 'WAKE_END')
  const threshold = lastEvent(list, 'STALE_THRESHOLD_CHECK')
  const retireBegin = lastEvent(list, 'RETIRE_STALE_BEGIN')
  const retireEnd = lastEvent(list, 'RETIRE_STALE_END')
  const pumpBegin = lastEvent(list, 'PUMP_BEGIN')
  const pumpEnd = lastEvent(list, 'PUMP_END')
  const latestSlots = pumpEnd || pumpBegin || retireEnd || null
  return {
    LAST_VISIBILITY_HIDDEN: hidden ? hidden.timestamp_ms : null,
    LAST_VISIBILITY_VISIBLE: visible ? visible.timestamp_ms : null,
    LAST_PAGESHOW: pageshow ? pageshow.timestamp_ms : null,
    LAST_HIDDEN_DURATION_MS: visible && Number.isInteger(visible.computed_hidden_duration)
      ? visible.computed_hidden_duration
      : null,
    LAST_WAKE_BEGIN: wakeBegin ? wakeBegin.timestamp_ms : null,
    LAST_WAKE_END: wakeEnd ? wakeEnd.timestamp_ms : null,
    LAST_STALE_THRESHOLD_WILL_RETIRE: threshold ? threshold.will_retire === true : null,
    LAST_RETIRE_BEGIN: retireBegin ? retireBegin.timestamp_ms : null,
    LAST_RETIRE_END: retireEnd ? retireEnd.timestamp_ms : null,
    LAST_PUMP_BEGIN: pumpBegin ? pumpBegin.timestamp_ms : null,
    LAST_PUMP_END: pumpEnd ? pumpEnd.timestamp_ms : null,
    LAST_ACTIVE_SLOTS: latestSlots && Number.isInteger(latestSlots.active_slots)
      ? latestSlots.active_slots
      : (latestSlots && Number.isInteger(latestSlots.active_slots_after) ? latestSlots.active_slots_after : null),
    LAST_LOCALLY_EXECUTED: latestSlots && Number.isInteger(latestSlots.locally_executed)
      ? latestSlots.locally_executed
      : (latestSlots && Number.isInteger(latestSlots.locally_executed_after) ? latestSlots.locally_executed_after : null),
    LAST_FREE_SLOTS: latestSlots && Number.isInteger(latestSlots.free_slots) ? latestSlots.free_slots : null,
  }
}

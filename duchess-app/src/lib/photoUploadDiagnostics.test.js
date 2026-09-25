import {
  PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY,
  PHOTO_UPLOAD_DIAGNOSTICS_LIMIT,
  PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY,
  clearPhotoUploadDiagnostics,
  enablePhotoUploadDiagnosticsFromSearch,
  isPhotoUploadDiagnosticsEnabled,
  readPhotoUploadDiagnostics,
  recordPhotoUploadDiagnostic,
  setPhotoUploadDiagnosticsEnabled,
} from './photoUploadDiagnostics'

describe('photo upload diagnostics', () => {
  afterEach(() => {
    setPhotoUploadDiagnosticsEnabled(false)
    clearPhotoUploadDiagnostics()
    localStorage.removeItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY)
    localStorage.removeItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY)
  })

  test('disabled record is a no-op and does not change a lifecycle result', () => {
    setPhotoUploadDiagnosticsEnabled(false)
    clearPhotoUploadDiagnostics()
    function wakeLike() {
      recordPhotoUploadDiagnostic('WAKE_BEGIN', { hidden_duration: 30 })
      return { woke: true, resumed: 0 }
    }
    expect(wakeLike()).toEqual({ woke: true, resumed: 0 })
    expect(readPhotoUploadDiagnostics()).toEqual([])
  })

  test('localStorage failure does not throw from a lifecycle call', () => {
    setPhotoUploadDiagnosticsEnabled(true)
    const setItem = Storage.prototype.setItem
    const getItem = Storage.prototype.getItem
    Storage.prototype.setItem = () => {
      throw new Error('quota')
    }
    Storage.prototype.getItem = () => {
      throw new Error('quota')
    }
    try {
      function wakeLike() {
        recordPhotoUploadDiagnostic('STORE_WAKE_BEGIN', { hidden_duration: 30000 })
        recordPhotoUploadDiagnostic('WAKE_END', { woke: true, resumed_count: 1 })
        return { woke: true, resumed: 1 }
      }
      expect(wakeLike()).toEqual({ woke: true, resumed: 1 })
      expect(readPhotoUploadDiagnostics().map((event) => event.event)).toEqual([
        'STORE_WAKE_BEGIN',
        'WAKE_END',
      ])
    } finally {
      Storage.prototype.setItem = setItem
      Storage.prototype.getItem = getItem
    }
  })

  test('ring buffer caps at the configured maximum', () => {
    setPhotoUploadDiagnosticsEnabled(true)
    clearPhotoUploadDiagnostics()
    for (let index = 0; index < PHOTO_UPLOAD_DIAGNOSTICS_LIMIT + 10; index += 1) {
      recordPhotoUploadDiagnostic('PUMP_BEGIN', { active_slots: index })
    }
    const events = readPhotoUploadDiagnostics()
    expect(events).toHaveLength(PHOTO_UPLOAD_DIAGNOSTICS_LIMIT)
    expect(events[0].sequence).toBe(11)
    expect(events[events.length - 1].sequence).toBe(PHOTO_UPLOAD_DIAGNOSTICS_LIMIT + 10)
    const stored = JSON.parse(localStorage.getItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY))
    expect(stored).toHaveLength(PHOTO_UPLOAD_DIAGNOSTICS_LIMIT)
  })

  test('clear removes the trace', () => {
    setPhotoUploadDiagnosticsEnabled(true)
    recordPhotoUploadDiagnostic('ONLINE', {})
    expect(readPhotoUploadDiagnostics()).toHaveLength(1)
    clearPhotoUploadDiagnostics()
    expect(readPhotoUploadDiagnostics()).toEqual([])
    expect(localStorage.getItem(PHOTO_UPLOAD_DIAGNOSTICS_STORAGE_KEY)).toBeNull()
    recordPhotoUploadDiagnostic('ONLINE', {})
    expect(readPhotoUploadDiagnostics()[0].sequence).toBe(1)
  })

  test('enabled flag persists and stays on without the query parameter', () => {
    setPhotoUploadDiagnosticsEnabled(false)
    expect(isPhotoUploadDiagnosticsEnabled()).toBe(false)
    enablePhotoUploadDiagnosticsFromSearch('?photoUploadDebug=1')
    expect(isPhotoUploadDiagnosticsEnabled()).toBe(true)
    expect(localStorage.getItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY)).toBe('1')
    enablePhotoUploadDiagnosticsFromSearch('')
    expect(isPhotoUploadDiagnosticsEnabled()).toBe(true)
    setPhotoUploadDiagnosticsEnabled(false)
    expect(localStorage.getItem(PHOTO_UPLOAD_DIAGNOSTICS_ENABLED_KEY)).toBe('0')
    expect(isPhotoUploadDiagnosticsEnabled()).toBe(false)
  })

  test('record drops identifiers that are not on the safe field list', () => {
    setPhotoUploadDiagnosticsEnabled(true)
    clearPhotoUploadDiagnostics()
    recordPhotoUploadDiagnostic('RUNTIME_LOOKUP', {
      actor_scope_type: 'driver_portal',
      actor_scope_id: 'full-user-id',
      file_name: 'secret.jpg',
      found: false,
    })
    const event = readPhotoUploadDiagnostics()[0]
    expect(event.actor_scope_type).toBe('driver_portal')
    expect(event.found).toBe(false)
    expect(event.actor_scope_id).toBeUndefined()
    expect(event.file_name).toBeUndefined()
  })
})

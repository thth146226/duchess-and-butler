import { useEffect, useState } from 'react'
import {
  clearPhotoUploadDiagnostics,
  isPhotoUploadDiagnosticsEnabled,
  readPhotoUploadDiagnostics,
  subscribePhotoUploadDiagnostics,
  summarizePhotoUploadDiagnostics,
} from '../lib/photoUploadDiagnostics'

function formatTrace(events) {
  return events.map((event) => JSON.stringify(event)).join('\n')
}

export default function PhotoUploadDiagnosticPanel() {
  const [enabled, setEnabled] = useState(() => {
    try {
      return isPhotoUploadDiagnosticsEnabled()
    } catch (_error) {
      return false
    }
  })
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState([])
  const [copyNote, setCopyNote] = useState('')

  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    function refresh() {
      try {
        setEvents(readPhotoUploadDiagnostics())
      } catch (_error) {
        setEvents([])
      }
    }
    refresh()
    return subscribePhotoUploadDiagnostics(refresh)
  }, [enabled])

  if (!enabled) {
    return null
  }

  const summary = summarizePhotoUploadDiagnostics(events)
  const trace = formatTrace(events)

  async function copyTrace() {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(trace)
        setCopyNote('Copied')
        return
      }
    } catch (_error) {
      // Fall through to the selectable trace.
    }
    setCopyNote('Select the trace below')
  }

  return (
    <div style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 100000, fontFamily: 'ui-monospace, monospace' }}>
      {open ? (
        <div style={{ width: 'min(420px, calc(100vw - 24px))', maxHeight: '70vh', overflow: 'auto', background: '#111', color: '#f5f5f5', borderRadius: 8, padding: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <strong>Upload Debug</strong>
            <span>{events.length} events</span>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, margin: '0 0 8px' }}>{JSON.stringify(summary, null, 2)}</pre>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button type="button" onClick={() => setEvents(readPhotoUploadDiagnostics())}>Refresh</button>
            <button type="button" onClick={() => { clearPhotoUploadDiagnostics(); setCopyNote('') }}>Clear</button>
            <button type="button" onClick={() => { void copyTrace() }}>Copy</button>
            <button type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
          {copyNote ? <div style={{ fontSize: 11, marginBottom: 8 }}>{copyNote}</div> : null}
          <textarea readOnly value={trace} style={{ width: '100%', minHeight: 180, fontSize: 11 }} />
        </div>
      ) : (
        <button type="button" onClick={() => { setOpen(true); setEvents(readPhotoUploadDiagnostics()) }}>
          Upload Debug
        </button>
      )}
    </div>
  )
}

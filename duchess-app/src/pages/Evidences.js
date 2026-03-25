import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const RUN_TYPES = {
  after_del: { label: 'After DEL', bg: '#FCEBEB', color: '#A32D2D', border: '#FCA5A5' },
  pre_col:   { label: 'Pre-COL',   bg: '#FEF3C7', color: '#B8965A', border: '#DDD8CF' },
  after_col: { label: 'After COL', bg: '#EAF3DE', color: '#3B6D11', border: '#86EFAC' },
}

export default function Evidences() {
  const [photos, setPhotos]           = useState([])
  const [filter, setFilter]           = useState('all')
  const [driverFilter, setDriver]     = useState('all')
  const [dateFilter, setDate]         = useState('all')
  const [search, setSearch]           = useState('')
  const [selected, setSelected]       = useState(new Set())
  const [lightbox, setLightbox]       = useState(null)
  const [loading, setLoading]         = useState(true)
  const [emailPanel, setEmailPanel]   = useState(false)
  const [emailForm, setEmailForm]     = useState({ to: '', subject: '', message: '' })
  const [sending, setSending]         = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [toast, setToast]             = useState(null)

  useEffect(() => {
    fetchPhotos()
    const channel = supabase.channel('evidence-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'evidence_photos' }, fetchPhotos)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function fetchPhotos() {
    const { data } = await supabase
      .from('evidence_photos')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setPhotos(data)
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function deletePhoto(id, filePath) {
    if (filePath) await supabase.storage.from('evidence-photos').remove([filePath])
    await supabase.from('evidence_photos').delete().eq('id', id)
    setLightbox(null)
    setSelected(s => { const n = new Set(s); n.delete(id); return n })
    fetchPhotos()
  }

  function toggleSelect(id) {
    setSelected(s => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  function selectAllForJob(jobPhotos) {
    setSelected(s => {
      const n = new Set(s)
      const allSelected = jobPhotos.every(p => n.has(p.id))
      jobPhotos.forEach(p => allSelected ? n.delete(p.id) : n.add(p.id))
      return n
    })
  }

  async function downloadZip() {
    const selectedPhotos = photos.filter(p => selected.has(p.id))
    if (!selectedPhotos.length) return
    setDownloading(true)

    try {
      const JSZip = (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js')).default
      const zip = new JSZip()

      for (const photo of selectedPhotos) {
        const response = await fetch(photo.photo_url)
        const blob = await response.blob()
        const ext = photo.photo_url.split('.').pop().split('?')[0] || 'jpg'
        const rt = RUN_TYPES[photo.run_type]?.label || photo.run_type
        const name = `${photo.event_name || 'job'}_${rt}_${photo.uploaded_by_name || 'team'}_${photo.id.slice(0,8)}.${ext}`
        zip.file(name.replace(/[^a-zA-Z0-9._-]/g, '_'), blob)
      }

      const content = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(content)
      const a = document.createElement('a')
      a.href = url
      a.download = `evidence_photos_${Date.now()}.zip`
      a.click()
      URL.revokeObjectURL(url)
      showToast(`Downloaded ${selectedPhotos.length} photos`)
    } catch(e) {
      showToast('Download failed: ' + e.message, 'error')
    }
    setDownloading(false)
  }

  async function sendEmail() {
    const selectedPhotos = photos.filter(p => selected.has(p.id))
    if (!selectedPhotos.length || !emailForm.to) return
    setSending(true)

    const firstPhoto = selectedPhotos[0]
    try {
      const res = await fetch('/api/send-evidence-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:       emailForm.to,
          subject:  emailForm.subject || `${firstPhoto.event_name} — Evidence Photos`,
          message:  emailForm.message,
          photos:   selectedPhotos,
          jobName:  firstPhoto.event_name || 'Event',
          crmsRef:  firstPhoto.crms_ref || '',
        }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('Email sent successfully')
        setEmailPanel(false)
        setEmailForm({ to: '', subject: '', message: '' })
      } else {
        showToast('Email failed: ' + data.error, 'error')
      }
    } catch(e) {
      showToast('Email failed: ' + e.message, 'error')
    }
    setSending(false)
  }

  const today = new Date().toISOString().split('T')[0]
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString()
  const drivers = [...new Set(photos.map(p => p.uploaded_by_name).filter(Boolean))]

  const filtered = photos.filter(p => {
    const matchType   = filter === 'all' || p.run_type === filter
    const matchDriver = driverFilter === 'all' || p.uploaded_by_name === driverFilter
    const matchDate   = dateFilter === 'all' ? true
                      : dateFilter === 'today' ? p.created_at?.startsWith(today)
                      : dateFilter === 'week'  ? p.created_at >= weekAgo
                      : dateFilter === 'month' ? p.created_at >= monthAgo
                      : true
    const matchSearch = !search ||
      p.event_name?.toLowerCase().includes(search.toLowerCase()) ||
      p.crms_ref?.toLowerCase().includes(search.toLowerCase()) ||
      p.uploaded_by_name?.toLowerCase().includes(search.toLowerCase())
    return matchType && matchDriver && matchDate && matchSearch
  })

  const grouped = {}
  for (const p of filtered) {
    const key = p.order_id || p.id
    if (!grouped[key]) grouped[key] = { event_name: p.event_name, crms_ref: p.crms_ref, photos: [] }
    grouped[key].photos.push(p)
  }

  const selectedPhotos = photos.filter(p => selected.has(p.id))
  const firstSelected = selectedPhotos[0]

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading evidence…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total photos', value: photos.length, color: '#1C1C1E' },
          { label: 'After DEL', value: photos.filter(p => p.run_type === 'after_del').length, color: '#A32D2D' },
          { label: 'Pre-COL', value: photos.filter(p => p.run_type === 'pre_col').length, color: '#B8965A' },
          { label: 'After COL', value: photos.filter(p => p.run_type === 'after_col').length, color: '#3B6D11' },
        ].map(s => (
          <div key={s.label} style={{ background: '#F7F3EE', borderRadius: '8px', padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: s.color, fontWeight: '500', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            <div style={{ fontSize: '28px', fontWeight: '500', color: s.color, lineHeight: 1 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search event name, job ref, driver…"
          style={{ padding: '9px 14px', border: '1.5px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#6B6860', fontWeight: '500' }}>Type:</span>
          {[['all','All'], ['after_del','After DEL'], ['pre_col','Pre-COL'], ['after_col','After COL']].map(([val, lbl]) => (
            <button key={val} onClick={() => setFilter(val)} style={{
              fontSize: '12px', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer',
              fontFamily: "'DM Sans', sans-serif", fontWeight: '500',
              background: filter === val ? '#1C1C1E' : 'transparent',
              color: filter === val ? '#fff' : '#6B6860',
              border: `1px solid ${filter === val ? '#1C1C1E' : '#DDD8CF'}`,
            }}>{lbl}</button>
          ))}
          <span style={{ fontSize: '11px', color: '#6B6860', fontWeight: '500', marginLeft: '8px' }}>Date:</span>
          {[['all','All time'], ['today','Today'], ['week','This week'], ['month','This month']].map(([val, lbl]) => (
            <button key={val} onClick={() => setDate(val)} style={{
              fontSize: '12px', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer',
              fontFamily: "'DM Sans', sans-serif", fontWeight: '500',
              background: dateFilter === val ? '#1C1C1E' : 'transparent',
              color: dateFilter === val ? '#fff' : '#6B6860',
              border: `1px solid ${dateFilter === val ? '#1C1C1E' : '#DDD8CF'}`,
            }}>{lbl}</button>
          ))}
          <select value={driverFilter} onChange={e => setDriver(e.target.value)} style={{ fontSize: '12px', padding: '5px 12px', borderRadius: '20px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
            <option value="all">All drivers</option>
            {drivers.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>

      {/* Grouped photos */}
      {Object.keys(grouped).length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 24px', color: '#6B6860' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📷</div>
          <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '6px' }}>No evidence photos yet</div>
          <div style={{ fontSize: '13px', color: '#9CA3AF' }}>Upload photos from a job in the Schedule or Live Jobs</div>
        </div>
      ) : Object.entries(grouped).map(([jobId, group]) => {
        const jobPhotos = group.photos
        const allJobSelected = jobPhotos.every(p => selected.has(p.id))
        return (
          <div key={jobId} style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #DDD8CF', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '500' }}>{group.event_name || 'Unknown event'}</div>
                {group.crms_ref && <div style={{ fontSize: '11px', color: '#6B6860' }}>{group.crms_ref} · {jobPhotos.length} photo{jobPhotos.length !== 1 ? 's' : ''}</div>}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => selectAllForJob(jobPhotos)}
                  style={{ fontSize: '11px', fontWeight: '500', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: allJobSelected ? '#EAF3DE' : '#F7F3EE', color: allJobSelected ? '#3B6D11' : '#6B6860', border: `1px solid ${allJobSelected ? '#86EFAC' : '#DDD8CF'}` }}
                >{allJobSelected ? '✓ All selected' : 'Select all'}</button>
              </div>
            </div>
            <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' }}>
              {jobPhotos.map(p => {
                const rt = RUN_TYPES[p.run_type] || RUN_TYPES.after_del
                const isSelected = selected.has(p.id)
                return (
                  <div
                    key={p.id}
                    onClick={() => toggleSelect(p.id)}
                    style={{ borderRadius: '8px', overflow: 'hidden', border: `${isSelected ? '2px' : '1.5px'} solid ${isSelected ? '#1D9E75' : rt.border}`, background: rt.bg, cursor: 'pointer', position: 'relative' }}
                  >
                    {isSelected && (
                      <div style={{ position: 'absolute', top: '6px', right: '6px', width: '20px', height: '20px', borderRadius: '50%', background: '#1D9E75', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '11px', fontWeight: '700', zIndex: 1 }}>✓</div>
                    )}
                    {!isSelected && (
                      <div style={{ position: 'absolute', top: '6px', right: '6px', width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(255,255,255,0.8)', border: '1.5px solid #DDD8CF', zIndex: 1 }} />
                    )}
                    <img
                      src={p.photo_url}
                      alt="Evidence"
                      style={{ width: '100%', height: '110px', objectFit: 'cover', display: 'block' }}
                      onClick={e => { e.stopPropagation(); setLightbox(p) }}
                    />
                    <div style={{ padding: '7px 8px' }}>
                      <span style={{ fontSize: '10px', fontWeight: '600', padding: '1px 6px', borderRadius: '3px', background: rt.bg, color: rt.color }}>{rt.label}</span>
                      <div style={{ fontSize: '10px', color: '#6B6860', marginTop: '3px' }}>{p.uploaded_by_name} · {new Date(p.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* Share bar */}
      {selected.size > 0 && (
        <div style={{ position: 'sticky', bottom: '24px', background: '#1C1C1E', borderRadius: '10px', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 8px 32px rgba(0,0,0,0.2)', zIndex: 50, flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: '13px' }}>
            {selected.size} photo{selected.size !== 1 ? 's' : ''} selected
            <button onClick={() => setSelected(new Set())} style={{ marginLeft: '12px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}>Clear</button>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={downloadZip}
              disabled={downloading}
              style={{ background: '#B8965A', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 18px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
            >{downloading ? 'Downloading…' : `↓ Download ZIP (${selected.size})`}</button>
            <button
              onClick={() => {
                setEmailForm(f => ({ ...f, subject: firstSelected ? `${firstSelected.event_name} — Evidence Photos` : 'Evidence Photos' }))
                setEmailPanel(true)
              }}
              style={{ background: '#378ADD', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 18px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
            >{`✉ Send by email (${selected.size})`}</button>
          </div>
        </div>
      )}

      {/* Email panel overlay */}
      {emailPanel && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={e => e.target === e.currentTarget && setEmailPanel(false)}>
          <div style={{ background: '#fff', borderRadius: '12px', width: '100%', maxWidth: '480px', padding: '28px', boxShadow: '0 12px 48px rgba(28,28,30,0.14)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div>
                <div style={{ fontSize: '16px', fontWeight: '500' }}>Send evidence photos</div>
                <div style={{ fontSize: '12px', color: '#6B6860', marginTop: '2px' }}>{firstSelected?.event_name} · {selected.size} photo{selected.size !== 1 ? 's' : ''} selected</div>
              </div>
              <button onClick={() => setEmailPanel(false)} style={{ background: '#F7F3EE', border: 'none', width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer', fontSize: '13px' }}>✕</button>
            </div>

            {[
              { label: 'To (client email)', key: 'to', type: 'email', placeholder: 'client@example.com' },
              { label: 'Subject', key: 'subject', type: 'text', placeholder: 'Evidence photos...' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '10px', fontWeight: '500', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '5px' }}>{f.label}</div>
                <input
                  type={f.type}
                  value={emailForm[f.key]}
                  onChange={e => setEmailForm(ef => ({ ...ef, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            ))}

            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '10px', fontWeight: '500', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '5px' }}>Message (optional)</div>
              <textarea
                value={emailForm.message}
                onChange={e => setEmailForm(ef => ({ ...ef, message: e.target.value }))}
                placeholder="Please find attached the evidence photos for your event..."
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', boxSizing: 'border-box', minHeight: '80px', resize: 'vertical' }}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '10px', fontWeight: '500', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '8px' }}>Photos to send ({selected.size})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {selectedPhotos.slice(0, 6).map(p => (
                  <span key={p.id} style={{ background: '#F7F3EE', border: '1px solid #DDD8CF', borderRadius: '20px', padding: '3px 10px', fontSize: '11px', color: '#6B6860' }}>
                    {RUN_TYPES[p.run_type]?.label} · {p.uploaded_by_name}
                  </span>
                ))}
                {selectedPhotos.length > 6 && <span style={{ fontSize: '11px', color: '#9CA3AF', padding: '3px 0' }}>+{selectedPhotos.length - 6} more</span>}
              </div>
            </div>

            <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '6px', padding: '8px 12px', marginBottom: '16px', fontSize: '11px', color: '#1D4ED8' }}>
              Photos are sent as direct links — no attachment size limit.
            </div>

            <button
              onClick={sendEmail}
              disabled={sending || !emailForm.to}
              style={{ width: '100%', padding: '11px', background: !emailForm.to ? '#DDD8CF' : '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: !emailForm.to ? 'default' : 'pointer', fontFamily: "'DM Sans', sans-serif" }}
            >{sending ? 'Sending…' : 'Send email'}</button>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={() => setLightbox(null)}>
          <div style={{ background: '#fff', borderRadius: '10px', maxWidth: '600px', width: '100%', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}>
            <img src={lightbox.photo_url} alt="Evidence" style={{ width: '100%', maxHeight: '65vh', objectFit: 'contain', display: 'block' }} />
            <div style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '2px' }}>{lightbox.event_name || 'Evidence photo'}</div>
                <div style={{ fontSize: '12px', color: '#6B6860' }}>{RUN_TYPES[lightbox.run_type]?.label} · by {lightbox.uploaded_by_name}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <button onClick={() => deletePhoto(lightbox.id, lightbox.file_path)}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px', border: '1px solid #EF4444', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
                  Delete
                </button>
                <button onClick={() => setLightbox(null)}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px', border: '1px solid #DDD8CF', background: '#F7F3EE', color: '#1C1C1E', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: '80px', right: '24px', background: '#1C1C1E', color: '#fff', padding: '12px 20px', borderRadius: '8px', fontSize: '13px', borderLeft: `3px solid ${toast.type === 'error' ? '#EF4444' : '#10B981'}`, zIndex: 999 }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}


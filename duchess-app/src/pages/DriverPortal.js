import { useEffect, useState, useRef } from 'react'
import { supabasePublic as supabase } from '../lib/supabase'

const RUN_TYPES = [
  { value: 'after_del', label: 'After DEL', bg: '#FCEBEB', color: '#A32D2D', border: '#FCA5A5' },
  { value: 'pre_col',   label: 'Pre-COL',   bg: '#FEF3C7', color: '#B8965A', border: '#DDD8CF' },
  { value: 'after_col', label: 'After COL', bg: '#EAF3DE', color: '#3B6D11', border: '#86EFAC' },
]

function fmt(d) {
  if (!d) return '—'
  return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

export default function DriverPortal({ token }) {
  const [driver, setDriver]       = useState(null)
  const [jobs, setJobs]           = useState([])
  const [selectedJob, setSelected]= useState(null)
  const [tab, setTab]             = useState('details')
  const [notes, setNotes]         = useState([])
  const [items, setItems]         = useState([])
  const [photos, setPhotos]       = useState([])
  const [runType, setRunType]     = useState('after_del')
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const fileRef = useRef()
  const galleryRef = useRef()

  const today = new Date().toISOString().split('T')[0]

  useEffect(() => { if (token) fetchDriver() }, [token])

  async function fetchDriver() {
    const { data, error } = await supabase
      .from('drivers')
      .select('*')
      .eq('access_token', token)
      .single()
    if (error || !data) { 
      setError('Invalid or expired link.') 
      setLoading(false)
      return 
    }
    setDriver(data)
    fetchJobs(data.name)
  }

  async function fetchJobs(driverName) {
    const { data } = await supabase
      .from('crms_jobs')
      .select('*')
      .not('status', 'eq', 'cancelled')
      .or(`assigned_driver_name.eq."${driverName}",assigned_driver_name_2.eq."${driverName}"`)
      .order('delivery_date', { ascending: true, nullsLast: true })
    if (data) setJobs(data)
    setLoading(false)
  }

  async function openJob(job) {
    setSelected(job)
    setTab('details')
    const [{ data: notesData }, { data: itemsData }, { data: photosData }] = await Promise.all([
      supabase.from('job_notes').select('*').eq('job_id', job.id).order('created_at', { ascending: false }),
      supabase.from('crms_job_items').select('*').eq('job_id', job.id),
      supabase.from('evidence_photos').select('*').eq('order_id', job.id).order('created_at', { ascending: false }),
    ])
    if (notesData) setNotes(notesData)
    if (itemsData) setItems(itemsData)
    if (photosData) setPhotos(photosData)
  }

  async function handleUpload(e) {
    const files = Array.from(e.target.files)
    if (!files.length || !selectedJob) return
    setUploading(true)
    for (const file of files) {
      const ext = file.name.split('.').pop()
      const fileName = `${selectedJob.id}/${runType}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from('evidence-photos')
        .upload(fileName, file, { contentType: file.type })
      if (uploadError) { console.error(uploadError); continue }
      const { data: { publicUrl } } = supabase.storage.from('evidence-photos').getPublicUrl(fileName)
      await supabase.from('evidence_photos').insert({
        order_id:         selectedJob.id,
        job_table:        'crms_jobs',
        crms_ref:         selectedJob.crms_ref || null,
        event_name:       selectedJob.event_name || null,
        run_type:         runType,
        photo_url:        publicUrl,
        file_path:        fileName,
        uploaded_by_name: driver?.name || 'Driver',
        driver_name:      driver?.name || null,
      })
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
    if (galleryRef.current) galleryRef.current.value = ''
    const { data } = await supabase.from('evidence_photos').select('*').eq('order_id', selectedJob.id).order('created_at', { ascending: false })
    if (data) setPhotos(data)
  }

  function openMaps(address) {
    const query = encodeURIComponent(address)
    window.open(`https://maps.google.com/?q=${query}`, '_blank')
  }

  const CAT_NOTE = {
    urgent:    { bg: '#FCEBEB', border: '#A32D2D', badgeBg: '#FCA5A5', badgeColor: '#7F1D1D' },
    equipment: { bg: '#FEF3C7', border: '#BA7517', badgeBg: '#FDE68A', badgeColor: '#633806' },
    access:    { bg: '#E6F1FB', border: '#185FA5', badgeBg: '#BFDBFE', badgeColor: '#1E3A5F' },
    contact:   { bg: '#EAF3DE', border: '#3B6D11', badgeBg: '#BBF7D0', badgeColor: '#14532D' },
    general:   { bg: '#F7F3EE', border: '#B8965A', badgeBg: '#DDD8CF', badgeColor: '#5F5E5A' },
  }

  // Build runs from jobs
  const runs = []
  for (const j of jobs) {
    if (j.delivery_date) runs.push({ job: j, type: 'DEL', date: j.delivery_date, time: j.delivery_time })
    if (j.collection_date) runs.push({ job: j, type: 'COL', date: j.collection_date, time: j.collection_time })
  }
  runs.sort((a, b) => {
    const d = a.date.localeCompare(b.date)
    return d !== 0 ? d : (a.time || '99:99').localeCompare(b.time || '99:99')
  })

  const todayRuns = runs.filter(r => r.date === today)
  const upcomingRuns = runs.filter(r => r.date > today)

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F3EE', fontFamily: "'DM Sans', sans-serif", fontSize: '16px', color: '#6B6860' }}>
      Loading…
    </div>
  )

  if (error) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F3EE', fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '12px', padding: '40px', textAlign: 'center', maxWidth: '320px' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
        <div style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px' }}>Invalid link</div>
        <div style={{ fontSize: '13px', color: '#6B6860' }}>{error}</div>
      </div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: '#F7F3EE', fontFamily: "'DM Sans', sans-serif" }}>

      {/* Header */}
      <div style={{ background: '#1C1C1E', padding: '0' }}>
        <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '18px', color: '#D4AF7A', letterSpacing: '0.04em' }}>Duchess & Butler</div>
            <div style={{ fontSize: '10px', letterSpacing: '0.15em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' }}>Driver Portal</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: driver?.colour || '#B8965A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '600', color: '#fff' }}>
              {driver?.name?.[0]}
            </div>
            <div>
              <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.8)', fontWeight: '500' }}>{driver?.name}</div>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)' }}>Driver · Read only</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>

        {/* Today */}
        {todayRuns.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#B8965A', marginBottom: '10px' }}>
              Today — {fmt(today)} · {todayRuns.length} run{todayRuns.length !== 1 ? 's' : ''}
            </div>
            {todayRuns.map((r, i) => <RunCard key={i} run={r} onOpen={() => openJob(r.job)} />)}
          </div>
        )}

        {todayRuns.length === 0 && (
          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '24px', textAlign: 'center', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', color: '#6B6860' }}>No runs assigned to you today</div>
          </div>
        )}

        {/* Upcoming */}
        {upcomingRuns.length > 0 && (
          <div>
            <div style={{ fontSize: '11px', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '10px' }}>
              Upcoming — {upcomingRuns.length} run{upcomingRuns.length !== 1 ? 's' : ''}
            </div>
            {upcomingRuns.map((r, i) => <RunCard key={i} run={r} onOpen={() => openJob(r.job)} />)}
          </div>
        )}
      </div>

      {/* Job detail panel */}
      {selectedJob && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'flex-end' }}
          onClick={() => setSelected(null)}>
          <div style={{ background: '#fff', width: '100%', maxHeight: '90vh', borderRadius: '16px 16px 0 0', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}>

            {/* Panel header */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #DDD8CF', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '2px' }}>{selectedJob.event_name}</div>
                  <div style={{ fontSize: '12px', color: '#6B6860' }}>{selectedJob.crms_ref} · {selectedJob.venue}</div>
                </div>
                <button onClick={() => setSelected(null)} style={{ background: '#F7F3EE', border: 'none', width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer', fontSize: '13px', flexShrink: 0 }}>✕</button>
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', gap: '0', marginTop: '12px', borderBottom: '1px solid #DDD8CF' }}>
                {[['details','Details'], ['notes','Notes'], ['items','Items'], ['evidence','Evidence']].map(([id, label]) => (
                  <button key={id} onClick={() => setTab(id)} style={{
                    padding: '8px 14px', background: 'transparent', border: 'none',
                    borderBottom: `2px solid ${tab === id ? '#B8965A' : 'transparent'}`,
                    color: tab === id ? '#B8965A' : '#6B6860',
                    fontSize: '12px', fontWeight: tab === id ? '600' : '400',
                    cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                  }}>{label}</button>
                ))}
              </div>
            </div>

            <div style={{ padding: '16px 20px' }}>

              {/* Details tab */}
              {tab === 'details' && (
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px' }}>
                    {[
                      { label: 'Delivery', value: selectedJob.delivery_date ? `${selectedJob.delivery_date} ${selectedJob.delivery_time || ''}` : '—' },
                      { label: 'Collection', value: selectedJob.collection_date ? `${selectedJob.collection_date} ${selectedJob.collection_time || ''}` : '—' },
                      { label: 'Venue', value: selectedJob.venue || '—' },
                      { label: 'Client', value: selectedJob.client_name || '—' },
                    ].map(f => (
                      <div key={f.label} style={{ background: '#F7F3EE', borderRadius: '8px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>{f.label}</div>
                        <div style={{ fontSize: '12px', fontWeight: '500' }}>{f.value}</div>
                      </div>
                    ))}
                  </div>

                  {selectedJob.venue_address && (
                    <button
                      onClick={() => openMaps(selectedJob.venue_address)}
                      style={{ width: '100%', padding: '11px', background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE', borderRadius: '8px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
                    >📍 Open in Google Maps</button>
                  )}
                </div>
              )}

              {/* Notes tab */}
              {tab === 'notes' && (
                <div>
                  {notes.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '24px', color: '#9CA3AF', fontSize: '13px' }}>No notes for this job</div>
                  ) : notes.map(n => {
                    const c = CAT_NOTE[n.category] || CAT_NOTE.general
                    return (
                      <div key={n.id} style={{ background: c.bg, borderLeft: `3px solid ${c.border}`, borderRadius: '8px', padding: '12px 14px', marginBottom: '10px' }}>
                        <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '4px', background: c.badgeBg, color: c.badgeColor }}>
                          {n.category.toUpperCase()}
                        </span>
                        <div style={{ fontSize: '13px', marginTop: '8px', lineHeight: '1.5' }}>{n.note_text}</div>
                        <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '4px' }}>by {n.created_by_name}</div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Items tab */}
              {tab === 'items' && (
                <div>
                  {items.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '24px', color: '#9CA3AF', fontSize: '13px' }}>No items synced</div>
                  ) : items.filter(i => parseInt(i.quantity) > 0).map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '0.5px solid #EDE8E0' }}>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: '500' }}>{item.item_name}</div>
                        <div style={{ fontSize: '11px', color: '#6B6860', textTransform: 'capitalize' }}>{item.category}</div>
                      </div>
                      <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', fontWeight: '600', color: '#1C1C1E' }}>{item.quantity}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Evidence tab */}
              {tab === 'evidence' && (
                <div>
                  <div style={{ border: '1.5px dashed #DDD8CF', borderRadius: '8px', padding: '16px', background: '#F7F3EE', marginBottom: '16px', textAlign: 'center' }}>
                    <div style={{ fontSize: '13px', fontWeight: '500', marginBottom: '4px' }}>Upload evidence photos</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '12px' }}>Select type then choose from camera or gallery</div>
                    <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
                      {RUN_TYPES.map(rt => (
                        <button key={rt.value} onClick={() => setRunType(rt.value)} style={{
                          fontSize: '11px', fontWeight: '600', padding: '6px 14px', borderRadius: '20px', cursor: 'pointer',
                          fontFamily: "'DM Sans', sans-serif",
                          background: runType === rt.value ? rt.bg : 'transparent',
                          color: runType === rt.value ? rt.color : '#6B6860',
                          border: `1.5px solid ${runType === rt.value ? rt.border : '#DDD8CF'}`,
                        }}>{rt.label}</button>
                      ))}
                    </div>
                    <input ref={fileRef} type="file" accept="image/*" multiple capture="environment" style={{ display: 'none' }} onChange={handleUpload} />
                    <input ref={galleryRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleUpload} />
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                      <button onClick={() => fileRef.current.click()} disabled={uploading} style={{ fontSize: '12px', fontWeight: '500', padding: '9px 18px', borderRadius: '6px', border: 'none', background: '#1C1C1E', color: '#fff', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
                        {uploading ? 'Uploading…' : '📷 Take photo'}
                      </button>
                      <button onClick={() => galleryRef.current.click()} disabled={uploading} style={{ fontSize: '12px', fontWeight: '500', padding: '9px 18px', borderRadius: '6px', border: '1.5px solid #DDD8CF', background: 'transparent', color: '#1C1C1E', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
                        🖼 Gallery
                      </button>
                    </div>
                  </div>

                  {photos.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '16px', color: '#9CA3AF', fontSize: '13px' }}>No photos uploaded yet</div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                      {photos.map(p => {
                        const rt = RUN_TYPES.find(r => r.value === p.run_type) || RUN_TYPES[0]
                        return (
                          <div key={p.id} style={{ borderRadius: '6px', overflow: 'hidden', border: `1.5px solid ${rt.border}` }}>
                            <img src={p.photo_url} alt="Evidence" style={{ width: '100%', height: '80px', objectFit: 'cover', display: 'block' }} />
                            <div style={{ padding: '4px 6px', background: rt.bg }}>
                              <div style={{ fontSize: '9px', fontWeight: '600', color: rt.color }}>{rt.label}</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function RunCard({ run, onOpen }) {
  const isToday = run.date === new Date().toISOString().split('T')[0]
  const isDel = run.type === 'DEL'
  return (
    <div onClick={onOpen} style={{ background: '#fff', border: `1px solid ${isDel ? '#FCA5A5' : '#86EFAC'}`, borderRadius: '8px', marginBottom: '10px', overflow: 'hidden', cursor: 'pointer' }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '0.5px solid #EDE8E0' }}>
        <span style={{ fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '4px', background: isDel ? '#FCEBEB' : '#EAF3DE', color: isDel ? '#A32D2D' : '#3B6D11', flexShrink: 0 }}>{run.type}</span>
        <span style={{ fontSize: '13px', fontWeight: '500', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{run.job.event_name}</span>
        <span style={{ fontSize: '12px', color: '#6B6860', flexShrink: 0 }}>{run.time?.substring(0, 5) || '—'}</span>
      </div>
      <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '11px', color: '#6B6860' }}>
          {isToday ? 'Today' : new Date(run.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · {run.job.venue || '—'}
        </div>
        <span style={{ fontSize: '11px', color: '#B8965A', fontWeight: '500' }}>View →</span>
      </div>
    </div>
  )
}

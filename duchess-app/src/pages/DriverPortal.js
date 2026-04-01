import { useEffect, useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://ecosxamjvxveawaeluma.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjb3N4YW1qdnh2ZWF3YWVsdW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNDY2MjIsImV4cCI6MjA4ODgyMjYyMn0.UkMQcQGovE5aX9znOeG1MtJ1_5FWA7kc5WNAE6HeBOw',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'driver-portal-auth',
    },
    global: {
      headers: {
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjb3N4YW1qdnh2ZWF3YWVsdW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNDY2MjIsImV4cCI6MjA4ODgyMjYyMn0.UkMQcQGovE5aX9znOeG1MtJ1_5FWA7kc5WNAE6HeBOw',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjb3N4YW1qdnh2ZWF3YWVsdW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNDY2MjIsImV4cCI6MjA4ODgyMjYyMn0.UkMQcQGovE5aX9znOeG1MtJ1_5FWA7kc5WNAE6HeBOw',
      }
    },
  }
)

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

  const [reportMode, setReportMode]     = useState(false)
  const [reportJob, setReportJob]       = useState(null)
  const [reportRunType, setReportRunType] = useState('DEL')
  const [reportItems, setReportItems]   = useState([])
  const [driverNotes, setDriverNotes]   = useState('')
  const [clientName, setClientName]     = useState('')
  const [signature, setSignature]       = useState(null)
  const [savingReport, setSavingReport] = useState(false)
  const [reportToast, setReportToast]   = useState(null)
  const [sigCanvas, setSigCanvas]       = useState(null)
  const [isDrawing, setIsDrawing]       = useState(false)

  const today = new Date().toISOString().split('T')[0]

  useEffect(() => { if (token) fetchDriver() }, [token])

  async function fetchDriver() {
    try {
      console.log('Fetching driver with token:', token)

      const { data, error, status, statusText } = await supabase
        .from('drivers')
        .select('id, name, colour, active')
        .eq('access_token', token)
        .maybeSingle()

      console.log('Response:', { data, error, status, statusText })

      if (error) {
        setError('Database error: ' + error.message)
        setLoading(false)
        return
      }

      if (!data) {
        setError('No driver found for token: ' + token)
        setLoading(false)
        return
      }

      setDriver(data)
      fetchJobs(data.name)
    } catch(e) {
      console.error('Exception:', e)
      setError('Exception: ' + e.message)
      setLoading(false)
    }
  }

  async function fetchJobs(driverName) {
    const { data } = await supabase
      .from('crms_jobs')
      .select('*')
      .not('status', 'eq', 'cancelled')
      .order('delivery_date', { ascending: true, nullsLast: true })

    if (data) {
      console.log('All jobs:', data.length)
      console.log('Driver name looking for:', driverName)
      console.log('Sample job driver fields:', data.slice(0,3).map(j => ({
        event: j.event_name,
        d1: j.assigned_driver_name,
        d2: j.assigned_driver_name_2,
        col1: j.col_driver_name,
        col2: j.col_driver_name_2,
      })))

      const myJobs = data.filter(j =>
        j.assigned_driver_name === driverName ||
        j.assigned_driver_name_2 === driverName ||
        j.col_driver_name === driverName ||
        j.col_driver_name_2 === driverName
      )
      console.log('My jobs found:', myJobs.length)
      setJobs(myJobs)
    }
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

  function showReportToast(msg, type = 'success') {
    setReportToast({ msg, type })
    setTimeout(() => setReportToast(null), 3000)
  }

  async function openReport(job, runType) {
    setReportJob(job)
    setReportRunType(runType)
    setDriverNotes('')
    setClientName('')
    setSignature(null)

    // Check if report already exists
    const { data: existing } = await supabase
      .from('job_reports')
      .select('id')
      .eq('job_id', job.id)
      .eq('run_type', runType)
      .maybeSingle()

    if (existing) {
      showReportToast('Report already submitted for this run')
      return
    }

    // Load items for this job
    const { data: items } = await supabase
      .from('crms_items')
      .select('*')
      .eq('job_id', job.id)

    if (items?.length) {
      setReportItems(items.map(i => ({
        item_name: i.description || i.name || 'Item',
        category: i.category || 'other',
        quantity: i.quantity || 1,
        condition: 'good',
        notes: '',
      })))
    } else {
      setReportItems([{ item_name: 'General items', category: 'other', quantity: 1, condition: 'good', notes: '' }])
    }
    setReportMode(true)
  }

  function updateItemCondition(index, condition) {
    const updated = [...reportItems]
    updated[index].condition = condition
    setReportItems(updated)
  }

  function updateItemNote(index, notes) {
    const updated = [...reportItems]
    updated[index].notes = notes
    setReportItems(updated)
  }

  // Signature canvas functions
  function startDrawing(e) {
    setIsDrawing(true)
    const canvas = sigCanvas
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const rect = canvas.getBoundingClientRect()
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function draw(e) {
    if (!isDrawing || !sigCanvas) return
    e.preventDefault()
    const ctx = sigCanvas.getContext('2d')
    const rect = sigCanvas.getBoundingClientRect()
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top
    ctx.lineTo(x, y)
    ctx.strokeStyle = '#1C1C1E'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  function stopDrawing() {
    setIsDrawing(false)
    if (sigCanvas) {
      setSignature(sigCanvas.toDataURL('image/png'))
    }
  }

  function clearSignature() {
    if (sigCanvas) {
      const ctx = sigCanvas.getContext('2d')
      ctx.clearRect(0, 0, sigCanvas.width, sigCanvas.height)
    }
    setSignature(null)
  }

  async function submitReport() {
    if (!reportJob) return
    setSavingReport(true)

    try {
      const { data: report, error } = await supabase
        .from('job_reports')
        .insert({
          job_id:           reportJob.id,
          job_table:        reportJob.crms_id ? 'crms_jobs' : 'orders',
          crms_ref:         reportJob.crms_ref || null,
          event_name:       reportJob.event_name || reportJob.title || '',
          run_type:         reportRunType,
          driver_id:        driver?.id || null,
          driver_name:      driver?.name || null,
          status:           'submitted',
          driver_notes:     driverNotes || null,
          client_signature: signature || null,
          client_name:      clientName || null,
          signed_at:        signature ? new Date().toISOString() : null,
          submitted_at:     new Date().toISOString(),
        })
        .select()
        .single()

      if (error) throw error

      if (reportItems.length > 0) {
        await supabase.from('job_report_items').insert(
          reportItems.map(item => ({
            report_id:  report.id,
            item_name:  item.item_name,
            category:   item.category,
            quantity:   item.quantity,
            condition:  item.condition,
            notes:      item.notes || null,
          }))
        )
      }

      showReportToast('Report submitted successfully')
      setReportMode(false)
      setReportJob(null)
    } catch(e) {
      showReportToast('Error submitting report: ' + e.message, 'error')
    }
    setSavingReport(false)
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
            {todayRuns.map((r, i) => <RunCard key={i} run={r} onOpen={() => openJob(r.job)} onReport={openReport} />)}
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
            {upcomingRuns.map((r, i) => <RunCard key={i} run={r} onOpen={() => openJob(r.job)} onReport={openReport} />)}
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

      {reportMode && reportJob && (
        <div style={{ position: 'fixed', inset: 0, background: '#F7F3EE', zIndex: 300, overflowY: 'auto', fontFamily: "'DM Sans', sans-serif" }}>
          <div style={{ maxWidth: '600px', margin: '0 auto', padding: '20px 16px' }}>

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
              <button onClick={() => setReportMode(false)} style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}>← Back</button>
              <div>
                <div style={{ fontSize: '15px', fontWeight: '500' }}>{reportRunType} Report</div>
                <div style={{ fontSize: '11px', color: '#6B6860' }}>{reportJob.event_name || reportJob.title}</div>
              </div>
            </div>

            {/* Item conditions */}
            <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #DDD8CF', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A' }}>
                Item condition at {reportRunType === 'DEL' ? 'delivery' : 'collection'}
              </div>
              {reportItems.map((item, i) => (
                <div key={i} style={{ padding: '12px 16px', borderBottom: i < reportItems.length - 1 ? '1px solid #EDE8E0' : 'none' }}>
                  <div style={{ fontSize: '13px', fontWeight: '500', marginBottom: '8px' }}>
                    {item.item_name} {item.quantity ? `(${item.quantity})` : ''}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                    {['good', 'damaged', 'missing'].map(c => (
                      <button key={c} onClick={() => updateItemCondition(i, c)}
                        style={{
                          fontSize: '11px', fontWeight: '600', padding: '5px 14px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                          background: item.condition === c
                            ? c === 'good' ? '#EAF3DE' : c === 'damaged' ? '#FCEBEB' : '#FEF3C7'
                            : 'transparent',
                          color: item.condition === c
                            ? c === 'good' ? '#3B6D11' : c === 'damaged' ? '#A32D2D' : '#854F0B'
                            : '#6B6860',
                          border: `1px solid ${item.condition === c
                            ? c === 'good' ? '#86EFAC' : c === 'damaged' ? '#FCA5A5' : '#FDE68A'
                            : '#DDD8CF'}`,
                        }}
                      >{c.charAt(0).toUpperCase() + c.slice(1)}</button>
                    ))}
                  </div>
                  {item.condition !== 'good' && (
                    <input
                      value={item.notes}
                      onChange={e => updateItemNote(i, e.target.value)}
                      placeholder="Add note (e.g. 2 plates broken)..."
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }}
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Driver notes */}
            <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '14px 16px', marginBottom: '16px' }}>
              <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '10px' }}>Driver notes</div>
              <textarea
                value={driverNotes}
                onChange={e => setDriverNotes(e.target.value)}
                placeholder="Any observations about the delivery/collection, items, venue access, etc..."
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", minHeight: '100px', resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>

            {/* Client signature */}
            <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '14px 16px', marginBottom: '20px' }}>
              <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '10px' }}>Client signature</div>
              <input
                value={clientName}
                onChange={e => setClientName(e.target.value)}
                placeholder="Client name..."
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", marginBottom: '10px', boxSizing: 'border-box' }}
              />
              <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '8px' }}>Ask the client to sign below:</div>
              <canvas
                ref={el => setSigCanvas(el)}
                width={500}
                height={150}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onTouchStart={startDrawing}
                onTouchMove={draw}
                onTouchEnd={stopDrawing}
                style={{ width: '100%', height: '150px', border: '1.5px dashed #DDD8CF', borderRadius: '8px', background: '#FAFAF8', cursor: 'crosshair', touchAction: 'none' }}
              />
              {signature && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: '12px', color: '#3B6D11' }}>✓ Signature captured</span>
                  <button onClick={clearSignature} style={{ fontSize: '11px', color: '#6B6860', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Clear</button>
                </div>
              )}
            </div>

            {/* Submit */}
            <button
              onClick={submitReport}
              disabled={savingReport}
              style={{ width: '100%', padding: '14px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
            >{savingReport ? 'Submitting…' : 'Submit Report'}</button>
          </div>

          {reportToast && (
            <div style={{ position: 'fixed', bottom: '24px', right: '16px', left: '16px', background: '#1C1C1E', color: '#fff', padding: '12px 16px', borderRadius: '8px', fontSize: '13px', borderLeft: `3px solid ${reportToast.type === 'error' ? '#EF4444' : '#10B981'}`, zIndex: 999, textAlign: 'center' }}>
              {reportToast.msg}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RunCard({ run, onOpen, onReport }) {
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

      <div style={{ padding: '0 14px 12px' }}>
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
          {run.job.delivery_date && (
            <button
              onClick={(e) => { e.stopPropagation(); onReport && onReport(run.job, 'DEL') }}
              style={{ fontSize: '11px', fontWeight: '500', padding: '6px 14px', borderRadius: '6px', border: 'none', background: '#FCEBEB', color: '#A32D2D', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
            >+ DEL Report</button>
          )}
          {run.job.collection_date && (
            <button
              onClick={(e) => { e.stopPropagation(); onReport && onReport(run.job, 'COL') }}
              style={{ fontSize: '11px', fontWeight: '500', padding: '6px 14px', borderRadius: '6px', border: 'none', background: '#EAF3DE', color: '#3B6D11', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
            >+ COL Report</button>
          )}
        </div>
      </div>
    </div>
  )
}

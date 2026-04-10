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
  const [reportPhotoUploading, setReportPhotoUploading] = useState(false)
  const [submittedReportId, setSubmittedReportId]     = useState(null)
  /** Each entry: { url, path } after upload to evidence-photos bucket */
  const [uploadedPhotos, setUploadedPhotos]            = useState([])
  const [sigCanvas, setSigCanvas]       = useState(null)
  const [isDrawing, setIsDrawing]       = useState(false)

  const today = new Date().toISOString().split('T')[0]

  useEffect(() => { if (token) fetchDriver() }, [token])

  async function fetchDriver() {
    try {
      console.log('Fetching driver with token:', token)

      const { data, error, status, statusText } = await supabase
        .from('drivers')
        .select('id, name, colour, active, token_created_at')
        .eq('access_token', token)
        .maybeSingle()

      console.log('Response:', { data, error, status, statusText })

      if (error || !data) {
        setError('Invalid or expired link.')
        setLoading(false)
        return
      }

      // Check if token is older than 7 days
      if (data.token_created_at) {
        const created = new Date(data.token_created_at)
        const daysSince = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince > 7) {
          setError('This link has expired. Please ask your manager for a new link.')
          setLoading(false)
          return
        }
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
    const { data, error } = await supabase
      .from('crms_jobs')
      .select('*')
      .not('status', 'eq', 'cancelled')
      .order('delivery_date', { ascending: true, nullsLast: true })

    console.log('fetchJobs called for:', driverName)
    console.log('Total jobs fetched:', data?.length, 'Error:', error)

    if (data) {
      const today = new Date().toLocaleDateString('en-CA')

      const myJobs = data.filter(j => {
        const isMyJob =
          j.assigned_driver_name === driverName ||
          j.assigned_driver_name_2 === driverName ||
          j.col_driver_name === driverName ||
          j.col_driver_name_2 === driverName
        if (!isMyJob) return false
        const delDate = j.manual_delivery_date || j.delivery_date
        const colDate = j.manual_collection_date || j.collection_date
        return (delDate && delDate >= today) || (colDate && colDate >= today)
      })

      console.log('My jobs after filter:', myJobs.length)

      // Fetch items for these jobs
      if (myJobs.length > 0) {
        const jobIds = myJobs.map(j => j.id)
        const { data: itemsData } = await supabase
          .from('crms_job_items')
          .select('*')
          .in('job_id', jobIds)

        const itemsByJob = {}
        if (itemsData) {
          itemsData.forEach(item => {
            if (!itemsByJob[item.job_id]) itemsByJob[item.job_id] = []
            itemsByJob[item.job_id].push(item)
          })
        }
        console.log('Items fetched:', itemsData?.length)
        console.log('Job IDs:', jobIds)
        console.log('Items by job:', JSON.stringify(itemsByJob))

        setJobs(myJobs.map(j => ({
          ...j,
          items: itemsByJob[j.id] || [],
        })))
      } else {
        setJobs([])
      }
    }
    setLoading(false)
  }

  async function openJob(job) {
    setSelected(job)
    setTab('details')
    const [{ data: notesData }, { data: photosData }] = await Promise.all([
      supabase.from('job_notes').select('*').eq('job_id', job.id).order('created_at', { ascending: false }),
      supabase.from('evidence_photos').select('*').eq('order_id', job.id).order('created_at', { ascending: false }),
    ])
    if (notesData) setNotes(notesData)
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
    setSubmittedReportId(null)
    setUploadedPhotos([])
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
      .from('crms_job_items')
      .select('*')
      .eq('job_id', job.id)

    if (items?.length) {
      setReportItems(items.map(i => ({
        item_name: i.item_name || i.description || i.name || 'Item',
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
  function getPos(e, canvas) {
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    }
  }

  function startDrawing(e) {
    e.preventDefault()
    const canvas = sigCanvas
    if (!canvas) return
    setIsDrawing(true)
    const ctx = canvas.getContext('2d')
    const { x, y } = getPos(e, canvas)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function draw(e) {
    e.preventDefault()
    if (!isDrawing || !sigCanvas) return
    const ctx = sigCanvas.getContext('2d')
    const { x, y } = getPos(e, sigCanvas)
    ctx.lineTo(x, y)
    ctx.strokeStyle = '#1C1C1E'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
  }

  function stopDrawing(e) {
    if (e) e.preventDefault()
    setIsDrawing(false)
    if (sigCanvas) setSignature(sigCanvas.toDataURL('image/png'))
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

      // Save uploaded photos linked to the report
      if (uploadedPhotos.length > 0) {
        await supabase.from('evidence_photos').insert(
          uploadedPhotos.map(p => ({
            order_id:         report.id,
            run_type:         'after_col',
            photo_url:        p.url,
            file_path:        p.path,
            uploaded_by_name: driver?.name || 'Driver',
            event_name:       reportJob?.event_name || '',
            crms_ref:         reportJob?.crms_ref || '',
          }))
        )
      }

      showReportToast('Report submitted successfully')
      setSubmittedReportId(report.id)
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
        {jobs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: '#6B6860' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>📋</div>
            <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '6px' }}>No upcoming runs</div>
            <div style={{ fontSize: '13px', color: '#9CA3AF' }}>No jobs assigned to you in the next 60 days</div>
          </div>
        ) : (() => {
          const today = new Date().toLocaleDateString('en-CA')
          const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA')

          // Build runs from jobs
          const runs = []
          jobs.forEach(job => {
            if (job.delivery_date && (
              job.assigned_driver_name === driver?.name ||
              job.assigned_driver_name_2 === driver?.name
            )) {
              runs.push({ job, type: 'DEL', date: job.delivery_date, time: job.delivery_time })
            }
            if (job.collection_date && (
              job.assigned_driver_name === driver?.name ||
              job.assigned_driver_name_2 === driver?.name ||
              job.col_driver_name === driver?.name ||
              job.col_driver_name_2 === driver?.name
            )) {
              runs.push({ job, type: 'COL', date: job.collection_date, time: job.collection_time })
            }
          })

          runs.sort((a, b) => {
            const d = a.date.localeCompare(b.date)
            return d !== 0 ? d : (a.time || '99:99').localeCompare(b.time || '99:99')
          })

          // Group by date label
          const groups = {}
          runs.forEach(run => {
            const label = run.date === today ? 'Today'
              : run.date === tomorrow ? 'Tomorrow'
                : new Date(run.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
            if (!groups[label]) groups[label] = []
            groups[label].push(run)
          })

          return Object.entries(groups).map(([label, groupRuns]) => (
            <div key={label} style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '8px', padding: '0 2px' }}>
                {label} · {groupRuns.length} run{groupRuns.length !== 1 ? 's' : ''}
              </div>
              {groupRuns.map((run, i) => (
                <RunCard
                  key={i}
                  run={run}
                  onOpen={() => openJob(run.job)}
                  onReport={openReport}
                />
              ))}
            </div>
          ))
        })()}
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
                      { label: 'Client', value: selectedJob.client_name || '—' },
                    ].map(f => (
                      <div key={f.label} style={{ background: '#F7F3EE', borderRadius: '8px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>{f.label}</div>
                        <div style={{ fontSize: '12px', fontWeight: '500' }}>{f.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Venue & Address */}
                  <div style={{ background: '#F7F3EE', borderRadius: '8px', padding: '12px 14px', marginBottom: '10px' }}>
                    <div style={{ fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860', marginBottom: '6px' }}>Venue & Address</div>
                    {selectedJob.venue_address ? (
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: '500', marginBottom: '2px' }}>{selectedJob.venue || selectedJob.venue_address}</div>
                        <div style={{ fontSize: '12px', color: '#6B6860', lineHeight: 1.5, marginBottom: '8px' }}>{selectedJob.venue_address}</div>
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((selectedJob.venue || '') + ' ' + (selectedJob.venue_address || ''))}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ display: 'inline-block', fontSize: '12px', fontWeight: '500', padding: '7px 14px', borderRadius: '6px', background: '#1C1C1E', color: '#fff', textDecoration: 'none' }}
                        >
                          Open in Google Maps
                        </a>
                      </div>
                    ) : (
                      <div style={{ fontSize: '12px', color: '#9CA3AF' }}>Full address not yet available — check Current RMS</div>
                    )}
                  </div>
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
                  {(!selectedJob.items || selectedJob.items.length === 0) ? (
                    <div style={{ textAlign: 'center', padding: '32px', color: '#9CA3AF', fontSize: '13px' }}>
                      No items listed for this job
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                      {Object.entries(
                        selectedJob.items.reduce((groups, item) => {
                          const cat = item.category || 'Other'
                          if (!groups[cat]) groups[cat] = []
                          groups[cat].push(item)
                          return groups
                        }, {})
                      ).map(([category, items]) => (
                        <div key={category}>
                          <div style={{ padding: '8px 14px', background: '#F7F3EE', fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', borderBottom: '0.5px solid #EDE8E0' }}>
                            {category}
                          </div>
                          {items.map((item, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '0.5px solid #EDE8E0' }}>
                              <div>
                                <div style={{ fontSize: '13px', fontWeight: '500' }}>{item.item_name || item.description || item.name}</div>
                                {item.notes && <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '1px' }}>{item.notes}</div>}
                              </div>
                              <div style={{ fontSize: '14px', fontWeight: '600', color: '#1C1C1E' }}>×{item.quantity}</div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
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
              <button onClick={() => { setReportMode(false); setSubmittedReportId(null); setUploadedPhotos([]) }} style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}>← Back</button>
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
                width={800}
                height={200}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onTouchStart={startDrawing}
                onTouchMove={draw}
                onTouchEnd={stopDrawing}
                style={{
                  width: '100%',
                  height: '150px',
                  border: '1.5px dashed #DDD8CF',
                  borderRadius: '8px',
                  background: '#FAFAF8',
                  cursor: 'crosshair',
                  touchAction: 'none',
                  display: 'block',
                }}
              />
              {signature && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: '12px', color: '#3B6D11' }}>✓ Signature captured</span>
                  <button onClick={clearSignature} style={{ fontSize: '11px', color: '#6B6860', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Clear</button>
                </div>
              )}
            </div>

            {/* Collection Photos Upload */}
            {!submittedReportId && (
            <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '14px 16px', marginBottom: '16px' }}>
              <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '10px' }}>Collection Photos</div>

              {uploadedPhotos.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '10px' }}>
                  {uploadedPhotos.map((photo, i) => (
                    <img key={i} src={photo.url} alt="COL"
                      style={{ width: '100%', height: '90px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #DDD8CF' }} />
                  ))}
                </div>
              )}

              <label style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: '8px', padding: '12px',
                background: '#F7F3EE',
                border: '1.5px dashed #DDD8CF',
                borderRadius: '6px', cursor: 'pointer',
                fontSize: '13px', color: '#6B6860',
              }}>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={async e => {
                    const file = e.target.files[0]
                    if (!file) return
                    setReportPhotoUploading(true)
                    try {
                      const ext = file.name.split('.').pop()
                      const path = `reports/temp_${Date.now()}.${ext}`
                      const { error } = await supabase.storage
                        .from('evidence-photos')
                        .upload(path, file)
                      if (error) throw error
                      const { data: { publicUrl } } = supabase.storage
                        .from('evidence-photos')
                        .getPublicUrl(path)
                      setUploadedPhotos(p => [...p, { url: publicUrl, path }])
                      showReportToast('Photo added')
                    } catch (err) {
                      showReportToast('Upload failed: ' + err.message, 'error')
                    }
                    setReportPhotoUploading(false)
                    e.target.value = ''
                  }}
                />
                {reportPhotoUploading ? 'Uploading…' : '📷 Add collection photo'}
              </label>
              {uploadedPhotos.length > 0 && (
                <div style={{ fontSize: '11px', color: '#3B6D11', marginTop: '6px', textAlign: 'center' }}>
                  {uploadedPhotos.length} photo{uploadedPhotos.length !== 1 ? 's' : ''} added
                </div>
              )}
            </div>
            )}

            {/* Submit */}
            <button
              onClick={submitReport}
              disabled={savingReport || !!submittedReportId}
              style={{ width: '100%', padding: '14px', background: submittedReportId ? '#DDD8CF' : '#1C1C1E', color: submittedReportId ? '#6B6860' : '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '500', cursor: submittedReportId ? 'default' : 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: savingReport ? 0.7 : 1 }}
            >{savingReport ? 'Submitting…' : submittedReportId ? 'Report submitted' : 'Submit Report'}</button>

            {submittedReportId && (
              <div style={{ marginTop: '16px', background: '#EAF3DE', border: '1px solid #86EFAC', borderRadius: '8px', padding: '14px 16px' }}>
                <div style={{ fontSize: '13px', fontWeight: '500', color: '#3B6D11', marginBottom: '10px' }}>
                  ✓ Report submitted successfully
                </div>
                <button
                  onClick={() => { setReportMode(false); setSubmittedReportId(null); setUploadedPhotos([]) }}
                  style={{ width: '100%', marginTop: '10px', padding: '10px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
                >Done</button>
              </div>
            )}
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
          <button
            onClick={(e) => { e.stopPropagation(); onReport && onReport(run.job, run.type) }}
            style={{ fontSize: '11px', fontWeight: '500', padding: '6px 14px', borderRadius: '6px', border: 'none', background: run.type === 'DEL' ? '#FCEBEB' : '#EAF3DE', color: run.type === 'DEL' ? '#A32D2D' : '#3B6D11', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
          >+ {run.type} Report</button>
        </div>
      </div>
    </div>
  )
}

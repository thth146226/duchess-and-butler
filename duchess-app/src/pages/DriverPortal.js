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
  const [driverNotes, setDriverNotes]   = useState('')
  const [clientName, setClientName]     = useState('')
  const [signature, setSignature]       = useState(null)
  const [savingReport, setSavingReport] = useState(false)
  const [reportToast, setReportToast]   = useState(null)
  const [reportPhotoUploading, setReportPhotoUploading] = useState(false)
  const [submittedReportId, setSubmittedReportId]     = useState(null)
  /** Each entry: { url, path } after upload to evidence-photos bucket */
  const [uploadedPhotos, setUploadedPhotos]            = useState([])
  const [deletedItems, setDeletedItems] = useState({})
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

  async function fetchHiddenItems(jobIds) {
    if (!jobIds.length) return
    const { data } = await supabase
      .from('driver_portal_hidden_items')
      .select('job_id, item_id')
      .in('job_id', jobIds)
    if (data) {
      const hidden = {}
      data.forEach(row => {
        hidden[`${row.job_id}_${row.item_id}`] = true
      })
      setDeletedItems(hidden)
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
        fetchHiddenItems(myJobs.map(j => j.id))
      } else {
        setJobs([])
        fetchHiddenItems(myJobs.map(j => j.id))
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

  async function toggleItemDeleted(jobId, itemId) {
    const key = `${jobId}_${itemId}`
    const isHidden = deletedItems[key]

    if (isHidden) {
      await supabase
        .from('driver_portal_hidden_items')
        .delete()
        .eq('job_id', jobId)
        .eq('item_id', itemId)
      setDeletedItems(prev => {
        const updated = { ...prev }
        delete updated[key]
        return updated
      })
    } else {
      await supabase
        .from('driver_portal_hidden_items')
        .upsert({
          job_id: jobId,
          item_id: itemId,
          hidden_by: driver?.name || 'Driver',
        }, { onConflict: 'job_id,item_id' })
      setDeletedItems(prev => ({ ...prev, [key]: true }))
    }
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

    setReportMode(true)
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

      setSubmittedReportId(report.id)
      showReportToast('Report submitted successfully')
      setReportMode(false)
      setReportJob(null)
    } catch (e) {
      showReportToast('Error: ' + e.message, 'error')
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

  const job = selectedJob

  if (reportMode && reportJob) {
    return (
      <div style={{ background: '#F7F3EE', fontFamily: "'DM Sans', sans-serif", minHeight: '100vh', paddingBottom: '40px' }}>
        <div style={{ maxWidth: '600px', margin: '0 auto', padding: '20px 16px' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            <button onClick={() => { setReportMode(false); setSubmittedReportId(null); setUploadedPhotos([]) }}
              style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '6px', padding: '8px 14px', cursor: 'pointer', fontSize: '13px', fontFamily: "'DM Sans', sans-serif" }}>← Back</button>
            <div>
              <div style={{ fontSize: '15px', fontWeight: '500' }}>{reportRunType} Report</div>
              <div style={{ fontSize: '11px', color: '#6B6860' }}>{reportJob.event_name || reportJob.title}</div>
            </div>
          </div>

          {/* Driver notes */}
          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '14px 16px', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '10px' }}>Driver notes</div>
            <textarea value={driverNotes} onChange={e => setDriverNotes(e.target.value)}
              placeholder="Any observations about the delivery/collection, items, venue access, etc..."
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", minHeight: '100px', resize: 'vertical', boxSizing: 'border-box' }} />
          </div>

          {/* Client signature */}
          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '14px 16px', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '10px' }}>Client signature</div>
            <input value={clientName} onChange={e => setClientName(e.target.value)}
              placeholder="Client name..."
              style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", marginBottom: '10px', boxSizing: 'border-box' }} />
            <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '8px' }}>Ask the client to sign below:</div>
            <canvas ref={el => setSigCanvas(el)} width={800} height={200}
              onMouseDown={startDrawing} onMouseMove={draw} onMouseUp={stopDrawing}
              onTouchStart={startDrawing} onTouchMove={draw} onTouchEnd={stopDrawing}
              style={{ width: '100%', height: '150px', border: '1.5px dashed #DDD8CF', borderRadius: '8px', background: '#FAFAF8', cursor: 'crosshair', touchAction: 'none', display: 'block' }} />
            {signature && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                <span style={{ fontSize: '12px', color: '#3B6D11' }}>✓ Signature captured</span>
                <button onClick={clearSignature} style={{ fontSize: '11px', color: '#6B6860', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Clear</button>
              </div>
            )}
          </div>

          {/* Collection Photos */}
          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '14px 16px', marginBottom: '20px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '10px' }}>Collection Photos</div>
            {uploadedPhotos.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '10px' }}>
                {uploadedPhotos.map((photo, i) => (
                  <img key={i} src={photo.url} alt="COL"
                    style={{ width: '100%', height: '90px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #DDD8CF' }} />
                ))}
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '12px', background: '#F7F3EE', border: '1.5px dashed #DDD8CF', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', color: '#6B6860' }}>
              <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                onChange={async e => {
                  const file = e.target.files[0]
                  if (!file) return
                  setReportPhotoUploading(true)
                  try {
                    const ext = file.name.split('.').pop()
                    const path = `reports/temp_${Date.now()}.${ext}`
                    const { error } = await supabase.storage.from('evidence-photos').upload(path, file)
                    if (error) throw error
                    const { data: { publicUrl } } = supabase.storage.from('evidence-photos').getPublicUrl(path)
                    setUploadedPhotos(p => [...p, { url: publicUrl, path }])
                    showReportToast('Photo added')
                  } catch (err) {
                    showReportToast('Upload failed: ' + err.message, 'error')
                  }
                  setReportPhotoUploading(false)
                  e.target.value = ''
                }} />
              {reportPhotoUploading ? 'Uploading…' : '📷 Add collection photo'}
            </label>
          </div>

          {/* Submit */}
          <button onClick={submitReport} disabled={savingReport}
            style={{ width: '100%', padding: '16px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
            {savingReport ? 'Submitting…' : 'Submit Report'}
          </button>

          {reportToast && (
            <div style={{ marginTop: '16px', background: '#1C1C1E', color: '#fff', padding: '12px 16px', borderRadius: '8px', fontSize: '13px', borderLeft: `3px solid ${reportToast.type === 'error' ? '#EF4444' : '#10B981'}`, textAlign: 'center' }}>
              {reportToast.msg}
            </div>
          )}
        </div>
      </div>
    )
  }

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
            const delDate = job.manual_delivery_date || job.delivery_date
            const delTime = job.manual_delivery_time || job.delivery_time
            const colDate = job.manual_collection_date || job.collection_date
            const colTime = job.manual_collection_time || job.collection_time

            const delEndTime = job.delivery_end_time?.substring(0,5)
            const colEndTime = job.collection_end_time?.substring(0,5)

            const isDelTimed = !!(delEndTime && !['17:00','18:00','00:00'].includes(delEndTime))
            const isColTimed = !!(colEndTime && !['17:00','18:00','00:00'].includes(colEndTime))

            if (delDate && (
              job.assigned_driver_name === driver?.name ||
              job.assigned_driver_name_2 === driver?.name
            )) {
              runs.push({ 
                job, type: 'DEL', 
                date: delDate, 
                time: delTime?.substring(0,5) || null,
                endTime: delEndTime || null,
                isTimed: isDelTimed,
                sortOrder: job.manual_sort_order || 0,
              })
            }
            if (colDate && (
              job.assigned_driver_name === driver?.name ||
              job.assigned_driver_name_2 === driver?.name ||
              job.col_driver_name === driver?.name ||
              job.col_driver_name_2 === driver?.name
            )) {
              runs.push({ 
                job, type: 'COL', 
                date: colDate, 
                time: colTime?.substring(0,5) || null,
                endTime: colEndTime || null,
                isTimed: isColTimed,
                sortOrder: job.manual_sort_order || 0,
              })
            }
          })

          runs.sort((a, b) => {
            const d = a.date.localeCompare(b.date)
            if (d !== 0) return d
            const aHasOrder = (a.sortOrder || 0) > 0
            const bHasOrder = (b.sortOrder || 0) > 0
            if (aHasOrder || bHasOrder) return (a.sortOrder || 0) - (b.sortOrder || 0)
            return (a.time || '99:99').localeCompare(b.time || '99:99')
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
                {[['details','Details'], ['notes','Notes'], ['items','Items'], ['evidence','Evidence'], ['report','Report']].map(([id, label]) => (
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
                      { label: 'Delivery', value: (() => {
                        const date = selectedJob.manual_delivery_date || selectedJob.delivery_date
                        const time = (selectedJob.manual_delivery_time || selectedJob.delivery_time)?.substring(0,5)
                        const endTime = selectedJob.delivery_end_time?.substring(0,5)
                        if (!date) return '—'
                        const dateStr = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
                        const timeStr = time ? (endTime && !['17:00','18:00','00:00'].includes(endTime) ? `${time} - ${endTime}` : time) : ''
                        return `${dateStr}${timeStr ? ' · ' + timeStr : ''}`
                      })() },
                      { label: 'Collection', value: (() => {
                        const date = selectedJob.manual_collection_date || selectedJob.collection_date
                        const time = (selectedJob.manual_collection_time || selectedJob.collection_time)?.substring(0,5)
                        const endTime = selectedJob.collection_end_time?.substring(0,5)
                        if (!date) return '—'
                        const dateStr = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
                        const timeStr = time ? (endTime && !['17:00','18:00','00:00'].includes(endTime) ? `${time} - ${endTime}` : time) : ''
                        return `${dateStr}${timeStr ? ' · ' + timeStr : ''}`
                      })() },
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
                  {(!job.items || job.items.length === 0) ? (
                    <div style={{ textAlign: 'center', padding: '32px', color: '#9CA3AF', fontSize: '13px' }}>
                      No items listed for this job
                    </div>
                  ) : (
                    <div>
                      {Object.entries(
                        job.items
                          .reduce((groups, item) => {
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
                          {items.filter(item => {
                            const key = `${job.id}_${item.id}`
                            return !deletedItems[key]
                          }).map((item, i) => (
                            <div key={i} style={{
                              display: 'flex', alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '10px 14px',
                              borderBottom: '0.5px solid #EDE8E0',
                              background: '#fff',
                            }}>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '13px', fontWeight: '500', color: '#1C1C1E' }}>
                                  {item.description || item.item_name || item.name}
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                                <div style={{ fontSize: '14px', fontWeight: '600', color: '#1C1C1E' }}>
                                  ×{item.quantity}
                                </div>
                                <button
                                  onClick={() => toggleItemDeleted(job.id, item.id)}
                                  style={{
                                    width: '28px', height: '28px',
                                    borderRadius: '50%',
                                    border: 'none',
                                    background: '#FEF2F2',
                                    color: '#DC2626',
                                    cursor: 'pointer',
                                    fontSize: '14px',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontWeight: '700'
                                  }}
                                >✕</button>
                              </div>
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

              {tab === 'report' && (
                <DriverReportTab
                  job={selectedJob}
                  driver={driver}
                  supabase={supabase}
                />
              )}
            </div>
          </div>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
          <span style={{ fontSize: '12px', color: '#6B6860' }}>
            {run.time?.substring(0, 5) || '—'}
            {run.endTime ? ` - ${run.endTime}` : ''}
          </span>
          {run.isTimed && (
            <span style={{ background: '#FEF3C7', color: '#854F0B', fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px', border: '1px solid #FDE68A', whiteSpace: 'nowrap' }}>⏱ TIMED</span>
          )}
        </div>
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

function DriverReportTab({ job, driver, supabase }) {
  const [report, setReport]         = useState(null)
  const [loading, setLoading]       = useState(true)
  const [creating, setCreating]     = useState(false)
  const [runType, setRunType]       = useState('COL')
  const [driverNotes, setDriverNotes] = useState('')
  const [clientName, setClientName] = useState('')
  const [signature, setSignature]   = useState(null)
  const [sigCanvas, setSigCanvas]   = useState(null)
  const [isDrawing, setIsDrawing]   = useState(false)
  const [photos, setPhotos]         = useState([])
  const [uploading, setUploading]   = useState(false)
  const [saving, setSaving]         = useState(false)
  const [toast, setToast]           = useState(null)

  useEffect(() => { fetchReport() }, [job?.id])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function fetchReport() {
    setLoading(true)
    const { data } = await supabase
      .from('job_reports')
      .select('*')
      .eq('job_id', job.id)
      .maybeSingle()
    if (data) {
      setReport(data)
      const { data: p } = await supabase
        .from('evidence_photos')
        .select('*')
        .eq('order_id', data.id)
      if (p) setPhotos(p)
    } else {
      setReport(null)
      setPhotos([])
    }
    setLoading(false)
  }

  function getPos(e, canvas) {
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
  }
  function startDraw(e) {
    e.preventDefault()
    if (!sigCanvas) return
    setIsDrawing(true)
    const ctx = sigCanvas.getContext('2d')
    const { x, y } = getPos(e, sigCanvas)
    ctx.beginPath(); ctx.moveTo(x, y)
  }
  function onDraw(e) {
    e.preventDefault()
    if (!isDrawing || !sigCanvas) return
    const ctx = sigCanvas.getContext('2d')
    const { x, y } = getPos(e, sigCanvas)
    ctx.lineTo(x, y)
    ctx.strokeStyle = '#1C1C1E'; ctx.lineWidth = 2.5
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke()
  }
  function stopDraw(e) {
    if (e) e.preventDefault()
    setIsDrawing(false)
    if (sigCanvas) setSignature(sigCanvas.toDataURL('image/png'))
  }
  function clearSig() {
    if (sigCanvas) {
      const ctx = sigCanvas.getContext('2d')
      ctx.clearRect(0, 0, sigCanvas.width, sigCanvas.height)
    }
    setSignature(null)
  }

  async function uploadPhoto(file, reportId) {
    setUploading(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `reports/${reportId}/${Date.now()}.${ext}`
      const { error } = await supabase.storage.from('evidence-photos').upload(path, file)
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('evidence-photos').getPublicUrl(path)
      await supabase.from('evidence_photos').insert({
        order_id: reportId, run_type: 'after_col',
        photo_url: publicUrl, file_path: path,
        uploaded_by_name: driver?.name || 'Driver',
        event_name: job?.event_name || '',
      })
      const { data: p } = await supabase.from('evidence_photos').select('*').eq('order_id', reportId)
      if (p) setPhotos(p)
      showToast('Photo uploaded')
    } catch (e) { showToast('Upload failed', 'error') }
    setUploading(false)
  }

  async function submitReport() {
    setSaving(true)
    try {
      const { data: newReport, error } = await supabase
        .from('job_reports')
        .insert({
          job_id:           job.id,
          job_table:        'crms_jobs',
          crms_ref:         job.crms_ref || null,
          event_name:       job.event_name || '',
          run_type:         runType,
          driver_name:      driver?.name || null,
          status:           'submitted',
          driver_notes:     driverNotes || null,
          client_name:      clientName || null,
          client_signature: signature || null,
          signed_at:        signature ? new Date().toISOString() : null,
          submitted_at:     new Date().toISOString(),
        })
        .select().single()
      if (error) throw error
      showToast('Report submitted!')
      setCreating(false)
      setReport(newReport)
      fetchReport()
    } catch (e) { showToast('Error: ' + e.message, 'error') }
    setSaving(false)
  }

  if (loading) return <div style={{ padding: '20px', color: '#6B6860', fontSize: '13px' }}>Loading…</div>

  if (report) return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{ fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '10px', background: '#EAF3DE', color: '#3B6D11' }}>
          {report.run_type} Report Submitted
        </span>
        <div style={{ fontSize: '11px', color: '#6B6860' }}>{report.driver_name}</div>
      </div>
      {report.driver_notes && (
        <div style={{ background: '#F7F3EE', borderRadius: '6px', padding: '10px 12px', fontSize: '12px', marginBottom: '10px', fontStyle: 'italic' }}>
          "{report.driver_notes}"
        </div>
      )}
      {report.client_signature && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>Client signature — {report.client_name}</div>
          <img src={report.client_signature} alt="Signature" style={{ maxWidth: '100%', border: '1px solid #DDD8CF', borderRadius: '6px' }} />
        </div>
      )}
      {photos.length > 0 && (
        <div>
          <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>Photos</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '10px' }}>
            {photos.map(p => (
              <img key={p.id} src={p.photo_url} alt="Report"
                style={{ width: '100%', height: '80px', objectFit: 'cover', borderRadius: '6px' }}
                onClick={() => window.open(p.photo_url, '_blank')} />
            ))}
          </div>
        </div>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px', background: '#F7F3EE', border: '1px dashed #DDD8CF', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', color: '#6B6860' }}>
        <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
          onChange={e => e.target.files[0] && uploadPhoto(e.target.files[0], report.id)} />
        {uploading ? 'Uploading…' : '+ Add photo'}
      </label>
      {toast && <div style={{ marginTop: '10px', background: '#1C1C1E', color: '#fff', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', textAlign: 'center' }}>{toast.msg}</div>}
    </div>
  )

  if (!creating) return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <div style={{ fontSize: '13px', color: '#6B6860', marginBottom: '16px' }}>No report yet for this job.</div>
      <button onClick={() => setCreating(true)}
        style={{ padding: '10px 20px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
        + Create Report
      </button>
    </div>
  )

  return (
    <div style={{ paddingBottom: '20px' }}>
      {/* Run type */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
        {['DEL', 'COL'].map(t => (
          <button key={t} onClick={() => setRunType(t)}
            style={{ fontSize: '12px', fontWeight: '600', padding: '6px 20px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: runType === t ? (t === 'DEL' ? '#FCEBEB' : '#EAF3DE') : 'transparent', color: runType === t ? (t === 'DEL' ? '#A32D2D' : '#3B6D11') : '#6B6860', border: `1.5px solid ${runType === t ? (t === 'DEL' ? '#FCA5A5' : '#86EFAC') : '#DDD8CF'}` }}>
            {t === 'DEL' ? 'Delivery' : 'Collection'}
          </button>
        ))}
      </div>

      {/* Driver notes */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '5px' }}>Driver notes</div>
        <textarea value={driverNotes} onChange={e => setDriverNotes(e.target.value)}
          placeholder="Any observations..."
          style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", minHeight: '80px', resize: 'vertical', boxSizing: 'border-box' }} />
      </div>

      {/* Client name */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '5px' }}>Client name</div>
        <input value={clientName} onChange={e => setClientName(e.target.value)}
          placeholder="Client name..."
          style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
      </div>

      {/* Signature */}
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '5px' }}>Client signature</div>
        <canvas ref={el => setSigCanvas(el)} width={800} height={200}
          onMouseDown={startDraw} onMouseMove={onDraw} onMouseUp={stopDraw}
          onTouchStart={startDraw} onTouchMove={onDraw} onTouchEnd={stopDraw}
          style={{ width: '100%', height: '130px', border: '1.5px dashed #DDD8CF', borderRadius: '8px', background: '#FAFAF8', cursor: 'crosshair', touchAction: 'none', display: 'block' }} />
        {signature && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
            <span style={{ fontSize: '11px', color: '#3B6D11' }}>✓ Signature captured</span>
            <button onClick={clearSig} style={{ fontSize: '11px', color: '#6B6860', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Clear</button>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button onClick={() => setCreating(false)}
          style={{ padding: '9px 16px', background: 'transparent', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", color: '#6B6860' }}>
          Cancel
        </button>
        <button onClick={submitReport} disabled={saving}
          style={{ flex: 1, padding: '9px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
          {saving ? 'Submitting…' : 'Submit Report'}
        </button>
      </div>
      {toast && <div style={{ marginTop: '10px', background: '#1C1C1E', color: '#fff', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', textAlign: 'center' }}>{toast.msg}</div>}
    </div>
  )
}

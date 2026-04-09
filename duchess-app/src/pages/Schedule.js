// Schedule v2 - force deploy
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import JobNotes from '../components/JobNotes'
import EvidenceUpload from '../components/EvidenceUpload'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const today    = new Date().toLocaleDateString('en-CA')
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA')

function fmt(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function getWeekRange(offset = 0) {
  const now = new Date()
  const day = now.getDay()
  const mon = new Date(now)
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7)
  const sun = new Date(mon)
  sun.setDate(mon.getDate() + 6)
  return { from: mon.toLocaleDateString('en-CA'), to: sun.toLocaleDateString('en-CA') }
}

// ── Build runs from jobs (include driver fields) ───────────────────────────────
function buildRuns(jobs) {
  const runs = []
  for (const job of jobs) {
    if (job.deleted) continue
    if (job.status === 'cancelled') continue
    // For CRMS jobs: sync fetches state=3 only; exclude cancelled / no dates
    // For manual orders: show if status is confirmed (not pending)
    if (job.crms_id !== null && job.crms_id !== undefined) {
      // Only confirmed Orders arrive from sync (state=3 filter at API level)
      // Just exclude cancelled and jobs with no dates at all
      if (job.status === 'cancelled') continue
      if (!job.delivery_date && !job.collection_date) continue
    } else {
      // Manual orders: only show confirmed
      if (job.status === 'pending') continue
    }
    const deliveryDate = job.manual_delivery_date || job.delivery_date
    const deliveryTime = job.manual_delivery_time || job.delivery_time
    const collectionDate = job.manual_collection_date || job.collection_date
    const collectionTime = job.manual_collection_time || job.collection_time
    const venue = job.manual_venue || job.venue

    const base = {
      job,
      client:             job.client_name,
      event:              job.event_name,
      venue:              venue,
      ref:                job.crms_ref || job.ref,
      jobId:              job.id,
      crmsId:             job.crms_id,
      status:             job.status,
      isAmended:          job.is_amended,
      isUrgent:           job.is_urgent,
      notes:              job.notes,
      driverColour:       null,   // filled below from drivers list
      driverColour2:      null,
      assignedDriverId:   job.assigned_driver_id   || null,
      assignedDriverId2:  job.assigned_driver_id_2 || null,
    }

    if (deliveryDate) runs.push({
      ...base,
      id: `${job.id}-DEL`,
      runType: 'DEL',
      runDate: deliveryDate,
      runTime: deliveryTime?.substring(0, 5) || null,
      deliveryEndTime: job.manual_delivery_time
        ? null
        : job.delivery_end_time?.substring(0, 5) || null,
      isTimed: !!(job.delivery_end_time &&
        !['17:00', '18:00', '00:00', null].includes(job.delivery_end_time?.substring(0, 5))),
      missingTime: !deliveryTime,
      isManualOverride: !!job.has_manual_override,
      manualSortOrder: job.manual_sort_order || 0,
      driverName: job.assigned_driver_name || null,
      driverName2: job.assigned_driver_name_2 || null,
    })

    if (collectionDate) runs.push({
      ...base,
      id: `${job.id}-COL`,
      runType: 'COL',
      runDate: collectionDate,
      runTime: collectionTime?.substring(0, 5) || null,
      collectionEndTime: job.manual_collection_time
        ? null
        : job.collection_end_time?.substring(0, 5) || null,
      isTimed: !!(job.collection_end_time &&
        !['17:00', '18:00', '00:00', null].includes(job.collection_end_time?.substring(0, 5))),
      missingTime: !collectionTime,
      isManualOverride: !!job.has_manual_override,
      manualSortOrder: (job.manual_sort_order || 0) + 0.5,
      driverName: job.col_driver_name || job.assigned_driver_name || null,
      driverName2: job.col_driver_name_2 || job.assigned_driver_name_2 || null,
    })
  }
  return runs.sort((a, b) => {
    const d = (a.runDate || '').localeCompare(b.runDate || '')
    if (d !== 0) return d
    const aHasOrder = (a.manualSortOrder || 0) > 0
    const bHasOrder = (b.manualSortOrder || 0) > 0
    if (aHasOrder || bHasOrder) {
      return (a.manualSortOrder || 0) - (b.manualSortOrder || 0)
    }
    return (a.runTime || '99:99').localeCompare(b.runTime || '99:99')
  })
}

function applyFilter(runs, filter, weekOffset = 0, driverFilter = 'all') {
  let r = runs
  switch (filter) {
    case 'today':       r = r.filter(x => x.runDate === today); break
    case 'tomorrow':    r = r.filter(x => x.runDate === tomorrow); break
    case 'week':        r = r.filter(x => { const { from, to } = getWeekRange(weekOffset); return x.runDate >= from && x.runDate <= to }); break
    case 'deliveries':  r = r.filter(x => x.runType === 'DEL'); break
    case 'collections': r = r.filter(x => x.runType === 'COL'); break
    case 'amended':     r = r.filter(x => x.isAmended); break
    case 'urgent':      r = r.filter(x => x.isUrgent); break
    case 'missing':     r = r.filter(x => x.missingTime); break
    case 'unassigned':  r = r.filter(x => !x.assignedDriverId); break
    default: break
  }
  if (driverFilter !== 'all') r = r.filter(x => x.assignedDriverId === driverFilter)
  return r
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Schedule() {
  const { profile } = useAuth()
  const [jobs, setJobs]             = useState([])
  const [drivers, setDrivers]       = useState([])
  const [loading, setLoading]       = useState(true)
  const [view, setView]             = useState('list')
  const [filter, setFilter]         = useState('today')
  const [driverFilter, setDrvFilter]= useState('all')
  const [search, setSearch]         = useState('')
  const [selectedRun, setSelectedRun] = useState(null)
  const [syncInfo, setSyncInfo]     = useState(null)
  const [monthDate, setMonthDate]   = useState(new Date())
  const [yearDate, setYearDate]     = useState(new Date())
  const [weekOffset, setWeekOffset] = useState(0)
  const [groupByDriver, setGroup]   = useState(false)
  const [toast, setToast]           = useState(null)   // { msg, type }
  const [assigningId, setAssigning] = useState(null)   // run.id being saved
  const [delDriver1, setDelDriver1] = useState(null)
  const [delDriver2, setDelDriver2] = useState(null)
  const [colDriver1, setColDriver1] = useState(null)
  const [colDriver2, setColDriver2] = useState(null)
  const [jobNotes, setJobNotes]                 = useState({})

  const [overrideJob, setOverrideJob]   = useState(null)
  const [overrideForm, setOverrideForm] = useState({})
  const [savingOverride, setSavingOverride] = useState(false)
  const [dragRun, setDragRun]           = useState(null)
  const [dragOverDate, setDragOverDate] = useState(null)
  const [unsavedOrder, setUnsavedOrder] = useState({})
  const [pendingOrder, setPendingOrder] = useState(null)
  const [savingOrder, setSavingOrder] = useState(false)
  const [reorderPopup, setReorderPopup] = useState(null)
  const [reorderRuns, setReorderRuns]   = useState([])
  const [savingReorder, setSavingReorder] = useState(false)

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function saveManualOverride(job = overrideJob) {
    if (!job) return
    setSavingOverride(true)
    await supabase.from('crms_jobs').update({
      manual_delivery_date:   overrideForm.delivery_date || null,
      manual_delivery_time:   overrideForm.delivery_time || null,
      manual_collection_date: overrideForm.collection_date || null,
      manual_collection_time: overrideForm.collection_time || null,
      manual_venue:           overrideForm.venue || null,
      delivery_end_time:      overrideForm.delivery_end_time || null,
      collection_end_time:    overrideForm.collection_end_time || null,
      has_manual_override:    true,
    }).eq('id', job.id)
    setSavingOverride(false)
    setOverrideJob(null)
    showToast('Override saved — sync will not revert this')
    setTimeout(() => fetchJobs(), 800)
  }

  async function clearManualOverride(jobId) {
    await supabase.from('crms_jobs').update({
      manual_delivery_date:   null,
      manual_delivery_time:   null,
      manual_collection_date: null,
      manual_collection_time: null,
      manual_venue:           null,
      has_manual_override:    false,
    }).eq('id', jobId)
    showToast('Override cleared — RMS dates restored')
    setTimeout(() => fetchJobs(), 800)
  }

  async function saveDraggedDate(run, newDate) {
    const isCol = run.runType === 'COL'
    const table = run.crmsId ? 'crms_jobs' : 'orders'

    console.log('saveDraggedDate:', { table, jobId: run.jobId, crmsId: run.crmsId, newDate, isCol })

    const updatePayload = {
      has_manual_override: true,
      ...(isCol ? {
        manual_collection_date: newDate,
        collection_date: newDate,
      } : {
        manual_delivery_date: newDate,
        delivery_date: newDate,
      }),
    }

    const { error } = await supabase
      .from(table)
      .update(updatePayload)
      .eq('id', run.jobId)

    if (error) {
      console.error('saveDraggedDate error:', error)
      showToast('Error saving date change', 'error')
    } else {
      showToast(`${run.runType} moved to ${newDate}`)
    }

    setDragRun(null)
    setDragOverDate(null)
    setTimeout(() => fetchJobs(), 500)
  }

  async function saveRunOrder() {
    if (!pendingOrder) return
    setSavingOrder(true)

    const dateNum = parseInt(pendingOrder.date.replace(/-/g, ''))

    for (let i = 0; i < pendingOrder.runs.length; i++) {
      const run = pendingOrder.runs[i]
      const table = run.crmsId ? 'crms_jobs' : 'orders'
      const sortValue = dateNum * 1000 + i
  
      await supabase.from(table).update({
        manual_sort_order: sortValue,
        has_manual_override: true,
      }).eq('id', run.jobId)
    }
  
    setSavingOrder(false)
    setPendingOrder(null)
    showToast('Run order saved')
    setTimeout(() => fetchJobs(), 800)
  }

  function discardOrder() {
    setPendingOrder(null)
    showToast('Changes discarded')
  }

  useEffect(() => {
    fetchJobs()
    fetchDrivers()
    fetchLastSync()
    const channel = supabase.channel('schedule-crms')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crms_jobs' }, fetchJobs)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },    fetchJobs)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_notes' }, fetchJobs)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    if (selectedRun?.job) {
      const j = selectedRun.job
      // Reset so we don't carry over values from a previously selected run
      setDelDriver1(null)
      setDelDriver2(null)
      setColDriver1(null)
      setColDriver2(null)
      // Pre-fill DEL
      const d1 = drivers.find(d => d.name === j.assigned_driver_name)
      const d2 = drivers.find(d => d.name === j.assigned_driver_name_2)
      if (j.driver_1_runs === 'del' || j.driver_1_runs === 'both') {
        setDelDriver1(j.assigned_driver_name === 'Self Collection' ? 'self_collection' : d1?.id || null)
        setDelDriver2(d2?.id || null)
      }
      if (j.driver_1_runs === 'col' || j.driver_1_runs === 'both') {
        setColDriver1(d1?.id || null)
        setColDriver2(d2?.id || null)
      }
      // If separate col driver stored
      if (j.col_driver_name) {
        const cd1 = drivers.find(d => d.name === j.col_driver_name)
        setColDriver1(cd1?.id || null)
      }

      // Manual override form pre-fill (so saving without editing doesn't wipe fields)
      setOverrideJob(j)
      setOverrideForm({
        delivery_date:   j.manual_delivery_date || '',
        delivery_time:   j.manual_delivery_time || j.delivery_time?.substring(0, 5) || '',
        collection_date: j.manual_collection_date || '',
        collection_time: j.manual_collection_time || j.collection_time?.substring(0, 5) || '',
        venue:            j.manual_venue || j.venue || '',
      })
    }
    else {
      setOverrideJob(null)
      setOverrideForm({})
    }
  }, [selectedRun])

  async function fetchJobs() {
    // Fetch both CRMS jobs and manual orders
    const [crmsRes, ordersRes] = await Promise.all([
      supabase.from('crms_jobs').select('*').order('delivery_date', { ascending: true, nullsLast: true }),
      supabase.from('orders').select('*').eq('deleted', false).order('delivery_date', { ascending: true, nullsLast: true }),
    ])
    // Normalise manual orders to same shape as crms_jobs
    const crmsJobs = (crmsRes.data || [])
    const manualJobs = (ordersRes.data || []).map(o => ({
      ...o,
      crms_id:  null,
      crms_ref: o.ref,
      is_manual: true,
    }))
    const merged = [...crmsJobs, ...manualJobs]
    setJobs(merged)
    fetchNotesCount(merged.map(j => j.id))
    setLoading(false)
  }

  async function fetchNotesCount(jobIds) {
    if (!jobIds.length) return
    const { data } = await supabase
      .from('job_notes')
      .select('job_id, category')
      .in('job_id', jobIds)
    if (!data) return
    const counts = {}
    for (const n of data) {
      if (!counts[n.job_id]) counts[n.job_id] = { total: 0, hasUrgent: false }
      counts[n.job_id].total++
      if (n.category === 'urgent') counts[n.job_id].hasUrgent = true
    }
    setJobNotes(counts)
  }

  async function fetchDrivers() {
    const { data } = await supabase.from('drivers').select('id, name, colour').eq('active', true).order('name')
    if (data) setDrivers(data)
  }

  async function fetchLastSync() {
    const { data } = await supabase.from('sync_runs').select('completed_at, status, jobs_fetched').order('started_at', { ascending: false }).limit(1).single()
    if (data) setSyncInfo(data)
  }

  // ── Assign driver ─────────────────────────────────────────────────────────
  async function assignDriver(run, driverId) {
    setAssigning(run.id)
    const driver = drivers.find(d => d.id === driverId) || null
    const update = {
      assigned_driver_id:   driverId    || null,
      assigned_driver_name: driver?.name || null,
      assigned_by:          profile?.id  || null,
      assigned_at:          driverId ? new Date().toISOString() : null,
    }
    const isCrms = Boolean(run.crmsId)
    const table  = isCrms ? 'crms_jobs' : 'orders'
    const col    = isCrms ? 'crms_id'   : 'id'
    const val    = isCrms ? run.crmsId   : run.jobId

    const { error } = await supabase.from(table).update(update).eq(col, val)

    if (error) {
      showToast('Failed to save — please try again', 'error')
      setAssigning(null)
      return
    }

    // Optimistic patch — update local state instantly without re-fetching
    setJobs(prev => prev.map(j => {
      const match = isCrms ? j.crms_id === run.crmsId : j.id === run.jobId
      if (!match) return j
      return { ...j, assigned_driver_id: driverId || null, assigned_driver_name: driver?.name || null }
    }))

    // Keep the detail panel open with updated state
    if (selectedRun?.id === run.id) {
      setSelectedRun(prev => ({
        ...prev,
        assignedDriverId: driverId      || null,
        driverName:       driver?.name   || null,
        driverColour:     driver?.colour || null,
      }))
    }

    showToast(driverId ? `${driver.name} assigned` : 'Driver removed')
    setAssigning(null)
    setTimeout(fetchJobs, 2000)
  }

  async function saveAssignment(run) {
    setAssigning(run.id)
    try {
      const table = run.crmsId ? 'crms_jobs' : 'orders'

      const delD1 = delDriver1 === 'self_collection' 
        ? { name: 'Self Collection', id: null, colour: null }
        : drivers.find(d => d.id === delDriver1) || null
      const delD2 = drivers.find(d => d.id === delDriver2) || null
      const colD1 = drivers.find(d => d.id === colDriver1) || null
      const colD2 = drivers.find(d => d.id === colDriver2) || null

      // Are DEL and COL drivers different?
      const splitDrivers = colD1 && delD1 && colD1.id !== delD1?.id

      let updatePayload = {}

      if (splitDrivers) {
        // Different drivers for DEL and COL
        updatePayload = {
          assigned_driver_id:     delD1?.id || null,
          assigned_driver_name:   delD1?.name || null,
          assigned_driver_id_2:   delD2?.id || null,
          assigned_driver_name_2: delD2?.name || null,
          driver_1_runs:          'del',
          driver_2_runs:          delD2 ? 'del' : null,
          col_driver_name:        colD1?.name || null,
          col_driver_name_2:      colD2?.name || null,
        }
      } else {
        // Same driver for both DEL and COL
        const primaryDriver = delD1 || colD1
        const secondDriver = delD2 || colD2
        updatePayload = {
          assigned_driver_id:     primaryDriver?.id || null,
          assigned_driver_name:   delDriver1 === 'self_collection' ? 'Self Collection' : (primaryDriver?.name || null),
          assigned_driver_id_2:   secondDriver?.id || null,
          assigned_driver_name_2: secondDriver?.name || null,
          driver_1_runs:          'both',
          driver_2_runs:          secondDriver ? 'both' : null,
          col_driver_name:        null,
          col_driver_name_2:      null,
        }
      }

      await supabase.from(table).update(updatePayload).eq('id', run.jobId)

      showToast('Assignment saved')
      setDelDriver1(null); setDelDriver2(null)
      setColDriver1(null); setColDriver2(null)
      fetchJobs()
      setSelectedRun(null)
      setTimeout(() => fetchJobs(), 500)
    } catch(e) {
      showToast('Error saving', 'error')
    }
    setAssigning(null)
  }

  // ── Build run list enriched with driver colour ─────────────────────────────
  const allRuns = buildRuns(jobs).map(r => {
    const d1 = drivers.find(d => d.name === r.driverName)
    const d2 = drivers.find(d => d.name === r.driverName2)
    return {
      ...r,
      driverColour: d1?.colour || null,
      driverColour2: d2?.colour || null,
      assignedDriverId: d1?.id || null,
      assignedDriverId2: d2?.id || null,
    }
  })

  function openReorderPopup(date) {
    const dateRuns = allRuns
      .filter(r => r.runDate === date)
      .sort((a, b) => (a.manualSortOrder || 0) - (b.manualSortOrder || 0))
    if (dateRuns.length < 2) return
    setReorderRuns(dateRuns)
    setReorderPopup(date)
  }

  function moveReorderRun(index, direction) {
    const newRuns = [...reorderRuns]
    const swapIndex = index + direction
    if (swapIndex < 0 || swapIndex >= newRuns.length) return
    ;[newRuns[index], newRuns[swapIndex]] = [newRuns[swapIndex], newRuns[index]]
    setReorderRuns(newRuns)
  }

  async function saveReorderPopup() {
    if (!reorderPopup) return
    setSavingReorder(true)
    const dateNum = parseInt(reorderPopup.replace(/-/g, ''))
    for (let i = 0; i < reorderRuns.length; i++) {
      const run = reorderRuns[i]
      const table = run.crmsId ? 'crms_jobs' : 'orders'
      await supabase.from(table).update({
        manual_sort_order: dateNum * 1000 + i,
        has_manual_override: true,
      }).eq('id', run.jobId)
    }
    setSavingReorder(false)
    setReorderPopup(null)
    setReorderRuns([])
    showToast('Run order saved')
    setTimeout(() => fetchJobs(), 800)
  }

  const filtered = applyFilter(
    allRuns.filter(r =>
      !search || [r.client, r.event, r.venue, r.ref].some(f => f?.toLowerCase().includes(search.toLowerCase()))
    ),
    filter,
    weekOffset,
    driverFilter,
  )

  const todayCount      = allRuns.filter(r => r.runDate === today).length
  const tomorrowCount   = allRuns.filter(r => r.runDate === tomorrow).length
  const urgentCount     = allRuns.filter(r => r.isUrgent).length
  const amendedCount    = allRuns.filter(r => r.isAmended).length
  const missingCount    = allRuns.filter(r => r.missingTime).length
  const unassignedCount = allRuns.filter(r => !r.assignedDriverId).length

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading schedule…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Sync bar */}
      <div style={S.syncBar}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#6B6860' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22C55E', display: 'inline-block' }} />
          Schedule auto-populated from Current RMS — syncs every 5 minutes
        </span>
        {syncInfo && (
          <span style={{ fontSize: '11px', color: '#9CA3AF' }}>
            Last sync: {new Date(syncInfo.completed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · {syncInfo.jobs_fetched} jobs
          </span>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        {[['DEL','#EF4444','Delivery'],['COL','#22C55E','Collection']].map(([type, color, label]) => (
          <span key={type} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
            <span style={{ background: color, color: 'white', padding: '2px 8px', borderRadius: '3px', fontSize: '11px', fontWeight: '700' }}>{type}</span> {label}
          </span>
        ))}
        {drivers.map(d => (
          <span key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px' }}>
            <span style={{ background: d.colour, color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '10px', fontWeight: '600' }}>{d.name}</span>
          </span>
        ))}
        <span style={{ fontSize: '11px', color: '#9CA3AF', marginLeft: 'auto' }}>⚡ Auto-populated from Current RMS · Read-only source</span>
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Today',      value: todayCount,      filter: 'today',      color: '#B8965A' },
          { label: 'Tomorrow',   value: tomorrowCount,   filter: 'tomorrow',   color: '#3D5A73' },
          { label: 'Urgent',     value: urgentCount,     filter: 'urgent',     color: '#EF4444' },
          { label: 'Amended',    value: amendedCount,    filter: 'amended',    color: '#F59E0B' },
          { label: 'Unassigned', value: unassignedCount, filter: 'unassigned', color: '#9CA3AF' },
        ].map(s => (
          <div key={s.label} style={{ ...S.statCard, borderTop: `3px solid ${s.color}`, cursor: 'pointer' }}
            onClick={() => { setFilter(s.filter); setView('list') }}>
            <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '28px', fontWeight: '600', color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* View + filter controls */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        {[['list','☰ List'],['week','📅 Week'],['month','🗓 Month'],['year','📆 Year'],['dispatch','🚚 Dispatch']].map(([v, label]) => (
          <button key={v} style={{ ...S.btnOutline, ...(view === v ? S.btnActive : {}) }} onClick={() => setView(v)}>{label}</button>
        ))}
        <div style={{ width: '1px', height: '24px', background: '#DDD8CF', margin: '0 4px' }} />
        {[
          ['today','Today'],['tomorrow','Tomorrow'],['week','This Week'],
          ['all','All'],['deliveries','Deliveries'],['collections','Collections'],
          ['unassigned','Unassigned'],['amended','Amended'],['urgent','Urgent'],
        ].map(([f, label]) => (
          <button key={f}
            style={{ ...S.filterBtn, ...(filter === f && view !== 'dispatch' ? S.filterBtnActive : {}) }}
            onClick={() => { setFilter(f); if (view === 'dispatch') setView('list') }}>
            {label}
          </button>
        ))}
        {/* Driver filter */}
        <select value={driverFilter} onChange={e => setDrvFilter(e.target.value)}
          style={{ ...S.select, width: 'auto', fontSize: '12px', padding: '7px 12px' }}>
          <option value="all">All Drivers</option>
          <option value="">Unassigned</option>
          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {/* Search */}
      <input
        placeholder="🔍 Search by client, event, venue, reference…"
        value={search} onChange={e => setSearch(e.target.value)}
        style={{ ...S.searchInput, marginBottom: '16px' }}
      />

      {/* ── LIST VIEW ── */}
      {view === 'list' && (
        <ListView
          filteredRuns={filtered}
          allRuns={allRuns}
          groupByDriver={groupByDriver}
          setGroup={setGroup}
          drivers={drivers}
          onSelect={setSelectedRun}
          today={today}
          tomorrow={tomorrow}
          jobNotes={jobNotes}
          pendingOrder={pendingOrder}
          savingOrder={savingOrder}
          discardOrder={discardOrder}
          saveRunOrder={saveRunOrder}
          setSelectedRun={setSelectedRun}
          setPendingOrder={setPendingOrder}
        />
      )}

      {/* ── DISPATCH VIEW ── */}
      {view === 'dispatch' && (
        <DispatchView allRuns={allRuns} drivers={drivers} today={today} tomorrow={tomorrow} onSelect={setSelectedRun} onAssign={assignDriver} assigningId={assigningId} />
      )}

      {/* ── WEEK VIEW ── */}
      {view === 'week' && <WeekView allRuns={allRuns} weekOffset={weekOffset} setWeekOffset={setWeekOffset} onSelect={setSelectedRun} />}

      {/* ── MONTH VIEW ── */}
      {view === 'month' && (
        <MonthView
          allRuns={allRuns}
          monthDate={monthDate}
          setMonthDate={setMonthDate}
          onSelect={setSelectedRun}
          dragRun={dragRun}
          dragOverDate={dragOverDate}
          setDragRun={setDragRun}
          setDragOverDate={setDragOverDate}
          saveDraggedDate={saveDraggedDate}
          showToast={showToast}
          onReorder={openReorderPopup}
        />
      )}

      {/* ── YEAR VIEW ── */}
      {view === 'year' && <YearView allRuns={allRuns} yearDate={yearDate} setYearDate={setYearDate} setMonthDate={setMonthDate} setView={setView} />}

      {/* Run detail panel */}
      {selectedRun && (
        <RunDetailPanel
          run={selectedRun}
          drivers={drivers}
          assigningId={assigningId}
          onClose={() => setSelectedRun(null)}
          delDriver1={delDriver1}
          setDelDriver1={setDelDriver1}
          delDriver2={delDriver2}
          setDelDriver2={setDelDriver2}
          colDriver1={colDriver1}
          setColDriver1={setColDriver1}
          colDriver2={colDriver2}
          setColDriver2={setColDriver2}
          saveAssignment={saveAssignment}
          jobNotes={jobNotes}
          setOverrideJob={setOverrideJob}
          setOverrideForm={setOverrideForm}
          savingOverride={savingOverride}
          saveManualOverride={saveManualOverride}
          clearManualOverride={clearManualOverride}
        />
      )}

      {reorderPopup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.5)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={() => setReorderPopup(null)}>
          <div style={{ background: '#fff', borderRadius: '10px', width: '100%', maxWidth: '360px', overflow: 'hidden', boxShadow: '0 12px 48px rgba(28,28,30,0.14)' }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #DDD8CF', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '500' }}>
                  {new Date(reorderPopup + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                </div>
                <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px' }}>
                  {reorderRuns.length} runs · use arrows to reorder
                </div>
              </div>
              <button onClick={() => setReorderPopup(null)} style={{ background: '#F7F3EE', border: 'none', width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer', fontSize: '13px', color: '#6B6860' }}>✕</button>
            </div>

            {/* Runs list */}
            <div>
              {reorderRuns.map((run, index) => (
                <div key={run.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', borderBottom: '0.5px solid #EDE8E0' }}>
                  <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: '#F7F3EE', border: '1px solid #DDD8CF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '600', color: '#6B6860', flexShrink: 0 }}>
                    {index + 1}
                  </div>
                  <span style={{ background: run.runType === 'DEL' ? '#FCEBEB' : '#EAF3DE', color: run.runType === 'DEL' ? '#A32D2D' : '#3B6D11', fontSize: '10px', fontWeight: '700', padding: '2px 7px', borderRadius: '3px', flexShrink: 0 }}>
                    {run.runType}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: '500', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{run.event || run.client}</div>
                    <div style={{ fontSize: '10px', color: '#6B6860' }}>{run.runTime || '—'} {run.driverName ? `· ${run.driverName}` : ''}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flexShrink: 0 }}>
                    <button
                      onClick={() => moveReorderRun(index, -1)}
                      disabled={index === 0}
                      style={{ width: '20px', height: '20px', border: '1px solid #DDD8CF', borderRadius: '3px', background: index === 0 ? '#F7F3EE' : '#fff', cursor: index === 0 ? 'default' : 'pointer', color: index === 0 ? '#DDD8CF' : '#6B6860', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                    >▲</button>
                    <button
                      onClick={() => moveReorderRun(index, 1)}
                      disabled={index === reorderRuns.length - 1}
                      style={{ width: '20px', height: '20px', border: '1px solid #DDD8CF', borderRadius: '3px', background: index === reorderRuns.length - 1 ? '#F7F3EE' : '#fff', cursor: index === reorderRuns.length - 1 ? 'default' : 'pointer', color: index === reorderRuns.length - 1 ? '#DDD8CF' : '#6B6860', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                    >▼</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div style={{ padding: '12px 16px', borderTop: '1px solid #DDD8CF', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => setReorderPopup(null)} style={{ fontSize: '12px', padding: '7px 16px', borderRadius: '6px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Discard</button>
              <button onClick={saveReorderPopup} disabled={savingReorder} style={{ fontSize: '12px', padding: '7px 16px', borderRadius: '6px', border: 'none', background: '#1C1C1E', color: '#fff', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' }}>
                {savingReorder ? 'Saving…' : 'Save order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', right: '24px',
          background: toast.type === 'error' ? '#EF4444' : '#1C1C1E',
          color: 'white', padding: '14px 20px', borderRadius: '8px',
          fontSize: '13.5px', fontFamily: "'DM Sans', sans-serif",
          borderLeft: `3px solid ${toast.type === 'error' ? '#991B1B' : '#22C55E'}`,
          boxShadow: '0 12px 48px rgba(28,28,30,0.18)', zIndex: 999,
          display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          <span>{toast.type === 'error' ? '⚠' : '✓'}</span>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  )
}

// ── LIST VIEW ─────────────────────────────────────────────────────────────────
function ListView({
  filteredRuns,
  allRuns,
  groupByDriver,
  setGroup,
  drivers,
  onSelect,
  today,
  tomorrow,
  jobNotes,
  pendingOrder,
  savingOrder,
  discardOrder,
  saveRunOrder,
  setSelectedRun,
  setPendingOrder,
}) {
  if (filteredRuns.length === 0) return (
    <div style={{ textAlign: 'center', padding: '48px', color: '#9CA3AF', fontSize: '14px' }}>
      No schedule entries for this filter
    </div>
  )

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
        <button style={{ ...S.filterBtn, ...(groupByDriver ? S.filterBtnActive : {}) }} onClick={() => setGroup(g => !g)}>
          👤 Group by Driver
        </button>
      </div>
      {groupByDriver
        ? <GroupedByDriverView runs={filteredRuns} drivers={drivers} onSelect={onSelect} />
        : (() => {
          const dates = [...new Set(filteredRuns.map(r => r.runDate))].sort()
          return dates.map(date => {
            const dateRuns = pendingOrder?.date === date 
              ? pendingOrder.runs 
              : filteredRuns
                  .filter(r => r.runDate === date)
                  .sort((a, b) => (a.manualSortOrder || 0) - (b.manualSortOrder || 0))
            
            const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { 
              weekday: 'long', day: 'numeric', month: 'long' 
            })

            function moveRun(index, direction) {
              const newRuns = [...dateRuns]
              const swapIndex = index + direction
              if (swapIndex < 0 || swapIndex >= newRuns.length) return
              ;[newRuns[index], newRuns[swapIndex]] = [newRuns[swapIndex], newRuns[index]]
              setPendingOrder({ date, runs: newRuns })
            }

            return (
              <div key={date} style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#B8965A', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {dateLabel} · {dateRuns.length} run{dateRuns.length !== 1 ? 's' : ''}
                  </div>
                  {pendingOrder?.date === date && (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', color: '#92400E', fontWeight: '500' }}>
                        Unsaved order changes
                      </span>
                      <button 
                        onClick={discardOrder} 
                        style={{ fontSize: '11px', padding: '5px 12px', borderRadius: '4px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
                      >Discard</button>
                      <button 
                        onClick={() => {
                          console.log('Save order clicked, pendingOrder:', pendingOrder)
                          saveRunOrder()
                        }}
                        disabled={savingOrder} 
                        style={{ fontSize: '11px', padding: '5px 12px', borderRadius: '4px', border: 'none', background: '#1C1C1E', color: '#fff', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' }}
                      >{savingOrder ? 'Saving…' : 'Save order'}</button>
                    </div>
                  )}
                </div>

                <div style={S.card}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        <th style={{ ...S.th, width: '70px' }}>Order</th>
                        <th style={S.th}>D/C</th>
                        <th style={S.th}>Time</th>
                        <th style={S.th}>Event / Client</th>
                        <th style={S.th}>Venue</th>
                        <th style={S.th}>Driver</th>
                        <th style={S.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {dateRuns.map((run, index) => {
                        const isDel = run.runType === 'DEL'
                        const badgeBg = isDel ? '#EF4444' : '#22C55E'
                        return (
                          <tr key={run.id} style={{ cursor: 'pointer' }}>
                            <td style={S.td}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ 
                                  width: '22px', height: '22px', borderRadius: '50%', 
                                  background: '#F7F3EE', border: '1px solid #DDD8CF',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: '11px', fontWeight: '600', color: '#6B6860',
                                  flexShrink: 0
                                }}>{index + 1}</span>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); moveRun(index, -1) }}
                                    disabled={index === 0}
                                    style={{ 
                                      width: '18px', height: '18px', border: '1px solid #DDD8CF',
                                      borderRadius: '3px', background: index === 0 ? '#F7F3EE' : '#fff',
                                      cursor: index === 0 ? 'default' : 'pointer',
                                      color: index === 0 ? '#DDD8CF' : '#6B6860',
                                      fontSize: '10px', display: 'flex', alignItems: 'center',
                                      justifyContent: 'center', padding: 0, lineHeight: 1
                                    }}
                                  >▲</button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); moveRun(index, 1) }}
                                    disabled={index === dateRuns.length - 1}
                                    style={{ 
                                      width: '18px', height: '18px', border: '1px solid #DDD8CF',
                                      borderRadius: '3px', background: index === dateRuns.length - 1 ? '#F7F3EE' : '#fff',
                                      cursor: index === dateRuns.length - 1 ? 'default' : 'pointer',
                                      color: index === dateRuns.length - 1 ? '#DDD8CF' : '#6B6860',
                                      fontSize: '10px', display: 'flex', alignItems: 'center',
                                      justifyContent: 'center', padding: 0, lineHeight: 1
                                    }}
                                  >▼</button>
                                </div>
                              </div>
                            </td>
                            <td style={S.td} onClick={() => setSelectedRun(run)}>
                              <span style={{ background: badgeBg, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>
                                {run.runType}
                              </span>
                              {run.isManualOverride && (
                                <span style={{ background: '#EFF6FF', color: '#1D4ED8', fontSize: '9px', fontWeight: '600', padding: '1px 5px', borderRadius: '3px', marginLeft: '4px' }}>
                                  MANUAL
                                </span>
                              )}
                            </td>
                            <td style={S.td} onClick={() => setSelectedRun(run)}>
                              {run.runTime || '—'}
                            </td>
                            <td style={S.td} onClick={() => setSelectedRun(run)}>
                              <div style={{ fontWeight: 500, fontSize: '13px' }}>{run.event || run.client}</div>
                              <div style={{ fontSize: '11px', color: '#6B6860' }}>{run.client}</div>
                            </td>
                            <td style={S.td} onClick={() => setSelectedRun(run)}>
                              {run.venue || '—'}
                            </td>
                            <td style={S.td} onClick={() => setSelectedRun(run)}>
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                {run.driverName && (
                                  <span style={{ background: run.driverColour || '#3D5A73', color: 'white', fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '10px' }}>
                                    {run.driverName}
                                  </span>
                                )}
                                {run.driverName2 && (
                                  <span style={{ background: run.driverColour2 || '#5F5E5A', color: 'white', fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '10px' }}>
                                    {run.driverName2}
                                  </span>
                                )}
                                {!run.driverName && (
                                  <span style={{ background: '#FEF3C7', color: '#92400E', fontSize: '11px', fontWeight: '500', padding: '3px 10px', borderRadius: '10px' }}>
                                    Unassigned
                                  </span>
                                )}
                              </div>
                            </td>
                            <td style={S.td} onClick={() => setSelectedRun(run)}>
                              <span style={{ fontSize: '12px', color: '#B8965A' }}>View →</span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })
        })()
      }
    </div>
  )
}

function DateGroup({ date, runs, onSelect, today, tomorrow, jobNotes }) {
  const isToday = date === today
  const isTomorrow = date === tomorrow
  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '10px 16px',
        background: isToday ? '#1C1C1E' : '#F7F3EE',
        color: isToday ? 'white' : '#1C1C1E',
        borderRadius: '6px', marginBottom: '8px',
        border: isToday ? '2px solid #B8965A' : '1px solid #DDD8CF',
      }}>
        <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '18px', fontWeight: '600' }}>
          {isToday ? '📌 TODAY — ' : isTomorrow ? '📅 TOMORROW — ' : ''}{fmt(date)}
        </span>
        <span style={{ fontSize: '11px', opacity: 0.6 }}>{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
        {runs.some(r => r.isUrgent) && <span style={{ background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '3px' }}>⚠ URGENT</span>}
      </div>
      <div style={S.card}>
        <table style={S.table}>
          <thead>
            <tr>{['D/C','Time','Event / Client','Venue','Driver','Notes','Ref','Status',''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {runs.map((run, i) => <RunRow key={i} run={run} onSelect={onSelect} jobNotes={jobNotes} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RunRow({ run, onSelect, jobNotes }) {
  const colors = run.runType === 'DEL'
    ? { badge: '#EF4444' }
    : { badge: '#22C55E' }
  return (
    <tr style={{ background: run.isUrgent ? '#FFF5F5' : run.missingTime ? '#FFFBEB' : 'white', cursor: 'pointer' }}
      onClick={() => onSelect(run)}>
      <td style={S.td}>
        <span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>{run.runType}</span>
        {run.isManualOverride && (
          <span style={{ background: '#EFF6FF', color: '#1D4ED8', fontSize: '9px', fontWeight: '600', padding: '1px 5px', borderRadius: '3px', marginLeft: '4px' }}>
            MANUAL
          </span>
        )}
      </td>
      <td style={{ ...S.td, fontWeight: '600', fontFamily: "'Cormorant Garamond', serif", fontSize: '16px', color: run.missingTime ? '#9CA3AF' : '#1C1C1E' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span>
            {run.runTime || '—'}
            {run.runType === 'DEL' && run.deliveryEndTime
              ? ` - ${run.deliveryEndTime}`
              : run.runType === 'COL' && run.collectionEndTime
                ? ` - ${run.collectionEndTime}`
                : ''}
          </span>
          {run.isTimed && (
            <span style={{
              background: '#FEF3C7',
              color: '#854F0B',
              fontSize: '9px',
              fontWeight: '700',
              padding: '2px 6px',
              borderRadius: '4px',
              border: '1px solid #FDE68A',
              whiteSpace: 'nowrap',
            }}>⏱ TIMED</span>
          )}
        </div>
      </td>
      <td style={S.td}>
        <div style={{ fontWeight: 500 }}>{run.event || run.client}</div>
        <div style={{ fontSize: '11.5px', color: '#6B6860' }}>{run.client}</div>
      </td>
      <td style={{ ...S.td, fontSize: '12px', color: '#6B6860', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.venue || '—'}</td>
      <td style={S.td}>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          {run.driverName && (
            <span style={{
              background: run.driverColour || '#3D5A73',
              color: 'white',
              fontSize: '11px',
              fontWeight: '600',
              padding: '3px 10px',
              borderRadius: '10px'
            }}>{run.driverName}</span>
          )}
          {run.driverName2 && (
            <span style={{
              background: run.driverColour2 || '#5F5E5A',
              color: 'white',
              fontSize: '11px',
              fontWeight: '600',
              padding: '3px 10px',
              borderRadius: '10px'
            }}>{run.driverName2}</span>
          )}
          {!run.driverName && !run.driverName2 && (
            <span style={{
              background: '#FEF3C7',
              color: '#92400E',
              fontSize: '11px',
              fontWeight: '500',
              padding: '3px 10px',
              borderRadius: '10px'
            }}>Unassigned</span>
          )}
        </div>
      </td>
      <td style={S.td}>
        {jobNotes[run.jobId]?.total > 0 ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '10px', fontWeight: '500', padding: '2px 7px',
            borderRadius: '10px', cursor: 'pointer',
            background: jobNotes[run.jobId]?.hasUrgent ? '#FCEBEB' : '#F7F3EE',
            color: jobNotes[run.jobId]?.hasUrgent ? '#A32D2D' : '#B8965A',
          }}>
            {jobNotes[run.jobId]?.hasUrgent ? '⚠' : '📋'} {jobNotes[run.jobId]?.total}
          </span>
        ) : null}
      </td>
      <td style={{ ...S.td, fontFamily: "'Cormorant Garamond', serif", fontSize: '14px', color: '#B8965A' }}>{run.ref}</td>
      <td style={S.td}>
        <span style={{ background: run.status === 'confirmed' ? '#ECFDF5' : '#FFFBEB', color: run.status === 'confirmed' ? '#065F46' : '#92400E', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', textTransform: 'capitalize' }}>
          {run.status}
        </span>
      </td>
      <td style={S.td}><button style={S.btnGhost}>View →</button></td>
    </tr>
  )
}

// ── GROUPED BY DRIVER VIEW ────────────────────────────────────────────────────
function GroupedByDriverView({ runs, drivers, onSelect }) {
  const groups = {}
  runs.forEach(r => {
    const key = r.assignedDriverId || '__unassigned'
    if (!groups[key]) groups[key] = []
    groups[key].push(r)
  })

  const driverMap = drivers.reduce((m, d) => ({ ...m, [d.id]: d }), {})

  return (
    <div>
      {Object.entries(groups).map(([driverId, driverRuns]) => {
        const driver = driverId === '__unassigned' ? null : driverMap[driverId]
        return (
          <div key={driverId} style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', padding: '10px 16px', background: driver ? driver.colour : '#F7F3EE', borderRadius: '6px' }}>
              <span style={{ color: driver ? 'white' : '#9CA3AF', fontWeight: '700', fontSize: '14px', letterSpacing: '0.05em' }}>
                {driver ? `🚚 ${driver.name.toUpperCase()}` : '⬜ UNASSIGNED'}
              </span>
              <span style={{ fontSize: '12px', color: driver ? 'rgba(255,255,255,0.7)' : '#9CA3AF' }}>
                {driverRuns.length} run{driverRuns.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div style={S.card}>
              <table style={S.table}>
                <thead>
                  <tr>{['D/C','Date','Time','Event / Client','Venue','Ref','Status',''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {driverRuns.map((run, i) => {
                    const colors = run.runType === 'DEL' ? { badge: '#EF4444' } : { badge: '#22C55E' }
                    return (
                      <tr key={i} style={{ cursor: 'pointer' }} onClick={() => onSelect(run)}>
                        <td style={S.td}>
                          <span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>{run.runType}</span>
                          {run.isManualOverride && (
                            <span style={{ background: '#EFF6FF', color: '#1D4ED8', fontSize: '9px', fontWeight: '600', padding: '1px 5px', borderRadius: '3px', marginLeft: '4px' }}>
                              MANUAL
                            </span>
                          )}
                        </td>
                        <td style={S.td}>{fmt(run.runDate)}</td>
                        <td style={{ ...S.td, fontFamily: "'Cormorant Garamond', serif", fontSize: '15px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span>
                              {run.runTime || '—'}
                              {run.runType === 'DEL' && run.deliveryEndTime
                                ? ` - ${run.deliveryEndTime}`
                                : run.runType === 'COL' && run.collectionEndTime
                                  ? ` - ${run.collectionEndTime}`
                                  : ''}
                            </span>
                            {run.isTimed && (
                              <span style={{
                                background: '#FEF3C7',
                                color: '#854F0B',
                                fontSize: '9px',
                                fontWeight: '700',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                border: '1px solid #FDE68A',
                                whiteSpace: 'nowrap',
                              }}>⏱ TIMED</span>
                            )}
                          </div>
                        </td>
                        <td style={S.td}><div style={{ fontWeight: 500 }}>{run.event || run.client}</div><div style={{ fontSize: '11px', color: '#6B6860' }}>{run.client}</div></td>
                        <td style={{ ...S.td, fontSize: '12px', color: '#6B6860' }}>{run.venue || '—'}</td>
                        <td style={{ ...S.td, fontFamily: "'Cormorant Garamond', serif", fontSize: '14px', color: '#B8965A' }}>{run.ref}</td>
                        <td style={S.td}><span style={{ background: '#ECFDF5', color: '#065F46', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', textTransform: 'capitalize' }}>{run.status}</span></td>
                        <td style={S.td}><button style={S.btnGhost}>View →</button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}


// ── DISPATCH VIEW ─────────────────────────────────────────────────────────────
function DispatchView({ allRuns, drivers, today, tomorrow, onSelect, onAssign, assigningId }) {
  const [dayOffset, setDayOffset] = useState(0)
  const targetDate = (() => {
    const d = new Date(); d.setDate(d.getDate() + dayOffset)
    return d.toLocaleDateString('en-CA')
  })()

  const dayRuns = allRuns.filter(r => r.runDate === targetDate)

  const groups = { __unassigned: [] }
  drivers.forEach(d => { groups[d.id] = [] })
  dayRuns.forEach(r => {
    const key = r.assignedDriverId || '__unassigned'
    if (!groups[key]) groups[key] = []
    groups[key].push(r)
  })

  const isToday    = targetDate === today
  const isTomorrow = targetDate === tomorrow
  const label      = isToday ? 'TODAY' : isTomorrow ? 'TOMORROW' : fmt(targetDate)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <button style={S.btnOutline} onClick={() => setDayOffset(d => d - 1)}>← Previous</button>
        <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', fontWeight: '600', padding: '0 8px' }}>
          🚚 Dispatch — {label}
        </span>
        <button style={{ ...S.btnOutline, ...(isToday ? S.btnActive : {}) }} onClick={() => setDayOffset(0)}>Today</button>
        <button style={S.btnOutline} onClick={() => setDayOffset(d => d + 1)}>Next →</button>
      </div>

      {dayRuns.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px', color: '#9CA3AF', fontSize: '14px', background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px' }}>
          No runs scheduled for {fmt(targetDate)}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '16px' }}>
          {/* Unassigned column — always show if any unassigned */}
          {groups.__unassigned.length > 0 && (
            <DispatchColumn
              title="Unassigned" colour="#9CA3AF"
              runs={groups.__unassigned} drivers={drivers}
              onSelect={onSelect} onAssign={onAssign} assigningId={assigningId}
            />
          )}
          {/* Driver columns */}
          {drivers.map(driver => (
            groups[driver.id]?.length > 0 && (
              <DispatchColumn
                key={driver.id}
                title={driver.name} colour={driver.colour}
                runs={groups[driver.id]} drivers={drivers}
                onSelect={onSelect} onAssign={onAssign}
                driverId={driver.id} assigningId={assigningId}
              />
            )
          ))}
        </div>
      )}
    </div>
  )
}

function DispatchColumn({ title, colour, runs, drivers, onSelect, onAssign, driverId, assigningId }) {
  return (
    <div style={{ background: '#fff', border: `2px solid ${colour}`, borderRadius: '8px', overflow: 'hidden' }}>
      <div style={{ background: colour, color: 'white', padding: '12px 16px', fontWeight: '700', fontSize: '13px', letterSpacing: '0.05em' }}>
        🚚 {title.toUpperCase()} · {runs.length} run{runs.length !== 1 ? 's' : ''}
      </div>
      <div style={{ padding: '10px' }}>
        {runs.map((run, i) => (
          <DispatchCard
            key={run.id || i}
            run={run} drivers={drivers}
            onSelect={onSelect} onAssign={onAssign}
            isSaving={assigningId === run.id}
          />
        ))}
      </div>
    </div>
  )
}

function DispatchCard({ run, drivers, onSelect, onAssign, isSaving }) {
  const colors = run.runType === 'DEL'
    ? { bg: '#FEF2F2', border: '#EF4444', badge: '#EF4444', text: '#991B1B' }
    : { bg: '#F0FDF4', border: '#22C55E', badge: '#22C55E', text: '#166534' }

  return (
    <div style={{
      background: colors.bg,
      border: `1.5px solid ${isSaving ? '#B8965A' : colors.border}`,
      borderRadius: '6px', padding: '12px', marginBottom: '8px',
      opacity: isSaving ? 0.75 : 1,
      transition: 'all 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
        <span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' }}>{run.runType}</span>
        {run.runTime && <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '16px', fontWeight: '600', color: colors.text }}>{run.runTime.substring(0, 5)}</span>}
        {run.isUrgent && <span style={{ background: '#EF4444', color: 'white', fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '2px' }}>URGENT</span>}
        {isSaving && <span style={{ fontSize: '10px', color: '#B8965A', marginLeft: 'auto' }}>Saving…</span>}
      </div>

      <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '2px', cursor: 'pointer' }} onClick={() => onSelect(run)}>
        {run.event || run.client}
      </div>
      <div style={{ fontSize: '11.5px', color: '#6B6860', marginBottom: '10px' }}>{run.venue || run.client}</div>

      {/* Current driver badge */}
      {run.driverName && (
        <div style={{ marginBottom: '8px' }}>
          <span style={{ background: run.driverColour || '#3D5A73', color: 'white', padding: '3px 10px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>
            🚚 {run.driverName}
          </span>
        </div>
      )}

      {/* Assign Driver */}
      <div>
        <div style={{ fontSize: '10px', color: '#9CA3AF', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '5px' }}>
          {run.driverName ? 'Change Driver' : 'Assign Driver'}
        </div>
        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          <button
            disabled={isSaving}
            style={{ ...S.assignBtn, ...((!run.assignedDriverId) ? { background: '#F7F3EE', borderColor: '#B8965A', color: '#B8965A' } : {}) }}
            onClick={() => onAssign(run, null)}>
            —
          </button>
          {drivers.map(d => (
            <button
              key={d.id}
              disabled={isSaving}
              style={{
                ...S.assignBtn,
                ...(run.assignedDriverId === d.id
                  ? { background: d.colour, color: 'white', borderColor: d.colour }
                  : {}),
              }}
              onClick={() => onAssign(run, d.id)}>
              {d.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── RUN DETAIL: ITEMS / CHANGES (tabs) ─────────────────────────────────────────
function RunDetailItems({ run }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!run.crmsId || !run.jobId) {
      setItems([])
      setLoading(false)
      return
    }
    let cancelled = false
    supabase.from('crms_job_items').select('id, item_name, quantity, unit, category').eq('job_id', run.jobId).then(({ data }) => {
      if (!cancelled) {
        setItems(data || [])
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [run.jobId, run.crmsId])
  if (!run.crmsId) {
    return <div style={{ color: '#6B6860', fontSize: '13px', lineHeight: 1.6 }}>Equipment line items are available for jobs imported from Current RMS.</div>
  }
  if (loading) return <div style={{ color: '#9CA3AF', fontSize: '13px' }}>Loading items…</div>
  if (!items.length) return <div style={{ color: '#9CA3AF', fontSize: '13px' }}>No line items synced yet.</div>
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {items.map(it => (
        <li key={it.id} style={{ padding: '10px 0', borderBottom: '1px solid #EDE8E0', fontSize: '13px' }}>
          <span style={{ fontWeight: '600' }}>{it.item_name}</span>
          <span style={{ color: '#6B6860', marginLeft: '8px' }}>×{it.quantity} {it.unit}</span>
          {it.category && <span style={{ fontSize: '11px', color: '#9CA3AF', marginLeft: '8px' }}>({it.category})</span>}
        </li>
      ))}
    </ul>
  )
}

function RunDetailChanges({ run }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!run.ref) {
      setRows([])
      setLoading(false)
      return
    }
    let cancelled = false
    supabase.from('change_log').select('*').eq('job_ref', run.ref).order('detected_at', { ascending: false }).limit(40).then(({ data }) => {
      if (!cancelled) {
        setRows(data || [])
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [run.ref])
  if (loading) return <div style={{ color: '#9CA3AF', fontSize: '13px' }}>Loading changes…</div>
  if (!rows.length) return <div style={{ color: '#9CA3AF', fontSize: '13px' }}>No sync changes recorded for this job.</div>
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {rows.map(c => (
        <li key={c.id} style={{ padding: '10px 0', borderBottom: '1px solid #EDE8E0', fontSize: '12px' }}>
          <div style={{ fontWeight: '600', color: '#1C1C1E' }}>{c.field_changed?.replace(/_/g, ' ')} — {c.event_name}</div>
          <div style={{ color: '#6B6860', marginTop: '4px' }}>{c.old_value || '(empty)'} → {c.new_value}</div>
          <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: '4px' }}>{c.detected_at && new Date(c.detected_at).toLocaleString('en-GB')}</div>
        </li>
      ))}
    </ul>
  )
}

// ── RUN DETAIL PANEL ──────────────────────────────────────────────────────────
function RunDetailPanel({
  run,
  drivers,
  onClose,
  assigningId,
  delDriver1,
  setDelDriver1,
  delDriver2,
  setDelDriver2,
  colDriver1,
  setColDriver1,
  colDriver2,
  setColDriver2,
  saveAssignment,
  jobNotes,
  setOverrideJob,
  setOverrideForm,
  savingOverride,
  saveManualOverride,
  clearManualOverride,
}) {
  const [tab, setTab] = useState('details')
  useEffect(() => { setTab('details') }, [run.id])
  const colors = run.runType === 'DEL'
    ? { border: '#EF4444', badge: '#EF4444', bg: '#FEF2F2' }
    : { border: '#22C55E', badge: '#22C55E', bg: '#F0FDF4' }

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.panel}>
        <div style={{ ...S.panelHeader, borderBottom: `3px solid ${colors.border}` }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px', flexWrap: 'wrap' }}>
              <span style={{ background: colors.badge, color: 'white', fontSize: '12px', fontWeight: '700', padding: '4px 10px', borderRadius: '4px' }}>{run.runType}</span>
              <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600' }}>{run.event || run.client}</span>
              {run.isUrgent && <span style={{ background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '3px' }}>⚠ URGENT</span>}
            </div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>{run.ref} · {run.client}</div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '24px 28px', overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '16px', borderBottom: '1px solid #EDE8E0', paddingBottom: '12px' }}>
            <button type="button" style={{ ...S.tabBtn, ...(tab === 'details' ? S.tabBtnActive : {}) }} onClick={() => setTab('details')}>Details</button>
            <button type="button" style={{ ...S.tabBtn, ...(tab === 'items' ? S.tabBtnActive : {}) }} onClick={() => setTab('items')}>Items</button>
            <button type="button" style={{ ...S.tabBtn, ...(tab === 'changes' ? S.tabBtnActive : {}) }} onClick={() => setTab('changes')}>Changes</button>
            <button type="button" style={{ ...S.tabBtn, ...(tab === 'notes' ? S.tabBtnActive : {}) }} onClick={() => setTab('notes')}>
              Notes {jobNotes[run.jobId]?.total > 0 ? `(${jobNotes[run.jobId].total})` : ''}
            </button>
            <button
              type="button"
              style={{ ...S.tabBtn, ...(tab === 'evidence' ? S.tabBtnActive : {}) }}
              onClick={() => setTab('evidence')}
            >
              Evidence
            </button>
          </div>

          {tab === 'details' && (
          <>
          {/* Details grid */}
          <div style={S.sectionLabel}>{run.runType === 'DEL' ? 'Delivery' : 'Collection'} Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            {[
              ['Date',      fmt(run.runDate)],
              ['Time',      (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span>
                    {run.runTime || '⚠ Not set'}
                    {run.runType === 'DEL' && run.deliveryEndTime ? ` — ${run.deliveryEndTime}` : run.runType === 'COL' && run.collectionEndTime ? ` — ${run.collectionEndTime}` : ''}
                  </span>
                  {run.isTimed && (
                    <span style={{
                      background: '#FEF3C7',
                      color: '#854F0B',
                      fontSize: '9px',
                      fontWeight: '700',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      border: '1px solid #FDE68A',
                      whiteSpace: 'nowrap',
                    }}>⏱ TIMED</span>
                  )}
                </div>
              )],
              ['Client',    run.client],
              ['Venue',     run.venue || '—'],
              ['Status',    run.status],
              ['Reference', run.ref],
            ].map(([label, value]) => (
              <div key={label} style={{ background: '#F7F3EE', borderRadius: '6px', padding: '12px' }}>
                <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '4px' }}>{label}</div>
                <div style={{ fontSize: '13.5px', fontWeight: '500', color: '#1C1C1E', ...(label !== 'Time' ? { textTransform: 'capitalize' } : {}) }}>{value}</div>
              </div>
            ))}

            {/* Venue & Address */}
            {run.job.venue_address && (
              <div style={{ gridColumn: '1/-1', background: '#F7F3EE', borderRadius: '6px', padding: '12px' }}>
                <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '6px' }}>Venue & Address</div>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: '500', color: '#1C1C1E', marginBottom: '2px' }}>
                      {run.job.venue || run.job.venue_address}
                    </div>
                    <div style={{ fontSize: '12px', color: '#6B6860', lineHeight: 1.5 }}>
                      {run.job.venue_address}
                    </div>
                  </div>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((run.job.venue || '') + ' ' + (run.job.venue_address || ''))}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ flexShrink: 0, fontSize: '11px', fontWeight: '500', padding: '6px 12px', borderRadius: '6px', background: '#fff', border: '1px solid #DDD8CF', color: '#1C1C1E', textDecoration: 'none', whiteSpace: 'nowrap' }}
                  >
                    Open in Maps
                  </a>
                </div>
              </div>
            )}
          </div>

          {(run.driverName || run.driverName2) && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
              {run.driverName && (
                <span style={{ background: run.driverColour || '#3D5A73', color: 'white', padding: '6px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: '600' }}>
                  🚚 {run.driverName}
                </span>
              )}
              {run.driverName2 && (
                <span style={{ background: run.driverColour2 || '#5F5E5A', color: 'white', padding: '6px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: '600' }}>
                  🚚 {run.driverName2}
                </span>
              )}
            </div>
          )}

          <hr style={S.divider} />
          <div style={S.sectionLabel}>Manual Override</div>
          {run.job.has_manual_override && (
            <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '6px', padding: '10px 12px', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '12px', color: '#1D4ED8' }}>
                Manual override active — sync will not change these dates
              </div>
              <button
                onClick={() => clearManualOverride(run.jobId)}
                style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '4px', border: '1px solid #BFDBFE', background: 'transparent', color: '#1D4ED8', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
              >Clear override</button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
            <div>
              <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>DEL date</div>
              <input type="date"
                defaultValue={run.job.manual_delivery_date || run.job.delivery_date || ''}
                onChange={e => setOverrideForm(f => ({ ...f, delivery_date: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}
              />
            </div>
            <div>
              <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>DEL time</div>
              <input type="time"
                defaultValue={run.job.manual_delivery_time || run.job.delivery_time?.substring(0,5) || ''}
                onChange={e => setOverrideForm(f => ({ ...f, delivery_time: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}
              />
            </div>
            <div>
              <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>DEL end time</div>
              <input type="time"
                defaultValue={run.job.delivery_end_time?.substring(0,5) || ''}
                onChange={e => setOverrideForm(f => ({ ...f, delivery_end_time: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}
              />
            </div>
            <div>
              <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>COL date</div>
              <input type="date"
                defaultValue={run.job.manual_collection_date || run.job.collection_date || ''}
                onChange={e => setOverrideForm(f => ({ ...f, collection_date: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}
              />
            </div>
            <div>
              <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>COL time</div>
              <input type="time"
                defaultValue={run.job.manual_collection_time || run.job.collection_time?.substring(0,5) || ''}
                onChange={e => setOverrideForm(f => ({ ...f, collection_time: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}
              />
            </div>
            <div>
              <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>COL end time</div>
              <input type="time"
                defaultValue={run.job.collection_end_time?.substring(0,5) || ''}
                onChange={e => setOverrideForm(f => ({ ...f, collection_end_time: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}
              />
            </div>
          </div>
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>Venue override</div>
            <input type="text"
              defaultValue={run.job.manual_venue || run.job.venue || ''}
              placeholder="Override venue name..."
              onChange={e => setOverrideForm(f => ({ ...f, venue: e.target.value }))}
              style={{ width: '100%', padding: '7px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }}
            />
          </div>
          <button
            onClick={() => { setOverrideJob(run.job); saveManualOverride(run.job) }}
            disabled={savingOverride}
            style={{ width: '100%', padding: '10px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
          >
            {savingOverride ? 'Saving…' : 'Save override'}
          </button>

          {/* ── DRIVER ASSIGNMENT ── */}
          <div style={{ marginTop: '8px' }}>
            <div style={S.sectionLabel}>Driver Assignment</div>

            {/* DEL Assignment */}
            {run?.job?.delivery_date && (
              <div style={{ border: '1px solid #FCA5A5', borderRadius: '8px', padding: '12px 14px', marginBottom: '10px', background: '#FFF8F8' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <span style={{ background: '#FCEBEB', color: '#A32D2D', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '4px' }}>DEL</span>
                  <span style={{ fontSize: '12px', color: '#6B6860' }}>
                    {run.job.delivery_date}{' '}
                    {run.job.delivery_time?.substring(0, 5) || '—'}
                    {run.job.delivery_end_time?.substring(0, 5) && ` — ${run.job.delivery_end_time?.substring(0, 5)}`}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                  <button
                    onClick={() => setDelDriver1(null)}
                    style={{ fontSize: '11px', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: !delDriver1 ? '#F7F3EE' : 'transparent', color: !delDriver1 ? '#B8965A' : '#6B6860', border: `1.5px dashed ${!delDriver1 ? '#B8965A' : '#DDD8CF'}` }}
                  >None</button>
                  {drivers.map(d => (
                    <button
                      key={d.id}
                      onClick={() => setDelDriver1(d.id)}
                      style={{ fontSize: '11px', fontWeight: '500', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: delDriver1 === d.id ? (d.colour || '#1C1C1E') : 'transparent', color: delDriver1 === d.id ? '#fff' : '#1C1C1E', border: `1.5px solid ${delDriver1 === d.id ? (d.colour || '#1C1C1E') : '#DDD8CF'}` }}>{d.name}</button>
                  ))}
                  <button
                    onClick={() => setDelDriver1('self_collection')}
                    style={{ fontSize: '11px', fontWeight: '500', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: delDriver1 === 'self_collection' ? '#F1F5F9' : 'transparent', color: delDriver1 === 'self_collection' ? '#475569' : '#6B6860', border: `1.5px solid ${delDriver1 === 'self_collection' ? '#94A3B8' : '#DDD8CF'}` }}
                  >Self Collection</button>
                </div>

                {/* Driver 2 for DEL */}
                {delDriver1 && delDriver1 !== 'self_collection' && (
                  <div>
                    <div style={{ fontSize: '10px', color: '#6B6860', marginBottom: '6px' }}>+ Second driver (optional)</div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <button onClick={() => setDelDriver2(null)} style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: !delDriver2 ? '#F7F3EE' : 'transparent', color: '#6B6860', border: `1.5px dashed ${!delDriver2 ? '#B8965A' : '#DDD8CF'}` }}>None</button>
                      {drivers.filter(d => d.id !== delDriver1).map(d => (
                        <button key={d.id} onClick={() => setDelDriver2(d.id)} style={{ fontSize: '11px', fontWeight: '500', padding: '4px 10px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: delDriver2 === d.id ? (d.colour || '#1C1C1E') : 'transparent', color: delDriver2 === d.id ? '#fff' : '#1C1C1E', border: `1.5px solid ${delDriver2 === d.id ? (d.colour || '#1C1C1E') : '#DDD8CF'}` }}>{d.name}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* COL Assignment */}
            {run?.job?.collection_date && (
              <div style={{ border: '1px solid #86EFAC', borderRadius: '8px', padding: '12px 14px', marginBottom: '12px', background: '#F8FFF8' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <span style={{ background: '#EAF3DE', color: '#3B6D11', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '4px' }}>COL</span>
                  <span style={{ fontSize: '12px', color: '#6B6860' }}>
                    {run.job.collection_date}{' '}
                    {run.job.collection_time?.substring(0, 5) || '—'}
                    {run.job.collection_end_time?.substring(0, 5) && ` — ${run.job.collection_end_time?.substring(0, 5)}`}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                  <button
                    onClick={() => setColDriver1(null)}
                    style={{ fontSize: '11px', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: !colDriver1 ? '#F7F3EE' : 'transparent', color: !colDriver1 ? '#B8965A' : '#6B6860', border: `1.5px dashed ${!colDriver1 ? '#B8965A' : '#DDD8CF'}` }}
                  >None</button>
                  {drivers.map(d => (
                    <button key={d.id} onClick={() => setColDriver1(d.id)} style={{ fontSize: '11px', fontWeight: '500', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: colDriver1 === d.id ? (d.colour || '#1C1C1E') : 'transparent', color: colDriver1 === d.id ? '#fff' : '#1C1C1E', border: `1.5px solid ${colDriver1 === d.id ? (d.colour || '#1C1C1E') : '#DDD8CF'}` }}>{d.name}</button>
                  ))}
                </div>

                {/* Driver 2 for COL */}
                {colDriver1 && (
                  <div>
                    <div style={{ fontSize: '10px', color: '#6B6860', marginBottom: '6px' }}>+ Second driver (optional)</div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <button onClick={() => setColDriver2(null)} style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: !colDriver2 ? '#F7F3EE' : 'transparent', color: '#6B6860', border: `1.5px dashed ${!colDriver2 ? '#B8965A' : '#DDD8CF'}` }}>None</button>
                      {drivers.filter(d => d.id !== colDriver1).map(d => (
                        <button key={d.id} onClick={() => setColDriver2(d.id)} style={{ fontSize: '11px', fontWeight: '500', padding: '4px 10px', borderRadius: '20px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: colDriver2 === d.id ? (d.colour || '#1C1C1E') : 'transparent', color: colDriver2 === d.id ? '#fff' : '#1C1C1E', border: `1.5px solid ${colDriver2 === d.id ? (d.colour || '#1C1C1E') : '#DDD8CF'}` }}>{d.name}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Save button */}
            <button
              disabled={!!assigningId}
              onClick={() => saveAssignment(run)}
              style={{ width: '100%', padding: '11px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: assigningId ? 0.7 : 1 }}
            >
              {assigningId ? 'Saving…' : 'Save assignment'}
            </button>
          </div>

          {run.notes && (
            <>
              <hr style={S.divider} />
              <div style={S.sectionLabel}>Notes</div>
              <div style={{ background: '#F7F3EE', borderRadius: '6px', padding: '14px', fontSize: '13px', lineHeight: '1.6' }}>{run.notes}</div>
            </>
          )}

          <hr style={S.divider} />
          <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
            {run.crmsId
              ? 'Auto-generated from Current RMS. Driver assignments are stored in this platform only.'
              : 'Manual order created in this platform.'}
          </div>
          </>
          )}

          {tab === 'items' && <RunDetailItems run={run} />}
          {tab === 'changes' && <RunDetailChanges run={run} />}
          {tab === 'notes' && (
            <div>
              <JobNotes
                jobId={run.jobId}
                jobTable={run.crmsId ? 'crms_jobs' : 'orders'}
                crmsRef={run.ref}
                eventName={run.event}
              />
            </div>
          )}
          {tab === 'evidence' && run && (
            <div style={{ padding: '20px 24px' }}>
              <EvidenceUpload
                jobId={run.jobId}
                jobTable={run.crmsId ? 'crms_jobs' : 'orders'}
                crmsRef={run.ref}
                eventName={run.event}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── WEEK VIEW ─────────────────────────────────────────────────────────────────
function WeekView({ allRuns, weekOffset, setWeekOffset, onSelect }) {
  const now = new Date()
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + weekOffset * 7)
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i); return d
  })
  const weekLabel = `${weekDates[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${weekDates[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <button style={S.btnOutline} onClick={() => setWeekOffset(w => w - 1)}>← Prev</button>
        <span style={S.weekLabel}>{weekLabel}</span>
        <button style={S.btnOutline} onClick={() => setWeekOffset(0)}>Today</button>
        <button style={S.btnOutline} onClick={() => setWeekOffset(w => w + 1)}>Next →</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
        {weekDates.map((date, i) => {
          const ds = date.toLocaleDateString('en-CA')
          const runs = allRuns.filter(r => r.runDate === ds)
          const isToday = ds === today
          return (
            <div key={i}>
              <div style={{ background: isToday ? '#1C1C1E' : '#3D5A73', color: 'white', padding: '8px', borderRadius: '6px', textAlign: 'center', marginBottom: '8px', border: isToday ? '2px solid #B8965A' : 'none' }}>
                <div style={{ fontSize: '10px', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}</div>
                <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '24px', fontWeight: '300' }}>{date.getDate()}</div>
              </div>
              {runs.length === 0
                ? <div style={{ fontSize: '11px', color: '#D1D5DB', textAlign: 'center', padding: '8px' }}>—</div>
                : runs.map((run, j) => <MiniRunCard key={j} run={run} onClick={() => onSelect(run)} />)
              }
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── MONTH VIEW ────────────────────────────────────────────────────────────────
function MonthView({ allRuns, monthDate, setMonthDate, onSelect, dragRun, dragOverDate, setDragRun, setDragOverDate, saveDraggedDate, showToast, onReorder }) {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
  const first = new Date(year, month, 1)
  const last = new Date(year, month + 1, 0)
  const startDay = first.getDay() === 0 ? 6 : first.getDay() - 1
  const dates = []
  for (let i = 0; i < startDay; i++) dates.push(null)
  for (let d = 1; d <= last.getDate(); d++) dates.push(new Date(year, month, d))

  const monthRuns = allRuns.filter(r => {
    const d = new Date(r.runDate + 'T12:00:00')
    return d.getFullYear() === year && d.getMonth() === month
  }).sort((a, b) => a.runDate.localeCompare(b.runDate))

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <button style={S.btnOutline} onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() - 1))}>← Prev</button>
        <span style={S.weekLabel}>{MONTHS[month]} {year}</span>
        <button style={S.btnOutline} onClick={() => setMonthDate(new Date())}>Today</button>
        <button style={S.btnOutline} onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() + 1))}>Next →</button>
      </div>
      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', marginBottom: '24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', background: '#3D5A73' }}>
          {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
            <div key={d} style={{ color: 'white', textAlign: 'center', padding: '10px', fontSize: '11px', letterSpacing: '0.08em' }}>{d}</div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
          {dates.map((date, i) => {
            if (!date) return <div key={i} style={{ minHeight: '80px', borderRight: '1px solid #EDE8E0', borderBottom: '1px solid #EDE8E0' }} />
            const ds = date.toLocaleDateString('en-CA')
            const dayRuns = allRuns.filter(r => r.runDate === ds)
            const isToday = ds === today
            return (
              <div
                key={i}
                style={{
                  position: 'relative',
                  minHeight: '80px',
                  padding: '6px',
                  borderRight: '1px solid #EDE8E0',
                  borderBottom: '1px solid #EDE8E0',
                  background: dragOverDate === ds ? '#F0FDF4' : (isToday ? '#FFF8F0' : 'white'),
                  border: dragOverDate === ds ? '1.5px dashed #1D9E75' : 'none',
                }}
                onDragOver={(e) => { e.preventDefault(); setDragOverDate(ds) }}
                onDragLeave={() => setDragOverDate(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  if (!dragRun) return
                  if (dragRun.runDate === ds) {
                    // Same day — do nothing, use list view arrows instead
                    setDragRun(null)
                    setDragOverDate(null)
                    showToast('Use the List view to reorder runs on the same day')
                  } else {
                    saveDraggedDate(dragRun, ds)
                  }
                }}
              >
                <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '16px', fontWeight: isToday ? '700' : '400', color: isToday ? '#B8965A' : '#1C1C1E', marginBottom: '4px' }}>{date.getDate()}</div>
                {dayRuns.length >= 2 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onReorder(ds) }}
                    style={{
                      position: 'absolute', top: '4px', right: '4px',
                      background: 'rgba(184,150,90,0.15)', border: 'none',
                      borderRadius: '4px', padding: '2px 4px',
                      cursor: 'pointer', fontSize: '10px', color: '#B8965A',
                      fontWeight: '600', lineHeight: 1,
                    }}
                    title="Reorder runs"
                  >⇅</button>
                )}
                {dayRuns.map((run, j) => (
                  <MiniRunCard
                    key={j}
                    run={run}
                    onClick={() => onSelect(run)}
                    compact
                    draggable={true}
                    onDragStart={(e) => {
                      e.stopPropagation()
                      e.dataTransfer.effectAllowed = 'move'
                      setDragRun(run)
                    }}
                    onDragEnd={() => {
                      setDragRun(null)
                      setDragOverDate(null)
                    }}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
      <div style={S.sectionLabel}>All runs — {MONTHS[month]} {year}</div>
      {monthRuns.length === 0
        ? <div style={{ color: '#9CA3AF', fontSize: '13px', padding: '16px' }}>No runs scheduled this month</div>
        : (
          <div style={S.card}>
            <table style={S.table}>
              <thead><tr>{['D/C','Date','Time','Event / Client','Venue','Driver','Status',''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {monthRuns.map((run, i) => {
                  const colors = run.runType === 'DEL' ? { badge: '#EF4444' } : { badge: '#22C55E' }
                  return (
                    <tr key={i} style={{ cursor: 'pointer' }} onClick={() => onSelect(run)}>
                      <td style={S.td}><span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>{run.runType}</span></td>
                      <td style={S.td}>{fmt(run.runDate)}</td>
                      <td style={{ ...S.td, fontFamily: "'Cormorant Garamond', serif", fontSize: '15px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span>
                            {run.runTime || '—'}
                            {run.runType === 'DEL' && run.deliveryEndTime
                              ? ` - ${run.deliveryEndTime}`
                              : run.runType === 'COL' && run.collectionEndTime
                                ? ` - ${run.collectionEndTime}`
                                : ''}
                          </span>
                          {run.isTimed && (
                            <span style={{
                              background: '#FEF3C7',
                              color: '#854F0B',
                              fontSize: '9px',
                              fontWeight: '700',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              border: '1px solid #FDE68A',
                              whiteSpace: 'nowrap',
                            }}>⏱ TIMED</span>
                          )}
                        </div>
                      </td>
                      <td style={S.td}><div style={{ fontWeight: 500 }}>{run.event || run.client}</div><div style={{ fontSize: '11px', color: '#6B6860' }}>{run.client}</div></td>
                      <td style={{ ...S.td, fontSize: '12px', color: '#6B6860' }}>{run.venue || '—'}</td>
                      <td style={S.td}>
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          {run.driverName && (
                            <span style={{
                              background: run.driverColour || '#3D5A73',
                              color: 'white',
                              fontSize: '11px',
                              fontWeight: '600',
                              padding: '3px 10px',
                              borderRadius: '10px'
                            }}>{run.driverName}</span>
                          )}
                          {run.driverName2 && (
                            <span style={{
                              background: run.driverColour2 || '#5F5E5A',
                              color: 'white',
                              fontSize: '11px',
                              fontWeight: '600',
                              padding: '3px 10px',
                              borderRadius: '10px'
                            }}>{run.driverName2}</span>
                          )}
                          {!run.driverName && !run.driverName2 && (
                            <span style={{
                              background: '#FEF3C7',
                              color: '#92400E',
                              fontSize: '11px',
                              fontWeight: '500',
                              padding: '3px 10px',
                              borderRadius: '10px'
                            }}>Unassigned</span>
                          )}
                        </div>
                      </td>
                      <td style={S.td}><span style={{ background: '#ECFDF5', color: '#065F46', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', textTransform: 'capitalize' }}>{run.status}</span></td>
                      <td style={S.td}><button style={S.btnGhost}>View →</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      }
    </>
  )
}

// ── YEAR VIEW ─────────────────────────────────────────────────────────────────
function YearView({ allRuns, yearDate, setYearDate, setMonthDate, setView }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
        <button style={S.btnOutline} onClick={() => setYearDate(d => new Date(d.getFullYear() - 1, 0))}>← {yearDate.getFullYear() - 1}</button>
        <span style={S.weekLabel}>{yearDate.getFullYear()}</span>
        <button style={S.btnOutline} onClick={() => setYearDate(new Date())}>This Year</button>
        <button style={S.btnOutline} onClick={() => setYearDate(d => new Date(d.getFullYear() + 1, 0))}>{yearDate.getFullYear() + 1} →</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
        {MONTHS.map((monthName, monthIdx) => {
          const monthRuns = allRuns.filter(r => { const d = new Date(r.runDate + 'T12:00:00'); return d.getFullYear() === yearDate.getFullYear() && d.getMonth() === monthIdx })
          const delCount = monthRuns.filter(r => r.runType === 'DEL').length
          const colCount = monthRuns.filter(r => r.runType === 'COL').length
          const isCurrentMonth = new Date().getFullYear() === yearDate.getFullYear() && new Date().getMonth() === monthIdx
          const first = new Date(yearDate.getFullYear(), monthIdx, 1)
          const last = new Date(yearDate.getFullYear(), monthIdx + 1, 0)
          const startDay = first.getDay() === 0 ? 6 : first.getDay() - 1
          const calDates = []
          for (let i = 0; i < startDay; i++) calDates.push(null)
          for (let d = 1; d <= last.getDate(); d++) calDates.push(new Date(yearDate.getFullYear(), monthIdx, d))
          return (
            <div key={monthIdx} style={{ background: '#fff', border: `1.5px solid ${isCurrentMonth ? '#B8965A' : '#DDD8CF'}`, borderRadius: '8px', overflow: 'hidden' }}>
              <div style={{ background: isCurrentMonth ? '#1C1C1E' : '#3D5A73', color: 'white', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                onClick={() => { setMonthDate(new Date(yearDate.getFullYear(), monthIdx)); setView('month') }}>
                <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '16px', fontWeight: '600' }}>{monthName}</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {delCount > 0 && <span style={{ background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' }}>{delCount} DEL</span>}
                  {colCount > 0 && <span style={{ background: '#22C55E', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' }}>{colCount} COL</span>}
                </div>
              </div>
              <div style={{ padding: '8px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: '4px' }}>
                  {['M','T','W','T','F','S','S'].map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: '9px', color: '#9CA3AF' }}>{d}</div>)}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '1px' }}>
                  {calDates.map((date, i) => {
                    if (!date) return <div key={i} />
                    const ds = date.toLocaleDateString('en-CA')
                    const dayRuns = allRuns.filter(r => r.runDate === ds)
                    const hasDel = dayRuns.some(r => r.runType === 'DEL')
                    const hasCol = dayRuns.some(r => r.runType === 'COL')
                    const isToday = ds === today
                    return (
                      <div key={i} style={{ textAlign: 'center', padding: '2px 1px', borderRadius: '3px', cursor: dayRuns.length > 0 ? 'pointer' : 'default', background: isToday ? '#FFF8F0' : 'transparent', border: isToday ? '1px solid #B8965A' : '1px solid transparent' }}
                        onClick={() => dayRuns.length > 0 && (setMonthDate(new Date(yearDate.getFullYear(), monthIdx)), setView('month'))}>
                        <div style={{ fontSize: '10px', color: isToday ? '#B8965A' : '#1C1C1E', fontWeight: isToday ? '700' : '400' }}>{date.getDate()}</div>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '1px', marginTop: '1px' }}>
                          {hasDel && <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#EF4444' }} />}
                          {hasCol && <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#22C55E' }} />}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
              {monthRuns.length > 0 && (
                <div style={{ borderTop: '1px solid #EDE8E0', padding: '8px' }}>
                  {monthRuns.slice(0, 3).map((run, j) => (
                    <div key={j} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '11px' }}>
                      <span style={{ background: run.runType === 'DEL' ? '#EF4444' : '#22C55E', color: 'white', fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '2px' }}>{run.runType}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.event || run.client}</span>
                      <span style={{ color: '#9CA3AF', flexShrink: 0 }}>{new Date(run.runDate + 'T12:00:00').getDate()}</span>
                    </div>
                  ))}
                  {monthRuns.length > 3 && <div style={{ fontSize: '10px', color: '#9CA3AF', textAlign: 'center', paddingTop: '4px', cursor: 'pointer' }} onClick={() => { setMonthDate(new Date(yearDate.getFullYear(), monthIdx)); setView('month') }}>+{monthRuns.length - 3} more →</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── MINI RUN CARD ─────────────────────────────────────────────────────────────
function MiniRunCard({ run, onClick, compact = false, draggable = false, onDragStart, onDragEnd }) {
  const colors = run.runType === 'DEL'
    ? { bg: '#FEF2F2', border: '#EF4444', text: '#991B1B', badge: '#EF4444' }
    : { bg: '#F0FDF4', border: '#22C55E', text: '#166534', badge: '#22C55E' }
  const dragStyle = draggable ? { cursor: 'grab', userSelect: 'none' } : { cursor: 'pointer' }
  if (compact) return (
    <div
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onClick={onClick}
      style={{ background: colors.bg, border: `1.5px solid ${colors.border}`, borderRadius: '3px', padding: '2px 5px', marginBottom: '2px', fontSize: '10px', ...dragStyle }}
    >
      <div>
        <span style={{ background: colors.badge, color: 'white', fontSize: '8px', fontWeight: '700', padding: '1px 3px', borderRadius: '2px', marginRight: '3px' }}>{run.runType}</span>
        <span style={{ color: colors.text, fontWeight: '600' }}>{run.event || run.client}</span>
      </div>
      {(run.runTime || run.deliveryEndTime || run.collectionEndTime || run.isTimed) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginTop: '3px' }}>
          <span style={{ fontSize: '9px', color: '#6B6860' }}>
            {run.runTime || '—'}
            {run.runType === 'DEL' && run.deliveryEndTime
              ? ` - ${run.deliveryEndTime}`
              : run.runType === 'COL' && run.collectionEndTime
                ? ` - ${run.collectionEndTime}`
                : ''}
          </span>
          {run.isTimed && (
            <span style={{
              background: '#FEF3C7',
              color: '#854F0B',
              fontSize: '8px',
              fontWeight: '700',
              padding: '1px 4px',
              borderRadius: '3px',
              border: '1px solid #FDE68A',
              whiteSpace: 'nowrap',
            }}>⏱ TIMED</span>
          )}
        </div>
      )}
      {(run.driverName || run.driverName2) && (
        <div style={{ marginTop: '4px' }}>
          <span style={{
            background: run.driverColour || '#3D5A73',
            color: 'white',
            fontSize: '9px',
            fontWeight: '600',
            padding: '1px 6px',
            borderRadius: '8px'
          }}>
            {run.driverName ? run.driverName[0] : ''}
            {run.driverName2 ? `+${run.driverName2[0]}` : ''}
          </span>
        </div>
      )}
    </div>
  )
  return (
    <div
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onClick={onClick}
      style={{ background: colors.bg, border: `1.5px solid ${colors.border}`, borderRadius: '5px', padding: '7px 9px', marginBottom: '5px', ...dragStyle }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '3px' }}>
        <span style={{ background: colors.badge, color: 'white', fontSize: '9px', fontWeight: '700', padding: '2px 5px', borderRadius: '2px' }}>{run.runType}</span>
        <span style={{ fontSize: '11.5px', fontWeight: '600', color: colors.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.event || run.client}</span>
      </div>
      {run.runTime && <div style={{ fontSize: '10px', color: '#6B6860' }}>🕐 {run.runTime.substring(0, 5)}</div>}
      {(run.driverName || run.driverName2) && (
        <div style={{ marginTop: '4px', display: 'flex', gap: '4px' }}>
          {run.driverName && (
            <span style={{
              background: run.driverColour || '#3D5A73',
              color: 'white',
              fontSize: '9px',
              fontWeight: '600',
              padding: '1px 6px',
              borderRadius: '8px'
            }}>{run.driverName}</span>
          )}
          {run.driverName2 && (
            <span style={{
              background: run.driverColour2 || '#5F5E5A',
              color: 'white',
              fontSize: '9px',
              fontWeight: '600',
              padding: '1px 6px',
              borderRadius: '8px'
            }}>{run.driverName2}</span>
          )}
        </div>
      )}
      {run.isUrgent && <div style={{ fontSize: '9px', background: '#EF4444', color: 'white', padding: '1px 4px', borderRadius: '2px', display: 'inline-block', marginTop: '3px' }}>URGENT</div>}
    </div>
  )
}

// ── STYLES ────────────────────────────────────────────────────────────────────
const S = {
  syncBar:       { background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '6px', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' },
  statsRow:      { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px', marginBottom: '20px' },
  statCard:      { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '14px 16px', boxShadow: '0 2px 8px rgba(28,28,30,0.04)' },
  sectionLabel:  { fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B8965A', fontWeight: '600', marginBottom: '12px' },
  btnOutline:    { background: 'transparent', color: '#1C1C1E', border: '1.5px solid #DDD8CF', borderRadius: '4px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnActive:     { background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  btnGhost:      { background: 'transparent', color: '#B8965A', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' },
  filterBtn:     { padding: '6px 12px', borderRadius: '20px', border: '1.5px solid #DDD8CF', background: 'transparent', color: '#6B6860', fontSize: '11px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  filterBtnActive:{ background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  select:        { fontFamily: "'DM Sans', sans-serif", fontSize: '13px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  searchInput:   { width: '100%', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', boxSizing: 'border-box' },
  weekLabel:     { fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600', padding: '0 12px' },
  card:          { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(28,28,30,0.08)' },
  table:         { width: '100%', borderCollapse: 'collapse' },
  th:            { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '10px 16px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500', whiteSpace: 'nowrap' },
  td:            { padding: '12px 16px', fontSize: '13px', borderBottom: '1px solid #EDE8E0', verticalAlign: 'middle' },
  overlay:       { position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
  panel:         { background: '#fff', width: '100%', maxWidth: '600px', height: '100vh', display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 48px rgba(28,28,30,0.14)' },
  panelHeader:   { padding: '24px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: '#F7F3EE', flexShrink: 0 },
  closeBtn:      { background: '#DDD8CF', border: 'none', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '14px', color: '#1C1C1E', flexShrink: 0 },
  divider:       { border: 'none', borderTop: '1px solid #DDD8CF', margin: '20px 0' },
  driverBtn:     { padding: '8px 16px', border: '1.5px solid #DDD8CF', borderRadius: '20px', background: 'transparent', color: '#1C1C1E', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' },
  assignBtn:     { padding: '5px 10px', border: '1.5px solid #DDD8CF', borderRadius: '12px', background: 'transparent', color: '#6B6860', fontSize: '11px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  tabBtn:        { padding: '6px 12px', borderRadius: '6px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', fontSize: '12px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  tabBtnActive:  { background: '#1C1C1E', color: '#fff', borderColor: '#1C1C1E' },
}

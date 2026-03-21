import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const today    = new Date().toISOString().split('T')[0]
const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

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
  return { from: mon.toISOString().split('T')[0], to: sun.toISOString().split('T')[0] }
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
    const base = {
      job,
      client:             job.client_name,
      event:              job.event_name,
      venue:              job.venue,
      ref:                job.crms_ref || job.ref,
      jobId:              job.id,
      crmsId:             job.crms_id,
      status:             job.status,
      isAmended:          job.is_amended,
      isUrgent:           job.is_urgent,
      notes:              job.notes,
      driverName:         job.assigned_driver_name || null,
      driverColour:       null,   // filled below from drivers list
      assignedDriverId:   job.assigned_driver_id   || null,
    }
    if (job.delivery_date) runs.push({ ...base, id: `${job.id}-DEL`, runType: 'DEL', runDate: job.delivery_date, runTime: job.delivery_time, missingTime: !job.delivery_time })
    if (job.collection_date) runs.push({ ...base, id: `${job.id}-COL`, runType: 'COL', runDate: job.collection_date, runTime: job.collection_time, missingTime: !job.collection_time })
  }
  return runs.sort((a, b) => {
    const d = (a.runDate || '').localeCompare(b.runDate || '')
    return d !== 0 ? d : (a.runTime || '99:99').localeCompare(b.runTime || '99:99')
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
  const [assigningDriver1, setAssigningDriver1] = useState(null)
  const [assigningDriver2, setAssigningDriver2] = useState(null)
  const [driver1Runs, setDriver1Runs]           = useState('both')
  const [driver2Runs, setDriver2Runs]           = useState('both')

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    fetchJobs()
    fetchDrivers()
    fetchLastSync()
    const channel = supabase.channel('schedule-crms')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crms_jobs' }, fetchJobs)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },    fetchJobs)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

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
    setJobs([...crmsJobs, ...manualJobs])
    setLoading(false)
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
    if (!assigningDriver1) return
    setAssigning(run.id)
    try {
      const isSelfCollection = assigningDriver1 === 'self_collection'
      const driver1 = isSelfCollection ? null : drivers.find(d => d.id === assigningDriver1)
      const driver2 = assigningDriver2 ? drivers.find(d => d.id === assigningDriver2) : null
      const table = run.crmsId ? 'crms_jobs' : 'orders'

      await supabase.from(table).update({
        assigned_driver_id:     isSelfCollection ? null : driver1?.id || null,
        assigned_driver_name:   isSelfCollection ? 'Self Collection' : driver1?.name || null,
        assigned_driver_id_2:   driver2?.id || null,
        assigned_driver_name_2: driver2?.name || null,
        driver_1_runs:          isSelfCollection ? 'col' : driver1Runs,
        driver_2_runs:          driver2 ? driver2Runs : null,
      }).eq('id', run.jobId)

      showToast('Assignment saved')
      setAssigningDriver1(null)
      setAssigningDriver2(null)
      setDriver1Runs('both')
      setDriver2Runs('both')
      fetchJobs()
    } catch (e) {
      showToast('Error saving', 'error')
    }
    setAssigning(null)
  }

  // ── Build run list enriched with driver colour ─────────────────────────────
  const driverMap = drivers.reduce((m, d) => ({ ...m, [d.id]: d }), {})
  const allRuns = buildRuns(jobs).map(r => ({
    ...r,
    driverColour: r.assignedDriverId ? (driverMap[r.assignedDriverId]?.colour || '#3D5A73') : null,
  }))

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
        />
      )}

      {/* ── DISPATCH VIEW ── */}
      {view === 'dispatch' && (
        <DispatchView allRuns={allRuns} drivers={drivers} today={today} tomorrow={tomorrow} onSelect={setSelectedRun} onAssign={assignDriver} assigningId={assigningId} />
      )}

      {/* ── WEEK VIEW ── */}
      {view === 'week' && <WeekView allRuns={allRuns} weekOffset={weekOffset} setWeekOffset={setWeekOffset} onSelect={setSelectedRun} />}

      {/* ── MONTH VIEW ── */}
      {view === 'month' && <MonthView allRuns={allRuns} monthDate={monthDate} setMonthDate={setMonthDate} onSelect={setSelectedRun} />}

      {/* ── YEAR VIEW ── */}
      {view === 'year' && <YearView allRuns={allRuns} yearDate={yearDate} setYearDate={setYearDate} setMonthDate={setMonthDate} setView={setView} />}

      {/* Run detail panel */}
      {selectedRun && (
        <RunDetailPanel
          run={selectedRun}
          drivers={drivers}
          assigningId={assigningId}
          onClose={() => setSelectedRun(null)}
          assigningDriver1={assigningDriver1}
          setAssigningDriver1={setAssigningDriver1}
          assigningDriver2={assigningDriver2}
          setAssigningDriver2={setAssigningDriver2}
          driver1Runs={driver1Runs}
          setDriver1Runs={setDriver1Runs}
          driver2Runs={driver2Runs}
          setDriver2Runs={setDriver2Runs}
          saveAssignment={saveAssignment}
        />
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
function ListView({ filteredRuns, allRuns, groupByDriver, setGroup, drivers, onSelect, today, tomorrow }) {
  if (filteredRuns.length === 0) return (
    <div style={{ textAlign: 'center', padding: '48px', color: '#9CA3AF', fontSize: '14px' }}>
      No schedule entries for this filter
    </div>
  )

  const grouped = filteredRuns.reduce((acc, r) => {
    const k = r.runDate || 'No Date'
    if (!acc[k]) acc[k] = []
    acc[k].push(r)
    return acc
  }, {})

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
        <button style={{ ...S.filterBtn, ...(groupByDriver ? S.filterBtnActive : {}) }} onClick={() => setGroup(g => !g)}>
          👤 Group by Driver
        </button>
      </div>
      {groupByDriver
        ? <GroupedByDriverView runs={filteredRuns} drivers={drivers} onSelect={onSelect} />
        : Object.entries(grouped).map(([date, runs]) => (
          <DateGroup key={date} date={date} runs={runs} onSelect={onSelect} today={today} tomorrow={tomorrow} />
        ))
      }
    </div>
  )
}

function DateGroup({ date, runs, onSelect, today, tomorrow }) {
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
            <tr>{['D/C','Time','Event / Client','Venue','Driver','Ref','Status',''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {runs.map((run, i) => <RunRow key={i} run={run} onSelect={onSelect} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RunRow({ run, onSelect }) {
  const colors = run.runType === 'DEL'
    ? { badge: '#EF4444' }
    : { badge: '#22C55E' }
  return (
    <tr style={{ background: run.isUrgent ? '#FFF5F5' : run.missingTime ? '#FFFBEB' : 'white', cursor: 'pointer' }}
      onClick={() => onSelect(run)}>
      <td style={S.td}>
        <span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>{run.runType}</span>
      </td>
      <td style={{ ...S.td, fontWeight: '600', fontFamily: "'Cormorant Garamond', serif", fontSize: '16px', color: run.missingTime ? '#9CA3AF' : '#1C1C1E' }}>
        {run.runTime || <span style={{ fontSize: '11px', color: '#F59E0B' }}>⚠ No time</span>}
      </td>
      <td style={S.td}>
        <div style={{ fontWeight: 500 }}>{run.event || run.client}</div>
        <div style={{ fontSize: '11.5px', color: '#6B6860' }}>{run.client}</div>
      </td>
      <td style={{ ...S.td, fontSize: '12px', color: '#6B6860', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.venue || '—'}</td>
      <td style={S.td}>
        {run.driverName
          ? <span style={{ background: run.driverColour || '#3D5A73', color: 'white', padding: '3px 10px', borderRadius: '12px', fontSize: '11.5px', fontWeight: '600' }}>{run.driverName}</span>
          : <span style={{ color: '#D1D5DB', fontSize: '12px' }}>—</span>}
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
                        <td style={S.td}><span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>{run.runType}</span></td>
                        <td style={S.td}>{fmt(run.runDate)}</td>
                        <td style={{ ...S.td, fontFamily: "'Cormorant Garamond', serif", fontSize: '15px' }}>{run.runTime || <span style={{ fontSize: '11px', color: '#F59E0B' }}>⚠ No time</span>}</td>
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
    return d.toISOString().split('T')[0]
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
        {run.runTime && <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '16px', fontWeight: '600', color: colors.text }}>{run.runTime}</span>}
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

// ── RUN DETAIL PANEL ──────────────────────────────────────────────────────────
function RunDetailPanel({
  run,
  drivers,
  onClose,
  assigningId,
  assigningDriver1,
  setAssigningDriver1,
  assigningDriver2,
  setAssigningDriver2,
  driver1Runs,
  setDriver1Runs,
  driver2Runs,
  setDriver2Runs,
  saveAssignment,
}) {
  const isSaving = assigningId === run.id
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

          {/* Details grid */}
          <div style={S.sectionLabel}>{run.runType === 'DEL' ? 'Delivery' : 'Collection'} Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            {[
              ['Date',      fmt(run.runDate)],
              ['Time',      run.runTime || '⚠ Not set'],
              ['Client',    run.client],
              ['Venue',     run.venue || '—'],
              ['Status',    run.status],
              ['Reference', run.ref],
            ].map(([label, value]) => (
              <div key={label} style={{ background: '#F7F3EE', borderRadius: '6px', padding: '12px' }}>
                <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '4px' }}>{label}</div>
                <div style={{ fontSize: '13.5px', fontWeight: '500', color: '#1C1C1E', textTransform: 'capitalize' }}>{value}</div>
              </div>
            ))}
          </div>

          <hr style={S.divider} />

          {/* ── DRIVER ASSIGNMENT ── */}
          <div style={{ marginTop: '8px' }}>
            <div style={S.sectionLabel}>Driver Assignment</div>

            {/* Driver 1 */}
            <div style={{ border: '1px solid #DDD8CF', borderRadius: '8px', padding: '12px 14px', marginBottom: '10px' }}>
              <div style={{ fontSize: '11px', fontWeight: '500', color: '#6B6860', marginBottom: '10px' }}>
                Driver 1 — required
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                {drivers.map(d => (
                  <button
                    key={d.id}
                    type="button"
                    style={{
                      fontSize: '12px', fontWeight: '500', padding: '6px 14px',
                      borderRadius: '20px', cursor: 'pointer',
                      fontFamily: "'DM Sans', sans-serif",
                      background: assigningDriver1 === d.id ? (d.colour || '#1C1C1E') : 'transparent',
                      color: assigningDriver1 === d.id ? '#fff' : '#1C1C1E',
                      border: `1.5px solid ${assigningDriver1 === d.id ? (d.colour || '#1C1C1E') : '#DDD8CF'}`,
                    }}
                    onClick={() => setAssigningDriver1(d.id)}
                  >
                    {d.name}
                  </button>
                ))}
                {/* Self Collection */}
                <button
                  type="button"
                  style={{
                    fontSize: '12px', fontWeight: '500', padding: '6px 14px',
                    borderRadius: '20px', cursor: 'pointer',
                    fontFamily: "'DM Sans', sans-serif",
                    background: assigningDriver1 === 'self_collection' ? '#F1F5F9' : 'transparent',
                    color: assigningDriver1 === 'self_collection' ? '#475569' : '#6B6860',
                    border: `1.5px solid ${assigningDriver1 === 'self_collection' ? '#94A3B8' : '#DDD8CF'}`,
                  }}
                  onClick={() => { setAssigningDriver1('self_collection'); setAssigningDriver2(null); setDriver2Runs('both') }}
                >
                  Self Collection
                </button>
              </div>
              {/* Run type for driver 1 */}
              {assigningDriver1 && assigningDriver1 !== 'self_collection' && (
                <div style={{ display: 'flex', gap: '6px' }}>
                  {[['both','DEL + COL'],['del','DEL only'],['col','COL only']].map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setDriver1Runs(val)}
                      style={{
                        fontSize: '11px', fontWeight: '500', padding: '4px 12px',
                        borderRadius: '4px', cursor: 'pointer',
                        fontFamily: "'DM Sans', sans-serif",
                        background: driver1Runs === val ? '#1C1C1E' : 'transparent',
                        color: driver1Runs === val ? '#fff' : '#6B6860',
                        border: `1px solid ${driver1Runs === val ? '#1C1C1E' : '#DDD8CF'}`,
                      }}
                    >{label}</button>
                  ))}
                </div>
              )}
            </div>

            {/* Driver 2 — only if not Self Collection */}
            {assigningDriver1 !== 'self_collection' && (
              <div style={{ border: '1px solid #DDD8CF', borderRadius: '8px', padding: '12px 14px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: '500', color: '#6B6860', marginBottom: '10px' }}>
                  Driver 2 — optional
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <button
                    type="button"
                    style={{
                      fontSize: '12px', padding: '6px 14px', borderRadius: '20px',
                      cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                      background: !assigningDriver2 ? '#F7F3EE' : 'transparent',
                      color: !assigningDriver2 ? '#B8965A' : '#6B6860',
                      border: `1.5px dashed ${!assigningDriver2 ? '#B8965A' : '#DDD8CF'}`,
                    }}
                    onClick={() => setAssigningDriver2(null)}
                  >None</button>
                  {drivers.filter(d => d.id !== assigningDriver1).map(d => (
                    <button
                      key={d.id}
                      type="button"
                      style={{
                        fontSize: '12px', fontWeight: '500', padding: '6px 14px',
                        borderRadius: '20px', cursor: 'pointer',
                        fontFamily: "'DM Sans', sans-serif",
                        background: assigningDriver2 === d.id ? (d.colour || '#1C1C1E') : 'transparent',
                        color: assigningDriver2 === d.id ? '#fff' : '#1C1C1E',
                        border: `1.5px solid ${assigningDriver2 === d.id ? (d.colour || '#1C1C1E') : '#DDD8CF'}`,
                      }}
                      onClick={() => setAssigningDriver2(d.id)}
                    >{d.name}</button>
                  ))}
                </div>
                {assigningDriver2 && (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {[['both','DEL + COL'],['del','DEL only'],['col','COL only']].map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setDriver2Runs(val)}
                        style={{
                          fontSize: '11px', fontWeight: '500', padding: '4px 12px',
                          borderRadius: '4px', cursor: 'pointer',
                          fontFamily: "'DM Sans', sans-serif",
                          background: driver2Runs === val ? '#1C1C1E' : 'transparent',
                          color: driver2Runs === val ? '#fff' : '#6B6860',
                          border: `1px solid ${driver2Runs === val ? '#1C1C1E' : '#DDD8CF'}`,
                        }}
                      >{label}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Preview */}
            {assigningDriver1 && (
              <div style={{ background: '#F7F3EE', borderRadius: '8px', padding: '12px 14px', marginBottom: '12px' }}>
                <div style={{ fontSize: '10px', fontWeight: '500', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '8px' }}>Preview</div>
                {['del','col'].map(type => {
                  const d1Shows = assigningDriver1 === 'self_collection'
                    ? type === 'col'
                    : driver1Runs === 'both' || driver1Runs === type
                  const d2Shows = assigningDriver2 && (driver2Runs === 'both' || driver2Runs === type)
                  if (!d1Shows && !d2Shows) return null
                  const driver1Preview = assigningDriver1 === 'self_collection'
                    ? { name: 'Self Collection', colour: '#94A3B8' }
                    : drivers.find(d => d.id === assigningDriver1)
                  const driver2Preview = drivers.find(d => d.id === assigningDriver2)
                  return (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                      <span style={{
                        fontSize: '10px', fontWeight: '600', padding: '2px 7px', borderRadius: '4px',
                        background: type === 'del' ? '#FCEBEB' : '#EAF3DE',
                        color: type === 'del' ? '#A32D2D' : '#3B6D11',
                      }}>{type.toUpperCase()}</span>
                      {d1Shows && driver1Preview && (
                        <span style={{ fontSize: '11px', fontWeight: '500', padding: '3px 10px', borderRadius: '10px', background: driver1Preview.colour || '#1C1C1E', color: '#fff' }}>
                          {driver1Preview.name}
                        </span>
                      )}
                      {d2Shows && driver2Preview && (
                        <span style={{ fontSize: '11px', fontWeight: '500', padding: '3px 10px', borderRadius: '10px', background: driver2Preview.colour || '#1C1C1E', color: '#fff' }}>
                          {driver2Preview.name}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Save button */}
            <button
              type="button"
              style={{ width: '100%', padding: '11px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: isSaving ? 0.7 : 1 }}
              disabled={isSaving || !assigningDriver1}
              onClick={() => saveAssignment(run)}
            >
              {isSaving ? 'Saving…' : 'Save assignment'}
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
          const ds = date.toISOString().split('T')[0]
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
function MonthView({ allRuns, monthDate, setMonthDate, onSelect }) {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
  const first = new Date(year, month, 1)
  const last = new Date(year, month + 1, 0)
  const startDay = first.getDay() === 0 ? 6 : first.getDay() - 1
  const dates = []
  for (let i = 0; i < startDay; i++) dates.push(null)
  for (let d = 1; d <= last.getDate(); d++) dates.push(new Date(year, month, d))

  const monthRuns = allRuns.filter(r => {
    const d = new Date(r.runDate)
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
            const ds = date.toISOString().split('T')[0]
            const dayRuns = allRuns.filter(r => r.runDate === ds)
            const isToday = ds === today
            return (
              <div key={i} style={{ minHeight: '80px', padding: '6px', borderRight: '1px solid #EDE8E0', borderBottom: '1px solid #EDE8E0', background: isToday ? '#FFF8F0' : 'white' }}>
                <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '16px', fontWeight: isToday ? '700' : '400', color: isToday ? '#B8965A' : '#1C1C1E', marginBottom: '4px' }}>{date.getDate()}</div>
                {dayRuns.map((run, j) => <MiniRunCard key={j} run={run} onClick={() => onSelect(run)} compact />)}
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
                      <td style={{ ...S.td, fontFamily: "'Cormorant Garamond', serif", fontSize: '15px' }}>{run.runTime || <span style={{ fontSize: '11px', color: '#F59E0B' }}>⚠ No time</span>}</td>
                      <td style={S.td}><div style={{ fontWeight: 500 }}>{run.event || run.client}</div><div style={{ fontSize: '11px', color: '#6B6860' }}>{run.client}</div></td>
                      <td style={{ ...S.td, fontSize: '12px', color: '#6B6860' }}>{run.venue || '—'}</td>
                      <td style={S.td}>
                        {run.driverName
                          ? <span style={{ background: run.driverColour || '#3D5A73', color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>{run.driverName}</span>
                          : <span style={{ color: '#D1D5DB', fontSize: '11px' }}>—</span>}
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
          const monthRuns = allRuns.filter(r => { const d = new Date(r.runDate); return d.getFullYear() === yearDate.getFullYear() && d.getMonth() === monthIdx })
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
                    const ds = date.toISOString().split('T')[0]
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
function MiniRunCard({ run, onClick, compact = false }) {
  const colors = run.runType === 'DEL'
    ? { bg: '#FEF2F2', border: '#EF4444', text: '#991B1B', badge: '#EF4444' }
    : { bg: '#F0FDF4', border: '#22C55E', text: '#166534', badge: '#22C55E' }
  if (compact) return (
    <div onClick={onClick} style={{ background: colors.bg, border: `1.5px solid ${colors.border}`, borderRadius: '3px', padding: '2px 5px', marginBottom: '2px', cursor: 'pointer', fontSize: '10px' }}>
      <span style={{ background: colors.badge, color: 'white', fontSize: '8px', fontWeight: '700', padding: '1px 3px', borderRadius: '2px', marginRight: '3px' }}>{run.runType}</span>
      <span style={{ color: colors.text, fontWeight: '600' }}>{run.event || run.client}</span>
      {run.driverName && <span style={{ background: run.driverColour || '#3D5A73', color: 'white', fontSize: '8px', fontWeight: '600', padding: '0px 4px', borderRadius: '6px', marginLeft: '3px' }}>{run.driverName[0]}</span>}
    </div>
  )
  return (
    <div onClick={onClick} style={{ background: colors.bg, border: `1.5px solid ${colors.border}`, borderRadius: '5px', padding: '7px 9px', marginBottom: '5px', cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '3px' }}>
        <span style={{ background: colors.badge, color: 'white', fontSize: '9px', fontWeight: '700', padding: '2px 5px', borderRadius: '2px' }}>{run.runType}</span>
        <span style={{ fontSize: '11.5px', fontWeight: '600', color: colors.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.event || run.client}</span>
      </div>
      {run.runTime && <div style={{ fontSize: '10px', color: '#6B6860' }}>🕐 {run.runTime}</div>}
      {run.driverName && (
        <div style={{ marginTop: '4px' }}>
          <span style={{ background: run.driverColour || '#3D5A73', color: 'white', fontSize: '9px', fontWeight: '600', padding: '1px 6px', borderRadius: '8px' }}>{run.driverName}</span>
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
}

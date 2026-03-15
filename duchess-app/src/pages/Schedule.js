import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const today = new Date().toISOString().split('T')[0]
const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

function fmt(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function getWeekRange() {
  const now = new Date()
  const day = now.getDay()
  const mon = new Date(now)
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  const sun = new Date(mon)
  sun.setDate(mon.getDate() + 6)
  return { from: mon.toISOString().split('T')[0], to: sun.toISOString().split('T')[0] }
}

function buildRuns(jobs) {
  const runs = []
  for (const job of jobs) {
    if (job.status === 'cancelled') continue
    if (job.delivery_date) {
      runs.push({
        id: `${job.crms_id}-DEL`,
        job,
        runType: 'DEL',
        runDate: job.delivery_date,
        runTime: job.delivery_time,
        client: job.client_name,
        event: job.event_name,
        venue: job.venue,
        ref: job.crms_ref,
        status: job.status,
        isAmended: job.is_amended,
        isUrgent: job.is_urgent,
        notes: job.notes,
        missingTime: !job.delivery_time,
      })
    }
    if (job.collection_date) {
      runs.push({
        id: `${job.crms_id}-COL`,
        job,
        runType: 'COL',
        runDate: job.collection_date,
        runTime: job.collection_time,
        client: job.client_name,
        event: job.event_name,
        venue: job.venue,
        ref: job.crms_ref,
        status: job.status,
        isAmended: job.is_amended,
        isUrgent: job.is_urgent,
        notes: job.notes,
        missingTime: !job.collection_time,
      })
    }
  }
  // Sort by date then time (earliest first)
  return runs.sort((a, b) => {
    const dateComp = (a.runDate || '').localeCompare(b.runDate || '')
    if (dateComp !== 0) return dateComp
    return (a.runTime || '99:99').localeCompare(b.runTime || '99:99')
  })
}

function applyFilter(runs, filter) {
  const { week } = getWeekRange()
  switch (filter) {
    case 'today':      return runs.filter(r => r.runDate === today)
    case 'tomorrow':   return runs.filter(r => r.runDate === tomorrow)
    case 'week':       return runs.filter(r => { const { from, to } = getWeekRange(); return r.runDate >= from && r.runDate <= to })
    case 'deliveries': return runs.filter(r => r.runType === 'DEL')
    case 'collections':return runs.filter(r => r.runType === 'COL')
    case 'amended':    return runs.filter(r => r.isAmended)
    case 'urgent':     return runs.filter(r => r.isUrgent)
    case 'missing':    return runs.filter(r => r.missingTime)
    default:           return runs
  }
}

export default function Schedule() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('list') // list | week | month | year
  const [filter, setFilter] = useState('today')
  const [search, setSearch] = useState('')
  const [selectedRun, setSelectedRun] = useState(null)
  const [syncInfo, setSyncInfo] = useState(null)
  const [monthDate, setMonthDate] = useState(new Date())
  const [yearDate, setYearDate] = useState(new Date())
  const [weekOffset, setWeekOffset] = useState(0)

  useEffect(() => {
    fetchJobs()
    fetchLastSync()
    const channel = supabase.channel('schedule-crms')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crms_jobs' }, fetchJobs)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function fetchJobs() {
    const { data } = await supabase
      .from('crms_jobs')
      .select('*')
      .order('delivery_date', { ascending: true, nullsLast: true })
    if (data) setJobs(data)
    setLoading(false)
  }

  async function fetchLastSync() {
    const { data } = await supabase
      .from('sync_runs')
      .select('completed_at, status, jobs_fetched')
      .order('started_at', { ascending: false })
      .limit(1)
      .single()
    if (data) setSyncInfo(data)
  }

  const allRuns = buildRuns(jobs)
  const filteredRuns = applyFilter(
    allRuns.filter(r =>
      !search || [r.client, r.event, r.venue, r.ref].some(f => f?.toLowerCase().includes(search.toLowerCase()))
    ),
    filter
  )

  const todayCount     = allRuns.filter(r => r.runDate === today).length
  const tomorrowCount  = allRuns.filter(r => r.runDate === tomorrow).length
  const urgentCount    = allRuns.filter(r => r.isUrgent).length
  const amendedCount   = allRuns.filter(r => r.isAmended).length
  const missingCount   = allRuns.filter(r => r.missingTime).length

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading live schedule…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Sync status */}
      <div style={styles.syncBar}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#6B6860' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22C55E', display: 'inline-block' }} />
          Schedule auto-generated from Live Jobs — syncs every 5 minutes
        </span>
        {syncInfo && (
          <span style={{ fontSize: '11px', color: '#9CA3AF' }}>
            Last sync: {new Date(syncInfo.completed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · {syncInfo.jobs_fetched} jobs from Current RMS
          </span>
        )}
      </div>

      {/* Stats row */}
      <div style={styles.statsRow}>
        {[
          { label: "Today", value: todayCount, filter: 'today', color: '#B8965A' },
          { label: "Tomorrow", value: tomorrowCount, filter: 'tomorrow', color: '#3D5A73' },
          { label: "Urgent", value: urgentCount, filter: 'urgent', color: '#EF4444' },
          { label: "Amended", value: amendedCount, filter: 'amended', color: '#F59E0B' },
          { label: "Missing Time", value: missingCount, filter: 'missing', color: '#9CA3AF' },
        ].map(s => (
          <div key={s.label} style={{ ...styles.statCard, borderTop: `3px solid ${s.color}`, cursor: 'pointer' }} onClick={() => { setFilter(s.filter); setView('list') }}>
            <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '28px', fontWeight: '600', color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* View + filter controls */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        {[['list','☰ List'],['week','📅 Week'],['month','🗓 Month'],['year','📆 Year']].map(([v, label]) => (
          <button key={v} style={{ ...styles.btnOutline, ...(view === v ? styles.btnActive : {}) }} onClick={() => setView(v)}>{label}</button>
        ))}
        <div style={{ width: '1px', height: '24px', background: '#DDD8CF', margin: '0 4px' }} />
        {[
          ['today','Today'],['tomorrow','Tomorrow'],['week','This Week'],
          ['all','All'],['deliveries','Deliveries'],['collections','Collections'],
          ['amended','Amended'],['urgent','Urgent'],['missing','Missing Data'],
        ].map(([f, label]) => (
          <button key={f} style={{ ...styles.filterBtn, ...(filter === f && view === 'list' ? styles.filterBtnActive : {}) }}
            onClick={() => { setFilter(f); setView('list') }}>{label}</button>
        ))}
      </div>

      {/* Search */}
      <input
        placeholder="🔍 Search by client, event, venue, reference…"
        value={search} onChange={e => setSearch(e.target.value)}
        style={{ ...styles.searchInput, marginBottom: '16px' }}
      />

      {/* Legend */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
        {[['DEL','#EF4444','Delivery'],['COL','#22C55E','Collection']].map(([type, color, label]) => (
          <span key={type} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
            <span style={{ background: color, color: 'white', padding: '2px 8px', borderRadius: '3px', fontSize: '11px', fontWeight: '700' }}>{type}</span> {label}
          </span>
        ))}
        <span style={{ fontSize: '11px', color: '#9CA3AF', marginLeft: 'auto' }}>⚡ Auto-populated from Current RMS · Read-only source</span>
      </div>

      {/* ── LIST VIEW ── */}
      {view === 'list' && (
        <div>
          {filteredRuns.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#9CA3AF', fontSize: '14px' }}>
              No schedule entries for this filter
            </div>
          ) : (
            // Group by date
            Object.entries(
              filteredRuns.reduce((acc, r) => {
                const k = r.runDate || 'No Date'
                if (!acc[k]) acc[k] = []
                acc[k].push(r)
                return acc
              }, {})
            ).map(([date, runs]) => (
              <div key={date} style={{ marginBottom: '20px' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 16px',
                  background: date === today ? '#1C1C1E' : '#F7F3EE',
                  color: date === today ? 'white' : '#1C1C1E',
                  borderRadius: '6px', marginBottom: '8px',
                  border: date === today ? '2px solid #B8965A' : '1px solid #DDD8CF',
                }}>
                  <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '18px', fontWeight: '600' }}>
                    {date === today ? '📌 TODAY — ' : date === tomorrow ? '📅 TOMORROW — ' : ''}{fmt(date)}
                  </span>
                  <span style={{ fontSize: '11px', opacity: 0.6 }}>{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
                  {runs.some(r => r.isUrgent) && <span style={{ background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '3px' }}>⚠ URGENT</span>}
                </div>

                <div style={styles.card}>
                  <table style={styles.table}>
                    <thead>
                      <tr>{['D/C','Time','Event / Client','Venue','Ref','Status','Flags',''].map(h => <th key={h} style={styles.th}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {runs.map((run, i) => {
                        const colors = run.runType === 'DEL'
                          ? { bg: '#FEF2F2', badge: '#EF4444', text: '#991B1B' }
                          : { bg: '#F0FDF4', badge: '#22C55E', text: '#166534' }
                        return (
                          <tr key={run.id} style={{ background: run.isUrgent ? '#FFF5F5' : run.missingTime ? '#FFFBEB' : 'white', cursor: 'pointer' }}
                            onClick={() => setSelectedRun(run)}>
                            <td style={styles.td}>
                              <span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>{run.runType}</span>
                            </td>
                            <td style={{ ...styles.td, fontWeight: '600', color: run.missingTime ? '#9CA3AF' : '#1C1C1E', fontFamily: "'Cormorant Garamond', serif", fontSize: '16px' }}>
                              {run.runTime || <span style={{ fontSize: '11px', color: '#F59E0B' }}>⚠ No time</span>}
                            </td>
                            <td style={styles.td}>
                              <div style={{ fontWeight: 500 }}>{run.event || run.client}</div>
                              <div style={{ fontSize: '11.5px', color: '#6B6860' }}>{run.client}</div>
                            </td>
                            <td style={{ ...styles.td, fontSize: '12px', color: '#6B6860', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.venue || '—'}</td>
                            <td style={{ ...styles.td, fontFamily: "'Cormorant Garamond', serif", fontSize: '14px', color: '#B8965A' }}>{run.ref}</td>
                            <td style={styles.td}>
                              <span style={{ background: run.status === 'confirmed' ? '#ECFDF5' : '#FFFBEB', color: run.status === 'confirmed' ? '#065F46' : '#92400E', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', textTransform: 'capitalize' }}>
                                {run.status}
                              </span>
                            </td>
                            <td style={styles.td}>
                              {run.isUrgent && <span style={{ background: '#EF4444', color: 'white', fontSize: '9px', fontWeight: '700', padding: '2px 5px', borderRadius: '3px', marginRight: '4px' }}>URGENT</span>}
                              {run.isAmended && <span style={{ background: '#FEF3C7', color: '#92400E', fontSize: '9px', fontWeight: '600', padding: '2px 5px', borderRadius: '3px' }}>AMENDED</span>}
                            </td>
                            <td style={styles.td}><button style={styles.btnGhost}>View →</button></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── WEEK VIEW ── */}
      {view === 'week' && <WeekView jobs={jobs} allRuns={allRuns} weekOffset={weekOffset} setWeekOffset={setWeekOffset} onSelect={setSelectedRun} />}

      {/* ── MONTH VIEW ── */}
      {view === 'month' && <MonthView allRuns={allRuns} monthDate={monthDate} setMonthDate={setMonthDate} onSelect={setSelectedRun} />}

      {/* ── YEAR VIEW ── */}
      {view === 'year' && <YearView allRuns={allRuns} yearDate={yearDate} setYearDate={setYearDate} setMonthDate={setMonthDate} setView={setView} />}

      {/* Run detail panel */}
      {selectedRun && <RunDetailPanel run={selectedRun} onClose={() => setSelectedRun(null)} />}
    </div>
  )
}

// ── WEEK VIEW ──────────────────────────────────────────────────────────────────
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
        <button style={styles.btnOutline} onClick={() => setWeekOffset(w => w - 1)}>← Prev</button>
        <span style={styles.weekLabel}>{weekLabel}</span>
        <button style={styles.btnOutline} onClick={() => setWeekOffset(0)}>Today</button>
        <button style={styles.btnOutline} onClick={() => setWeekOffset(w => w + 1)}>Next →</button>
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

// ── MONTH VIEW ─────────────────────────────────────────────────────────────────
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
        <button style={styles.btnOutline} onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() - 1))}>← Prev</button>
        <span style={styles.weekLabel}>{MONTHS[month]} {year}</span>
        <button style={styles.btnOutline} onClick={() => setMonthDate(new Date())}>Today</button>
        <button style={styles.btnOutline} onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() + 1))}>Next →</button>
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
      <div style={styles.sectionLabel}>All runs — {MONTHS[month]} {year}</div>
      {monthRuns.length === 0
        ? <div style={{ color: '#9CA3AF', fontSize: '13px', padding: '16px' }}>No runs scheduled this month</div>
        : (
          <div style={styles.card}>
            <table style={styles.table}>
              <thead><tr>{['D/C','Date','Time','Event / Client','Venue','Status',''].map(h => <th key={h} style={styles.th}>{h}</th>)}</tr></thead>
              <tbody>
                {monthRuns.map((run, i) => {
                  const colors = run.runType === 'DEL' ? { badge: '#EF4444' } : { badge: '#22C55E' }
                  return (
                    <tr key={i} style={{ cursor: 'pointer' }} onClick={() => onSelect(run)}>
                      <td style={styles.td}><span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>{run.runType}</span></td>
                      <td style={styles.td}>{fmt(run.runDate)}</td>
                      <td style={{ ...styles.td, fontFamily: "'Cormorant Garamond', serif", fontSize: '15px' }}>{run.runTime || <span style={{ fontSize: '11px', color: '#F59E0B' }}>⚠ No time</span>}</td>
                      <td style={styles.td}><div style={{ fontWeight: 500 }}>{run.event || run.client}</div><div style={{ fontSize: '11px', color: '#6B6860' }}>{run.client}</div></td>
                      <td style={{ ...styles.td, fontSize: '12px', color: '#6B6860' }}>{run.venue || '—'}</td>
                      <td style={styles.td}><span style={{ background: '#ECFDF5', color: '#065F46', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', textTransform: 'capitalize' }}>{run.status}</span></td>
                      <td style={styles.td}><button style={styles.btnGhost}>View →</button></td>
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

// ── YEAR VIEW ──────────────────────────────────────────────────────────────────
function YearView({ allRuns, yearDate, setYearDate, setMonthDate, setView }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
        <button style={styles.btnOutline} onClick={() => setYearDate(d => new Date(d.getFullYear() - 1, 0))}>← {yearDate.getFullYear() - 1}</button>
        <span style={styles.weekLabel}>{yearDate.getFullYear()}</span>
        <button style={styles.btnOutline} onClick={() => setYearDate(new Date())}>This Year</button>
        <button style={styles.btnOutline} onClick={() => setYearDate(d => new Date(d.getFullYear() + 1, 0))}>{yearDate.getFullYear() + 1} →</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
        {MONTHS.map((monthName, monthIdx) => {
          const monthRuns = allRuns.filter(r => {
            const d = new Date(r.runDate)
            return d.getFullYear() === yearDate.getFullYear() && d.getMonth() === monthIdx
          })
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
                  {monthRuns.slice(0, 3).map((run, j) => {
                    const color = run.runType === 'DEL' ? '#EF4444' : '#22C55E'
                    return (
                      <div key={j} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '11px' }}>
                        <span style={{ background: color, color: 'white', fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '2px' }}>{run.runType}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.event || run.client}</span>
                        <span style={{ color: '#9CA3AF', flexShrink: 0 }}>{new Date(run.runDate + 'T12:00:00').getDate()}</span>
                      </div>
                    )
                  })}
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
    </div>
  )
  return (
    <div onClick={onClick} style={{ background: colors.bg, border: `1.5px solid ${colors.border}`, borderRadius: '5px', padding: '7px 9px', marginBottom: '5px', cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '3px' }}>
        <span style={{ background: colors.badge, color: 'white', fontSize: '9px', fontWeight: '700', padding: '2px 5px', borderRadius: '2px' }}>{run.runType}</span>
        <span style={{ fontSize: '11.5px', fontWeight: '600', color: colors.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.event || run.client}</span>
      </div>
      {run.runTime && <div style={{ fontSize: '10px', color: '#6B6860' }}>🕐 {run.runTime}</div>}
      {run.isUrgent && <div style={{ fontSize: '9px', background: '#EF4444', color: 'white', padding: '1px 4px', borderRadius: '2px', display: 'inline-block', marginTop: '3px' }}>URGENT</div>}
    </div>
  )
}

// ── RUN DETAIL PANEL ──────────────────────────────────────────────────────────
function RunDetailPanel({ run, onClose }) {
  const colors = run.runType === 'DEL'
    ? { border: '#EF4444', badge: '#EF4444', bg: '#FEF2F2' }
    : { border: '#22C55E', badge: '#22C55E', bg: '#F0FDF4' }
  return (
    <div style={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={styles.panel}>
        <div style={{ ...styles.panelHeader, borderBottom: `3px solid ${colors.border}` }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
              <span style={{ background: colors.badge, color: 'white', fontSize: '12px', fontWeight: '700', padding: '4px 10px', borderRadius: '4px' }}>{run.runType}</span>
              <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600' }}>{run.event || run.client}</span>
              {run.isUrgent && <span style={{ background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '3px' }}>⚠ URGENT</span>}
              {run.isAmended && <span style={{ background: '#FEF3C7', color: '#92400E', fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '3px' }}>AMENDED</span>}
            </div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>{run.ref} · Auto-generated from Current RMS · Read-only</div>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '24px 28px', overflowY: 'auto' }}>
          <div style={styles.sectionLabel}>{run.runType === 'DEL' ? 'Delivery' : 'Collection'} Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            {[
              ['Date', fmt(run.runDate)],
              ['Time', run.runTime || '⚠ Not set'],
              ['Client', run.client],
              ['Venue', run.venue || '—'],
              ['Status', run.status],
              ['Reference', run.ref],
            ].map(([label, value]) => (
              <div key={label} style={{ background: '#F7F3EE', borderRadius: '6px', padding: '12px' }}>
                <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '4px' }}>{label}</div>
                <div style={{ fontSize: '13.5px', fontWeight: '500', color: '#1C1C1E', textTransform: 'capitalize' }}>{value}</div>
              </div>
            ))}
          </div>
          {run.notes && (
            <>
              <div style={styles.sectionLabel}>Notes</div>
              <div style={{ background: '#F7F3EE', borderRadius: '6px', padding: '14px', fontSize: '13px', lineHeight: '1.6', marginBottom: '20px' }}>{run.notes}</div>
            </>
          )}
          <div style={{ fontSize: '11px', color: '#9CA3AF', borderTop: '1px solid #DDD8CF', paddingTop: '16px' }}>
            This schedule entry is automatically generated and maintained from the corresponding job in Current RMS. Changes made in Current RMS will be reflected here within 5 minutes.
          </div>
        </div>
      </div>
    </div>
  )
}

const styles = {
  syncBar: { background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '6px', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' },
  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px', marginBottom: '20px' },
  statCard: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '14px 16px', boxShadow: '0 2px 8px rgba(28,28,30,0.04)' },
  sectionLabel: { fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B8965A', fontWeight: '600', marginBottom: '12px' },
  btnOutline: { background: 'transparent', color: '#1C1C1E', border: '1.5px solid #DDD8CF', borderRadius: '4px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnActive: { background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  btnGhost: { background: 'transparent', color: '#B8965A', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' },
  filterBtn: { padding: '6px 12px', borderRadius: '20px', border: '1.5px solid #DDD8CF', background: 'transparent', color: '#6B6860', fontSize: '11px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  filterBtnActive: { background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  searchInput: { width: '100%', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', boxSizing: 'border-box' },
  weekLabel: { fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600', padding: '0 12px' },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(28,28,30,0.08)' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '10px 16px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500', whiteSpace: 'nowrap' },
  td: { padding: '12px 16px', fontSize: '13px', borderBottom: '1px solid #EDE8E0', verticalAlign: 'middle' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
  panel: { background: '#fff', width: '100%', maxWidth: '600px', height: '100vh', display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 48px rgba(28,28,30,0.14)' },
  panelHeader: { padding: '24px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: '#F7F3EE', flexShrink: 0 },
  closeBtn: { background: '#DDD8CF', border: 'none', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '14px', color: '#1C1C1E', flexShrink: 0 },
}

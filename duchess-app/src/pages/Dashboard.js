import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const today = new Date().toISOString().split('T')[0]
const SELF_COLLECTION_NAME = 'self collection'

function isSelfCollectionName(name) {
  return (name || '').toLowerCase().trim() === SELF_COLLECTION_NAME
}

function getRunBadgeTone(run) {
  const isSelfCollection = isSelfCollectionName(run?.job?.assigned_driver_name)
  if (isSelfCollection) return { label: 'SC', background: '#EEE5F9', color: '#6B2FB8' }
  return run.type === 'DEL'
    ? { label: 'DEL', background: '#FCEBEB', color: '#A32D2D' }
    : { label: 'COL', background: '#EAF3DE', color: '#3B6D11' }
}

function getDriverPillTone(driverName) {
  if (isSelfCollectionName(driverName)) return { background: '#6B2FB8', color: '#FFFFFF' }
  return { background: '#DBEAFE', color: '#1D4ED8' }
}

function getWeekDays() {
  const now = new Date()
  const day = now.getDay()
  const mon = new Date(now)
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon)
    d.setDate(mon.getDate() + i)
    return d.toISOString().split('T')[0]
  })
}

function fmt(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  })
}

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts)
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function Dashboard({ onNavigate, onForceScheduleRefresh }) {
  const { profile } = useAuth()
  const [jobs, setJobs]         = useState([])
  const [changes, setChanges]   = useState([])
  const [syncInfo, setSyncInfo] = useState(null)
  const [fleetAlerts, setFleetAlerts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [viewMonth, setViewMonth] = useState(new Date())
  const [forceSyncing, setForceSyncing] = useState(false)
  const [forceSyncResult, setForceSyncResult] = useState(null)

  useEffect(() => {
    fetchAll()
    const channel = supabase.channel('dashboard-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crms_jobs' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'change_log' }, fetchAll)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function fetchAll() {
    const [{ data: jobsData }, { data: changesData }, { data: syncData }] = await Promise.all([
      supabase.from('crms_jobs').select('*').not('status', 'eq', 'cancelled'),
      supabase.from('change_log').select('*').is('acknowledged_at', null).order('detected_at', { ascending: false }).limit(10),
      supabase.from('sync_runs').select('*').order('started_at', { ascending: false }).limit(1).single(),
    ])
    if (jobsData) setJobs(jobsData)
    if (changesData) setChanges(changesData)
    if (syncData) setSyncInfo(syncData)
    await fetchFleetAlerts()
    setLoading(false)
  }

  async function handleForceSync() {
    if (forceSyncing) return
    setForceSyncing(true)
    setForceSyncResult(null)
    try {
      const res = await fetch('/api/sync', {
        method: 'GET',
        headers: { 'X-Force-Sync': 'manual' },
      })
      const data = await res.json()
      setForceSyncResult({
        ok: !!data.success,
        stats: data.stats,
        error: data.error || null,
        time: new Date().toLocaleTimeString('en-GB'),
      })
      await fetchAll()
      if (typeof onForceScheduleRefresh === 'function') onForceScheduleRefresh()
    } catch (e) {
      setForceSyncResult({ ok: false, error: e.message || 'unknown' })
    }
    setForceSyncing(false)
  }

  async function fetchFleetAlerts() {
    const today = new Date()
    const in45Days = new Date()
    in45Days.setDate(today.getDate() + 45)
    const todayStr = today.toISOString().split('T')[0]
    const in45Str = in45Days.toISOString().split('T')[0]

    // Check MOT expiry
    const { data: vans } = await supabase
      .from('fleet_vans')
      .select('id, registration, make, model, mot_expiry')
      .eq('active', true)
      .gte('mot_expiry', todayStr)
      .lte('mot_expiry', in45Str)

    const motAlerts = (vans || []).map(v => {
      const daysLeft = Math.ceil(
        (new Date(v.mot_expiry) - today) / (1000 * 60 * 60 * 24)
      )
      return {
        type: 'MOT',
        van: `${v.registration} · ${v.make} ${v.model}`,
        daysLeft,
        expiry: v.mot_expiry,
        id: v.id,
      }
    })

    // Check service — last service event per van
    const { data: allVans } = await supabase
      .from('fleet_vans')
      .select('id, registration, make, model')
      .eq('active', true)

    const serviceAlerts = []
    for (const van of (allVans || [])) {
      const { data: lastService } = await supabase
        .from('fleet_events')
        .select('event_date')
        .eq('van_id', van.id)
        .eq('event_type', 'service')
        .order('event_date', { ascending: false })
        .limit(1)
        .single()

      if (lastService?.event_date) {
        const nextService = new Date(lastService.event_date)
        nextService.setMonth(nextService.getMonth() + 6)
        const nextStr = nextService.toISOString().split('T')[0]
        if (nextStr >= todayStr && nextStr <= in45Str) {
          const daysLeft = Math.ceil((nextService - today) / (1000 * 60 * 60 * 24))
          serviceAlerts.push({
            type: 'Service',
            van: `${van.registration} · ${van.make} ${van.model}`,
            daysLeft,
            expiry: nextStr,
            id: van.id,
          })
        }
      }
    }

    setFleetAlerts([...motAlerts, ...serviceAlerts].sort((a, b) => a.daysLeft - b.daysLeft))
  }

  const weekDays = getWeekDays()

  // Stats
  const todayDel    = jobs.filter(j => j.delivery_date === today)
  const todayCol    = jobs.filter(j => j.collection_date === today)
  const unassignedToday = [...todayDel, ...todayCol].filter(j => !j.assigned_driver_id)
  const weekJobs    = jobs.filter(j =>
    weekDays.includes(j.delivery_date) || weekDays.includes(j.collection_date)
  )
  const unassignedWeek = weekJobs.filter(j => !j.assigned_driver_id)

  // Today's runs sorted by time
  const todayRuns = []
  for (const j of jobs) {
    if (j.delivery_date === today) todayRuns.push({ job: j, type: 'DEL', time: j.delivery_time })
    if (j.collection_date === today) todayRuns.push({ job: j, type: 'COL', time: j.collection_time })
  }
  todayRuns.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))

  const syncOk = syncInfo?.status === 'success'
  const lastSync = syncInfo ? new Date(syncInfo.completed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'
  const canForceSync = profile?.role === 'admin' || profile?.role === 'operations'

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading dashboard…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Sync bar */}
      <div style={S.syncBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: syncOk ? '#22C55E' : '#F59E0B', display: 'inline-block' }} />
          <span style={{ fontSize: '12px', color: '#6B6860' }}>
            Live — synced with Current RMS · last sync {lastSync} · {jobs.length} jobs
          </span>
          {canForceSync && (
            <>
              <button
                onClick={handleForceSync}
                disabled={forceSyncing}
                style={{
                  fontSize: '11px', padding: '6px 12px',
                  borderRadius: '6px', border: '1px solid #DDD8CF',
                  background: forceSyncing ? '#F7F3EE' : '#fff',
                  color: '#1C1C1E', cursor: forceSyncing ? 'default' : 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                  fontWeight: '500',
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  marginLeft: '12px',
                }}
              >
                {forceSyncing ? (
                  <>
                    <span style={{ display: 'inline-block', width: '10px', height: '10px', border: '2px solid #C4A882', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    Syncing...
                  </>
                ) : (
                  '↻ Force sync now'
                )}
              </button>
              {forceSyncResult && (
                <div style={{
                  fontSize: '11px',
                  color: forceSyncResult.ok ? '#3B6D11' : '#A32D2D',
                  marginLeft: '12px',
                  fontFamily: "'DM Sans', sans-serif",
                }}>
                  {forceSyncResult.ok
                    ? `✓ Synced at ${forceSyncResult.time} · ${forceSyncResult.stats?.updated || 0} updated`
                    : `✗ Sync failed: ${forceSyncResult.error || 'unknown'}`}
                </div>
              )}
            </>
          )}
        </div>
        <span style={{ fontSize: '12px', color: '#6B6860' }}>{fmt(today)}</span>
      </div>

      {/* Stats */}
      <div style={S.sectionLabel}>Today at a glance</div>
      <div style={S.statGrid}>
        {[
          { label: 'Deliveries today', value: todayDel.length, sub: `${todayDel.filter(j => j.assigned_driver_id).length} assigned · ${todayDel.filter(j => !j.assigned_driver_id).length} unassigned`, color: '#E24B4A', numColor: '#E24B4A' },
          { label: 'Collections today', value: todayCol.length, sub: `${todayCol.filter(j => j.assigned_driver_id).length} assigned · ${todayCol.filter(j => !j.assigned_driver_id).length} unassigned`, color: '#1D9E75', numColor: '#1D9E75' },
          { label: 'Unassigned this week', value: unassignedWeek.length, sub: 'needs driver assignment', color: '#BA7517', numColor: '#BA7517' },
          { label: 'Active jobs (2026)', value: jobs.length, sub: 'confirmed orders only', color: '#378ADD', numColor: '#378ADD' },
        ].map(s => (
          <div key={s.label} style={{ ...S.statCard, borderLeft: `3px solid ${s.color}` }}>
            <div style={S.statLabel}>{s.label}</div>
            <div style={{ ...S.statNum, color: s.numColor }}>{s.value}</div>
            <div style={S.statSub}>{s.sub}</div>
          </div>
        ))}
      </div>

      {fleetAlerts.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#92400E', marginBottom: '10px' }}>
            Fleet Alerts
          </div>
          {fleetAlerts.map((alert, i) => (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              marginBottom: '8px',
              background: alert.daysLeft <= 14 ? '#FEF2F2' : '#FEF3C7',
              border: `1px solid ${alert.daysLeft <= 14 ? '#FECACA' : '#FDE68A'}`,
              borderLeft: `3px solid ${alert.daysLeft <= 14 ? '#DC2626' : '#D97706'}`,
              borderRadius: '6px',
            }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: '500', color: '#1C1C1E' }}>
                  {alert.type === 'MOT' ? '🚗' : '🔧'} {alert.van}
                </div>
                <div style={{ fontSize: '12px', color: '#6B6860', marginTop: '2px' }}>
                  {alert.type} {alert.type === 'MOT' ? 'expires' : 'due'} {alert.expiry}
                </div>
              </div>
              <div style={{
                fontSize: '13px',
                fontWeight: '600',
                color: alert.daysLeft <= 14 ? '#DC2626' : '#D97706',
                flexShrink: 0,
                marginLeft: '16px',
              }}>
                {alert.daysLeft}d
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Monthly view */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: '600', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6860' }}>
            {viewMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              style={{ width: '28px', height: '28px', border: '1px solid #DDD8CF', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >←</button>
            <button
              onClick={() => setViewMonth(new Date())}
              style={{ padding: '4px 10px', border: '1px solid #DDD8CF', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '11px', fontFamily: "'DM Sans', sans-serif", color: '#6B6860' }}
            >Today</button>
            <button
              onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              style={{ width: '28px', height: '28px', border: '1px solid #DDD8CF', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >→</button>
          </div>
        </div>

        <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden' }}>
          {/* Day headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF' }}>
            {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
              <div key={d} style={{ padding: '8px 4px', textAlign: 'center', fontSize: '10px', fontWeight: '600', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{d}</div>
            ))}
          </div>

          {/* Calendar grid */}
          {(() => {
            const todayCal = new Date().toLocaleDateString('en-CA')
            const year = viewMonth.getFullYear()
            const month = viewMonth.getMonth()
            const firstDay = new Date(year, month, 1)
            const lastDay = new Date(year, month + 1, 0)

            // Monday = 0
            let startPad = firstDay.getDay() - 1
            if (startPad < 0) startPad = 6

            const days = []
            // Empty cells before month start
            for (let i = 0; i < startPad; i++) {
              days.push(null)
            }
            // Days of month
            for (let d = 1; d <= lastDay.getDate(); d++) {
              days.push(new Date(year, month, d))
            }
            // Pad to complete last week
            while (days.length % 7 !== 0) days.push(null)

            const weeks = []
            for (let i = 0; i < days.length; i += 7) {
              weeks.push(days.slice(i, i + 7))
            }

            return weeks.map((week, wi) => (
              <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', borderBottom: wi < weeks.length - 1 ? '1px solid #EDE8E0' : 'none' }}>
                {week.map((day, di) => {
                  if (!day) return <div key={di} style={{ minHeight: '64px', background: '#FAFAF8', borderRight: di < 6 ? '1px solid #EDE8E0' : 'none' }} />

                  const ds = day.toLocaleDateString('en-CA')
                  const isTodayCell = ds === todayCal
                  const isPast = ds < todayCal

                  // Count runs for this day from jobs
                  const dayDels = jobs?.filter(j => (j.manual_delivery_date || j.delivery_date) === ds) || []
                  const dayCols = jobs?.filter(j => (j.manual_collection_date || j.collection_date) === ds) || []
                  const total = dayDels.length + dayCols.length

                  return (
                    <div key={di}
                      onClick={() => total > 0 && onNavigate && onNavigate('schedule')}
                      style={{
                        minHeight: '64px',
                        padding: '6px 8px',
                        borderRight: di < 6 ? '1px solid #EDE8E0' : 'none',
                        background: isTodayCell ? '#FFF8F0' : isPast ? '#FAFAFA' : '#fff',
                        cursor: total > 0 ? 'pointer' : 'default',
                        position: 'relative'
                      }}>
                      <div style={{
                        fontSize: '12px',
                        fontWeight: isTodayCell ? '700' : '400',
                        color: isTodayCell ? '#B8965A' : isPast ? '#9CA3AF' : '#1C1C1E',
                        marginBottom: '4px'
                      }}>
                        {isTodayCell ? (
                          <span style={{ background: '#B8965A', color: '#fff', borderRadius: '50%', width: '20px', height: '20px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px' }}>
                            {day.getDate()}
                          </span>
                        ) : day.getDate()}
                      </div>
                      {dayDels.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', marginBottom: '2px' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#EF4444', flexShrink: 0 }} />
                          <span style={{ fontSize: '9px', color: '#A32D2D', fontWeight: '600' }}>{dayDels.length} DEL</span>
                        </div>
                      )}
                      {dayCols.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22C55E', flexShrink: 0 }} />
                          <span style={{ fontSize: '9px', color: '#3B6D11', fontWeight: '600' }}>{dayCols.length} COL</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          })()}
        </div>
      </div>

      {/* Today's runs + Alerts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '1.5rem' }}>

        {/* Today's runs */}
        <div style={S.card}>
          <div style={S.cardHeader}>
            <div>
              <div style={S.cardTitle}>Today's runs</div>
              <div style={S.cardSub}>{todayRuns.length} scheduled · {unassignedToday.length} unassigned</div>
            </div>
            <button style={S.linkBtn} onClick={() => onNavigate('schedule')}>View schedule →</button>
          </div>
          <div style={{ padding: '0 16px' }}>
            {todayRuns.length === 0 ? (
              <div style={{ padding: '24px 0', textAlign: 'center', color: '#9CA3AF', fontSize: '13px' }}>No runs scheduled today</div>
            ) : todayRuns.map((r, i) => (
              <div key={i} style={S.runRow}>
                {(() => {
                  const badgeTone = getRunBadgeTone(r)
                  return <span style={{ ...S.badge, background: badgeTone.background, color: badgeTone.color }}>{badgeTone.label}</span>
                })()}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: '500', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.job.event_name || r.job.client_name}
                  </div>
                  <div style={{ fontSize: '11px', color: '#6B6860', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.job.venue || '—'}
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: '#6B6860', flexShrink: 0 }}>{r.time || '—'}</div>
                {r.job.assigned_driver_name ? (
                  <span style={{ ...S.driverPill, ...getDriverPillTone(r.job.assigned_driver_name) }}>{r.job.assigned_driver_name}</span>
                ) : (
                  <span style={S.unassigned}>Unassigned</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Alerts */}
        <div style={S.card}>
          <div style={S.cardHeader}>
            <div>
              <div style={S.cardTitle}>Operational alerts</div>
              <div style={S.cardSub}>Needs attention</div>
            </div>
          </div>
          <div style={{ padding: '0 16px' }}>
            {unassignedToday.length > 0 && (
              <div style={S.alertRow}>
                <div style={{ ...S.alertIcon, background: '#FEF3C7' }}>⚠</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '13px', fontWeight: '500' }}>{unassignedToday.length} run{unassignedToday.length > 1 ? 's' : ''} today without driver</div>
                  <div style={{ fontSize: '11px', color: '#6B6860' }}>Assign before runs begin</div>
                </div>
                <span style={{ fontSize: '11px', color: '#DC2626', fontWeight: '500' }}>urgent</span>
              </div>
            )}
            {jobs.filter(j => (j.delivery_date === today && !j.delivery_time) || (j.collection_date === today && !j.collection_time)).map((j, i) => (
              <div key={i} style={S.alertRow}>
                <div style={{ ...S.alertIcon, background: '#FEF3C7' }}>⚠</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '13px', fontWeight: '500' }}>{j.event_name} — time missing</div>
                  <div style={{ fontSize: '11px', color: '#6B6860' }}>No delivery/collection time set</div>
                </div>
                <span style={{ fontSize: '11px', color: '#6B6860' }}>today</span>
              </div>
            ))}
            {changes.slice(0, 4).map((c, i) => (
              <div key={i} style={S.alertRow}>
                <div style={{ ...S.alertIcon, background: '#EFF6FF' }}>↻</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '13px', fontWeight: '500' }}>
                    {c.field_changed?.replace(/_/g, ' ')} changed — {c.event_name}
                  </div>
                  <div style={{ fontSize: '11px', color: '#6B6860' }}>
                    {c.old_value || '(empty)'} → {c.new_value}
                  </div>
                </div>
                <span style={{ fontSize: '11px', color: '#9CA3AF' }}>{timeAgo(c.detected_at)}</span>
              </div>
            ))}
            {unassignedToday.length === 0 && changes.length === 0 && (
              <div style={{ padding: '24px 0', textAlign: 'center', color: '#9CA3AF', fontSize: '13px' }}>All clear — no alerts</div>
            )}
          </div>
        </div>
      </div>

      {/* Recent CRM activity */}
      <div style={S.sectionLabel}>Recent Current RMS activity</div>
      <div style={S.card}>
        <div style={S.cardHeader}>
          <div style={S.cardTitle}>Changes detected from sync</div>
          <button style={S.linkBtn} onClick={() => onNavigate('livejobs')}>View all →</button>
        </div>
        <div style={{ padding: '0 16px' }}>
          {changes.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: '#9CA3AF', fontSize: '13px' }}>No recent changes detected</div>
          ) : changes.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '0.5px solid #EDE8E0' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: c.is_urgent ? '#E24B4A' : c.affects_schedule ? '#BA7517' : '#1D9E75', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: '500' }}>
                  {c.field_changed?.replace(/_/g, ' ')} — {c.event_name}
                </div>
                <div style={{ fontSize: '11px', color: '#6B6860' }}>
                  {c.old_value || '(empty)'} → {c.new_value} · {c.job_ref}
                </div>
              </div>
              <div style={{ fontSize: '11px', color: '#9CA3AF', flexShrink: 0 }}>{timeAgo(c.detected_at)}</div>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}

const S = {
  syncBar: { background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '6px', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '8px' },
  sectionLabel: { fontSize: '11px', fontWeight: '500', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '12px' },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px', marginBottom: '1.5rem' },
  statCard: { background: '#F7F3EE', borderRadius: '8px', padding: '1rem' },
  statLabel: { fontSize: '12px', color: '#6B6860', marginBottom: '6px' },
  statNum: { fontSize: '28px', fontWeight: '500', lineHeight: 1, marginBottom: '4px' },
  statSub: { fontSize: '11px', color: '#9CA3AF' },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden' },
  cardHeader: { padding: '14px 16px', borderBottom: '1px solid #DDD8CF', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: '14px', fontWeight: '500', color: '#1C1C1E' },
  cardSub: { fontSize: '12px', color: '#6B6860', marginTop: '2px' },
  linkBtn: { background: 'none', border: 'none', color: '#6B6860', cursor: 'pointer', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" },
  runRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 0', borderBottom: '0.5px solid #EDE8E0' },
  badge: { fontSize: '10px', fontWeight: '500', padding: '2px 7px', borderRadius: '4px', flexShrink: 0 },
  badgeDel: { background: '#FCEBEB', color: '#A32D2D' },
  badgeCol: { background: '#EAF3DE', color: '#3B6D11' },
  driverPill: { fontSize: '10px', fontWeight: '500', padding: '2px 8px', borderRadius: '10px', flexShrink: 0 },
  unassigned: { background: '#FEF3C7', color: '#92400E', fontSize: '10px', padding: '2px 8px', borderRadius: '10px', flexShrink: 0 },
  alertRow: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '9px 0', borderBottom: '0.5px solid #EDE8E0' },
  alertIcon: { width: '24px', height: '24px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '12px' },
}

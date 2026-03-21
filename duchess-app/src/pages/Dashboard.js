import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const today = new Date().toISOString().split('T')[0]

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

export default function Dashboard({ onNavigate }) {
  const [jobs, setJobs]         = useState([])
  const [changes, setChanges]   = useState([])
  const [syncInfo, setSyncInfo] = useState(null)
  const [loading, setLoading]   = useState(true)

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
    setLoading(false)
  }

  const weekDays = getWeekDays()
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

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

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading dashboard…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Sync bar */}
      <div style={S.syncBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: syncOk ? '#22C55E' : '#F59E0B', display: 'inline-block' }} />
          <span style={{ fontSize: '12px', color: '#6B6860' }}>
            Live — synced with Current RMS · last sync {lastSync} · {jobs.length} jobs
          </span>
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

      {/* Week view */}
      <div style={S.sectionLabel}>This week</div>
      <div style={{ ...S.card, marginBottom: '1.5rem' }}>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '6px' }}>
            {weekDays.map((date, i) => {
              const isToday = date === today
              const dels = jobs.filter(j => j.delivery_date === date).length
              const cols = jobs.filter(j => j.collection_date === date).length
              return (
                <div key={date} style={{
                  background: isToday ? '#EFF6FF' : '#F7F3EE',
                  border: isToday ? '1px solid #93C5FD' : '1px solid transparent',
                  borderRadius: '8px', padding: '8px 6px', textAlign: 'center',
                  cursor: (dels + cols) > 0 ? 'pointer' : 'default',
                }} onClick={() => (dels + cols) > 0 && onNavigate('schedule')}>
                  <div style={{ fontSize: '10px', color: '#6B6860', marginBottom: '4px' }}>{DAY_NAMES[i]}</div>
                  <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '6px', color: isToday ? '#1D4ED8' : '#1C1C1E' }}>
                    {new Date(date + 'T12:00:00').getDate()}
                  </div>
                  <div style={{ display: 'flex', gap: '3px', justifyContent: 'center', flexWrap: 'wrap' }}>
                    {Array.from({ length: Math.min(dels, 3) }).map((_, k) => (
                      <div key={`d${k}`} style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#E24B4A' }} />
                    ))}
                    {Array.from({ length: Math.min(cols, 3) }).map((_, k) => (
                      <div key={`c${k}`} style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#1D9E75' }} />
                    ))}
                  </div>
                  {(dels + cols) > 0 && (
                    <div style={{ fontSize: '9px', color: '#6B6860', marginTop: '3px' }}>
                      {dels > 0 ? `${dels}D` : ''}{dels > 0 && cols > 0 ? ' ' : ''}{cols > 0 ? `${cols}C` : ''}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
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
                <span style={{ ...S.badge, ...(r.type === 'DEL' ? S.badgeDel : S.badgeCol) }}>{r.type}</span>
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
                  <span style={{ ...S.driverPill, background: '#DBEAFE', color: '#1D4ED8' }}>{r.job.assigned_driver_name}</span>
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

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const STATUS_STYLE = {
  confirmed:  { bg: '#ECFDF5', color: '#065F46', label: 'Confirmed' },
  pending:    { bg: '#FFFBEB', color: '#92400E', label: 'Pending' },
  cancelled:  { bg: '#FEF2F2', color: '#991B1B', label: 'Cancelled' },
  dispatched: { bg: '#EFF6FF', color: '#1D4ED8', label: 'Dispatched' },
  completed:  { bg: '#F5F3FF', color: '#5B21B6', label: 'Completed' },
}

const SCHEDULE_STYLE = {
  on_schedule:          { bg: '#ECFDF5', color: '#065F46', label: 'On Schedule' },
  rescheduled:          { bg: '#FEF9C3', color: '#854D0E', label: 'Rescheduled' },
  urgent_amendment:     { bg: '#FEF2F2', color: '#991B1B', label: '⚠ Urgent Amendment' },
  awaiting_confirmation:{ bg: '#F0F9FF', color: '#0369A1', label: 'Awaiting Confirmation' },
}

function fmt(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

export default function LiveJobs() {
  const [jobs, setJobs] = useState([])
  const [changes, setChanges] = useState([])
  const [syncInfo, setSyncInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [viewFilter, setViewFilter] = useState('all') // all | deliveries | collections | amended | urgent
  const [selectedJob, setSelectedJob] = useState(null)
  const [tab, setTab] = useState('details') // details | items | changes

  useEffect(() => {
    fetchAll()
    // Real-time updates
    const channel = supabase.channel('crms-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crms_jobs' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'change_log' }, fetchChanges)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function fetchAll() {
    await Promise.all([fetchJobs(), fetchChanges(), fetchLastSync()])
    setLoading(false)
  }

  async function fetchJobs() {
    const { data } = await supabase
      .from('crms_jobs')
      .select('*')
      .not('status', 'eq', 'cancelled')
      .order('delivery_date', { ascending: true, nullsLast: true })
    if (data) setJobs(data)
  }

  async function fetchChanges() {
    const { data } = await supabase
      .from('change_log')
      .select('*')
      .is('acknowledged_at', null)
      .order('detected_at', { ascending: false })
      .limit(50)
    if (data) setChanges(data)
  }

  async function fetchLastSync() {
    const { data } = await supabase
      .from('sync_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .single()
    if (data) setSyncInfo(data)
  }

  async function acknowledgeChange(changeId) {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('change_log').update({
      acknowledged_by: user?.id,
      acknowledged_at: new Date().toISOString()
    }).eq('id', changeId)
    fetchChanges()
  }

  // Filter logic
  const today = new Date().toISOString().split('T')[0]
  const filtered = jobs.filter(j => {
    const matchSearch = !search || [j.event_name, j.client_name, j.venue, j.crms_ref]
      .some(f => f?.toLowerCase().includes(search.toLowerCase()))
    const matchStatus = statusFilter === 'all' || j.status === statusFilter
    const matchView = viewFilter === 'all' ? true
      : viewFilter === 'deliveries'  ? !!j.delivery_date
      : viewFilter === 'collections' ? !!j.collection_date
      : viewFilter === 'amended'     ? j.is_amended
      : viewFilter === 'urgent'      ? j.is_urgent
      : viewFilter === 'today'       ? j.delivery_date === today || j.collection_date === today
      : true
    return matchSearch && matchStatus && matchView
  })

  const todayDeliveries  = jobs.filter(j => j.delivery_date === today).length
  const todayCollections = jobs.filter(j => j.collection_date === today).length
  const urgentCount      = jobs.filter(j => j.is_urgent).length
  const amendedCount     = changes.length

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Syncing with Current RMS…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Sync Status Bar */}
      <div style={styles.syncBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: syncInfo?.status === 'success' ? '#22C55E' : '#F59E0B', display: 'inline-block' }} />
          <span style={{ fontSize: '12px', color: '#6B6860' }}>
            Current RMS sync — last updated {syncInfo ? new Date(syncInfo.completed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'never'}
          </span>
        </div>
        <span style={{ fontSize: '11px', color: '#9CA3AF' }}>Syncs every 5 minutes • Read-only from Current RMS</span>
      </div>

      {/* Urgent Amendments Banner */}
      {changes.filter(c => c.is_urgent).length > 0 && (
        <div style={styles.urgentBanner}>
          <span>⚠️</span>
          <strong>{changes.filter(c => c.is_urgent).length} urgent amendment{changes.filter(c => c.is_urgent).length > 1 ? 's' : ''} detected from Current RMS</strong>
          <span style={{ fontSize: '12px', opacity: 0.8 }}>— scroll down to review</span>
        </div>
      )}

      {/* Today's Stats */}
      <div style={styles.statsRow}>
        {[
          { label: "Today's Deliveries", value: todayDeliveries, color: '#EF4444', icon: '🚚', filter: 'today' },
          { label: "Today's Collections", value: todayCollections, color: '#22C55E', icon: '📦', filter: 'today' },
          { label: 'Pending Amendments', value: amendedCount, color: '#F59E0B', icon: '⚡', filter: 'amended' },
          { label: 'Urgent Changes', value: urgentCount, color: '#EF4444', icon: '⚠️', filter: 'urgent' },
        ].map(stat => (
          <div key={stat.label} style={styles.statCard} onClick={() => setViewFilter(stat.filter)}>
            <div style={{ fontSize: '28px', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600', color: stat.color }}>{stat.value}</div>
            <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px' }}>{stat.icon} {stat.label}</div>
          </div>
        ))}
      </div>

      {/* Pending Changes */}
      {changes.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <div style={styles.sectionLabel}>⚡ Amendments from Current RMS — {changes.length} unacknowledged</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {changes.slice(0, 5).map(c => (
              <div key={c.id} style={{ ...styles.changeCard, borderLeft: `4px solid ${c.is_urgent ? '#EF4444' : '#F59E0B'}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    {c.is_urgent && <span style={{ background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' }}>URGENT</span>}
                    <span style={{ fontWeight: '600', fontSize: '13px' }}>{c.event_name}</span>
                    <span style={{ fontSize: '11px', color: '#6B6860' }}>({c.job_ref})</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#1C1C1E' }}>
                    <span style={{ color: '#6B6860' }}>{c.field_changed.replace(/_/g, ' ')}: </span>
                    <span style={{ textDecoration: 'line-through', color: '#9CA3AF', marginRight: '8px' }}>{c.old_value || '—'}</span>
                    <span style={{ color: '#065F46', fontWeight: '600' }}>→ {c.new_value}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '4px' }}>
                    Detected {new Date(c.detected_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                  </div>
                </div>
                <button style={styles.ackBtn} onClick={() => acknowledgeChange(c.id)}>Acknowledge</button>
              </div>
            ))}
            {changes.length > 5 && (
              <div style={{ fontSize: '12px', color: '#6B6860', textAlign: 'center', padding: '8px' }}>+{changes.length - 5} more amendments</div>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={styles.filterBar}>
        <input
          placeholder="🔍 Search jobs, clients, venues…"
          value={search} onChange={e => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {[
            ['all','All Jobs'],['today','Today'],['deliveries','Deliveries'],
            ['collections','Collections'],['urgent','Urgent'],['amended','Amended'],
          ].map(([v, label]) => (
            <button key={v} style={{ ...styles.filterBtn, ...(viewFilter === v ? styles.filterBtnActive : {}) }} onClick={() => setViewFilter(v)}>{label}</button>
          ))}
        </div>
      </div>

      {/* Jobs Table */}
      <div style={styles.card}>
        <table style={styles.table}>
          <thead>
            <tr>
              {['Ref','Event / Client','Venue','Event Date','Delivery','Collection','Status','Changes',''].map(h => (
                <th key={h} style={styles.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: '48px', color: '#9CA3AF' }}>No jobs found</td></tr>
            ) : filtered.map(job => {
              const ss = STATUS_STYLE[job.status] || STATUS_STYLE.pending
              const jobChanges = changes.filter(c => c.crms_id === job.crms_id).length
              const isToday = job.delivery_date === today || job.collection_date === today
              return (
                <tr key={job.id} style={{ background: isToday ? '#FFFBF5' : 'white', cursor: 'pointer' }} onClick={() => { setSelectedJob(job); setTab('details') }}>
                  <td style={styles.td}>
                    <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '15px', fontWeight: '600', color: '#B8965A' }}>{job.crms_ref}</span>
                  </td>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 500 }}>{job.event_name}</div>
                    <div style={{ fontSize: '11.5px', color: '#6B6860' }}>{job.client_name}</div>
                  </td>
                  <td style={{ ...styles.td, fontSize: '12px', color: '#6B6860', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.venue || '—'}</td>
                  <td style={styles.td}>{fmt(job.event_date)}</td>
                  <td style={styles.td}>
                    {job.delivery_date ? (
                      <><span style={{ background: '#FEF2F2', color: '#991B1B', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px', marginRight: '4px' }}>DEL</span>{fmt(job.delivery_date)}{job.delivery_time && <div style={{ fontSize: '11px', color: '#6B6860' }}>{job.delivery_time}</div>}</>
                    ) : '—'}
                  </td>
                  <td style={styles.td}>
                    {job.collection_date ? (
                      <><span style={{ background: '#F0FDF4', color: '#166534', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px', marginRight: '4px' }}>COL</span>{fmt(job.collection_date)}{job.collection_time && <div style={{ fontSize: '11px', color: '#6B6860' }}>{job.collection_time}</div>}</>
                    ) : '—'}
                  </td>
                  <td style={styles.td}>
                    <span style={{ background: ss.bg, color: ss.color, padding: '4px 10px', borderRadius: '20px', fontSize: '11.5px', fontWeight: '500' }}>{ss.label}</span>
                  </td>
                  <td style={styles.td}>
                    {jobChanges > 0 ? <span style={{ background: '#FEF3C7', color: '#92400E', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>⚡ {jobChanges}</span> : <span style={{ color: '#D1D5DB', fontSize: '11px' }}>—</span>}
                  </td>
                  <td style={styles.td}><button style={styles.btnGhost}>View →</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Job Detail Panel */}
      {selectedJob && (
        <JobDetailPanel
          job={selectedJob}
          changes={changes.filter(c => c.crms_id === selectedJob.crms_id)}
          tab={tab} setTab={setTab}
          onClose={() => setSelectedJob(null)}
          onAcknowledge={acknowledgeChange}
        />
      )}
    </div>
  )
}

function JobDetailPanel({ job, changes, tab, setTab, onClose, onAcknowledge }) {
  const [items, setItems] = useState([])

  useEffect(() => {
    supabase.from('crms_job_items').select('*').eq('crms_opportunity_id', job.crms_id).then(({ data }) => {
      if (data) setItems(data)
    })
  }, [job.crms_id])

  const ss = STATUS_STYLE[job.status] || STATUS_STYLE.pending

  return (
    <div style={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={styles.panel}>
        <div style={styles.panelHeader}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
              <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', fontWeight: '600' }}>{job.event_name}</span>
              <span style={{ background: ss.bg, color: ss.color, padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: '500' }}>{ss.label}</span>
              {changes.length > 0 && <span style={{ background: '#FEF3C7', color: '#92400E', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>⚡ {changes.length} changes</span>}
            </div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>{job.crms_ref} • {job.client_name} • Synced from Current RMS</div>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #DDD8CF', padding: '0 28px' }}>
          {[['details','📋 Details'],['items','📦 Items'],['changes',`⚡ Changes (${changes.length})`]].map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} style={{ ...styles.tabBtn, ...(tab === t ? styles.tabBtnActive : {}) }}>{label}</button>
          ))}
        </div>

        <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1 }}>

          {/* DETAILS TAB */}
          {tab === 'details' && (
            <div>
              <div style={styles.sectionLabel}>Event Details</div>
              <div style={styles.detailGrid}>
                {[
                  ['Client', job.client_name],
                  ['Venue', job.venue],
                  ['Event Date', job.event_date ? new Date(job.event_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—'],
                  ['Reference', job.crms_ref],
                  ['Total Value', job.total_value ? `£${parseFloat(job.total_value).toFixed(2)}` : '—'],
                  ['Current RMS Status', job.crms_status],
                ].map(([label, value]) => (
                  <div key={label} style={styles.detailItem}>
                    <div style={styles.detailLabel}>{label}</div>
                    <div style={styles.detailValue}>{value || '—'}</div>
                  </div>
                ))}
              </div>

              <hr style={styles.divider} />
              <div style={styles.sectionLabel}>Delivery & Collection</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div style={{ background: '#FEF2F2', border: '1.5px solid #EF4444', borderRadius: '8px', padding: '16px' }}>
                  <div style={{ color: '#991B1B', fontWeight: '700', fontSize: '11px', letterSpacing: '0.1em', marginBottom: '8px' }}>🚚 DELIVERY</div>
                  <div style={{ fontSize: '16px', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600' }}>{job.delivery_date ? new Date(job.delivery_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—'}</div>
                  {job.delivery_time && <div style={{ fontSize: '14px', color: '#991B1B', marginTop: '4px' }}>🕐 {job.delivery_time}</div>}
                </div>
                <div style={{ background: '#F0FDF4', border: '1.5px solid #22C55E', borderRadius: '8px', padding: '16px' }}>
                  <div style={{ color: '#166534', fontWeight: '700', fontSize: '11px', letterSpacing: '0.1em', marginBottom: '8px' }}>📦 COLLECTION</div>
                  <div style={{ fontSize: '16px', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600' }}>{job.collection_date ? new Date(job.collection_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—'}</div>
                  {job.collection_time && <div style={{ fontSize: '14px', color: '#166534', marginTop: '4px' }}>🕐 {job.collection_time}</div>}
                </div>
              </div>

              {(job.notes || job.special_instructions) && (
                <>
                  <hr style={styles.divider} />
                  <div style={styles.sectionLabel}>Notes & Instructions</div>
                  {job.notes && <div style={{ background: '#F7F3EE', borderRadius: '6px', padding: '14px', fontSize: '13px', marginBottom: '10px', lineHeight: '1.6' }}>{job.notes}</div>}
                  {job.special_instructions && <div style={{ background: '#FFF8F0', border: '1px solid #B8965A', borderRadius: '6px', padding: '14px', fontSize: '13px', lineHeight: '1.6' }}><strong>Special Instructions:</strong> {job.special_instructions}</div>}
                </>
              )}

              <hr style={styles.divider} />
              <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
                Last synced from Current RMS: {job.last_synced_at ? new Date(job.last_synced_at).toLocaleString('en-GB') : '—'}
              </div>
            </div>
          )}

          {/* ITEMS TAB */}
          {tab === 'items' && (
            <div>
              <div style={styles.sectionLabel}>Order Items — synced from Current RMS</div>
              {items.length === 0 ? (
                <div style={{ color: '#9CA3AF', fontSize: '13px', padding: '16px' }}>No items synced yet</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>{['Item','Category','Qty','Type'].map(h => <th key={h} style={styles.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i}>
                        <td style={styles.td}>{item.item_name}</td>
                        <td style={{ ...styles.td, textTransform: 'capitalize' }}>{item.category}</td>
                        <td style={{ ...styles.td, fontWeight: '600' }}>{item.quantity}</td>
                        <td style={styles.td}>{item.item_type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* CHANGES TAB */}
          {tab === 'changes' && (
            <div>
              <div style={styles.sectionLabel}>Change History from Current RMS</div>
              {changes.length === 0 ? (
                <div style={{ color: '#9CA3AF', fontSize: '13px', padding: '16px' }}>No changes detected for this job</div>
              ) : changes.map(c => (
                <div key={c.id} style={{ ...styles.changeCard, borderLeft: `4px solid ${c.is_urgent ? '#EF4444' : '#F59E0B'}`, marginBottom: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                      {c.is_urgent && <span style={{ background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' }}>URGENT</span>}
                      {c.affects_schedule && <span style={{ background: '#FEF3C7', color: '#92400E', fontSize: '10px', fontWeight: '600', padding: '2px 6px', borderRadius: '3px' }}>SCHEDULE IMPACT</span>}
                      <span style={{ fontSize: '12px', fontWeight: '600', textTransform: 'capitalize' }}>{c.field_changed.replace(/_/g, ' ')}</span>
                    </div>
                    <div style={{ fontSize: '13px' }}>
                      <span style={{ textDecoration: 'line-through', color: '#9CA3AF', marginRight: '10px' }}>{c.old_value || '(empty)'}</span>
                      <span style={{ color: '#065F46', fontWeight: '600' }}>→ {c.new_value}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '6px' }}>
                      {new Date(c.detected_at).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}
                    </div>
                  </div>
                  {!c.acknowledged_at && (
                    <button style={styles.ackBtn} onClick={() => onAcknowledge(c.id)}>Acknowledge</button>
                  )}
                  {c.acknowledged_at && <span style={{ fontSize: '11px', color: '#22C55E' }}>✓ Acknowledged</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  syncBar: { background: '#F7F3EE', border: '1px solid #DDD8CF', borderRadius: '6px', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' },
  urgentBanner: { background: '#FEF2F2', border: '1.5px solid #EF4444', borderRadius: '6px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', fontSize: '13px', color: '#991B1B' },
  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '24px' },
  statCard: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px 20px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(28,28,30,0.04)' },
  sectionLabel: { fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B8965A', fontWeight: '600', marginBottom: '12px' },
  filterBar: { display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' },
  searchInput: { flex: 1, minWidth: '200px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none' },
  filterBtn: { padding: '8px 14px', borderRadius: '4px', border: '1.5px solid #DDD8CF', background: 'transparent', color: '#6B6860', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  filterBtnActive: { background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(28,28,30,0.08)' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '12px 16px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500', whiteSpace: 'nowrap' },
  td: { padding: '13px 16px', fontSize: '13px', borderBottom: '1px solid #EDE8E0', verticalAlign: 'middle' },
  btnGhost: { background: 'transparent', color: '#B8965A', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' },
  changeCard: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '6px', padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: '12px' },
  ackBtn: { background: '#1C1C1E', color: 'white', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '11px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap', flexShrink: 0 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
  panel: { background: '#fff', width: '100%', maxWidth: '680px', height: '100vh', display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 48px rgba(28,28,30,0.14)' },
  panelHeader: { padding: '24px 28px', borderBottom: '1px solid #DDD8CF', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: '#F7F3EE', flexShrink: 0 },
  closeBtn: { background: '#DDD8CF', border: 'none', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '14px', color: '#1C1C1E', flexShrink: 0 },
  tabBtn: { padding: '14px 16px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer', fontSize: '13px', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" },
  tabBtnActive: { color: '#B8965A', borderBottomColor: '#B8965A', fontWeight: '600' },
  detailGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  detailItem: { background: '#F7F3EE', borderRadius: '6px', padding: '12px' },
  detailLabel: { fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '4px' },
  detailValue: { fontSize: '13.5px', fontWeight: '500', color: '#1C1C1E' },
  divider: { border: 'none', borderTop: '1px solid #DDD8CF', margin: '20px 0' },
}

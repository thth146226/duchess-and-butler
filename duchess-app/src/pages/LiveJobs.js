import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import JobNotes from '../components/JobNotes'
import EvidenceUpload from '../components/EvidenceUpload'

const STATUS_STYLE = {
  confirmed:  { bg: '#ECFDF5', color: '#065F46', label: 'Confirmed' },
  pending:    { bg: '#FFFBEB', color: '#92400E', label: 'Pending' },
  cancelled:  { bg: '#FEF2F2', color: '#991B1B', label: 'Cancelled' },
  dispatched: { bg: '#EFF6FF', color: '#1D4ED8', label: 'Dispatched' },
  completed:  { bg: '#F5F3FF', color: '#5B21B6', label: 'Completed' },
}

function fmt(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function fmtLong(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export default function LiveJobs() {
  const [jobs, setJobs]           = useState([])
  const [changes, setChanges]     = useState([])
  const [syncInfo, setSyncInfo]   = useState(null)
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [viewFilter, setView]     = useState('all')
  const [selectedJob, setSelected]= useState(null)
  const [tab, setTab]             = useState('details')

  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    fetchAll()
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
      .from('change_log').select('*')
      .is('acknowledged_at', null)
      .order('detected_at', { ascending: false })
      .limit(50)
    if (data) setChanges(data)
  }

  async function fetchLastSync() {
    const { data } = await supabase
      .from('sync_runs').select('*')
      .order('started_at', { ascending: false })
      .limit(1).single()
    if (data) setSyncInfo(data)
  }

  async function acknowledgeChange(changeId) {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('change_log').update({
      acknowledged_by: user?.id,
      acknowledged_at: new Date().toISOString(),
    }).eq('id', changeId)
    fetchChanges()
  }

  const filtered = jobs.filter(j => {
    const s = !search || [j.event_name, j.client_name, j.venue, j.crms_ref]
      .some(f => f?.toLowerCase().includes(search.toLowerCase()))
    const st = statusFilter === 'all' || j.status === statusFilter
    const v  = viewFilter === 'all'         ? true
             : viewFilter === 'deliveries'  ? !!j.delivery_date
             : viewFilter === 'collections' ? !!j.collection_date
             : viewFilter === 'amended'     ? j.is_amended
             : viewFilter === 'urgent'      ? j.is_urgent
             : viewFilter === 'today'       ? j.delivery_date === today || j.collection_date === today
             : true
    return s && st && v
  })

  const todayDel  = jobs.filter(j => j.delivery_date === today).length
  const todayCol  = jobs.filter(j => j.collection_date === today).length
  const urgent    = jobs.filter(j => j.is_urgent).length
  const amended   = changes.length

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Syncing with Current RMS…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Sync bar */}
      <div style={S.syncBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: syncInfo?.status === 'success' ? '#22C55E' : '#F59E0B', display: 'inline-block' }} />
          <span style={{ fontSize: '12px', color: '#6B6860' }}>
            Current RMS sync — last updated {syncInfo ? new Date(syncInfo.completed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'never'}
          </span>
        </div>
        <span style={{ fontSize: '11px', color: '#9CA3AF' }}>Confirmed orders only · Syncs every 5 minutes</span>
      </div>

      {/* Urgent banner */}
      {changes.filter(c => c.is_urgent).length > 0 && (
        <div style={S.urgentBanner}>
          <span>⚠️</span>
          <strong>{changes.filter(c => c.is_urgent).length} urgent amendment{changes.filter(c => c.is_urgent).length > 1 ? 's' : ''} detected from Current RMS</strong>
          <span style={{ fontSize: '12px', opacity: 0.8 }}>— scroll down to review</span>
        </div>
      )}

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: "Today's Deliveries", value: todayDel,  color: '#EF4444', icon: '🚚', filter: 'today' },
          { label: "Today's Collections", value: todayCol, color: '#22C55E', icon: '📦', filter: 'today' },
          { label: 'Pending Amendments',  value: amended,  color: '#F59E0B', icon: '⚡', filter: 'amended' },
          { label: 'Urgent Changes',      value: urgent,   color: '#EF4444', icon: '⚠️', filter: 'urgent' },
        ].map(stat => (
          <div key={stat.label} style={S.statCard} onClick={() => setView(stat.filter)}>
            <div style={{ fontSize: '28px', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600', color: stat.color }}>{stat.value}</div>
            <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px' }}>{stat.icon} {stat.label}</div>
          </div>
        ))}
      </div>

      {/* Amendments panel */}
      {changes.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <div style={S.sectionLabel}>⚡ Amendments from Current RMS — {changes.length} unacknowledged</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {changes.slice(0, 5).map(c => (
              <div key={c.id} style={{ ...S.changeCard, borderLeft: `4px solid ${c.is_urgent ? '#EF4444' : '#F59E0B'}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
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
                    {new Date(c.detected_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                  </div>
                </div>
                <button style={S.ackBtn} onClick={() => acknowledgeChange(c.id)}>Acknowledge</button>
              </div>
            ))}
            {changes.length > 5 && (
              <div style={{ fontSize: '12px', color: '#6B6860', textAlign: 'center', padding: '8px' }}>+{changes.length - 5} more amendments</div>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={S.filterBar}>
        <input placeholder="🔍 Search jobs, clients, venues…"
          value={search} onChange={e => setSearch(e.target.value)} style={S.searchInput} />
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {[['all','All Jobs'],['today','Today'],['deliveries','Deliveries'],
            ['collections','Collections'],['urgent','Urgent'],['amended','Amended']].map(([v, label]) => (
            <button key={v} style={{ ...S.filterBtn, ...(viewFilter === v ? S.filterBtnActive : {}) }}
              onClick={() => setView(v)}>{label}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={S.card}>
        <table style={S.table}>
          <thead>
            <tr>
              {['Ref','Event / Client','Venue','Event Date','Delivery','Collection','Driver','Status','Changes',''].map(h => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={10} style={{ textAlign: 'center', padding: '48px', color: '#9CA3AF' }}>No jobs found</td></tr>
            ) : filtered.map(job => {
              const ss = STATUS_STYLE[job.status] || STATUS_STYLE.pending
              const jobChanges = changes.filter(c => c.crms_id === job.crms_id).length
              const isToday = job.delivery_date === today || job.collection_date === today
              return (
                <tr key={job.id} style={{ background: isToday ? '#FFFBF5' : 'white', cursor: 'pointer' }}
                  onClick={() => { setSelected(job); setTab('details') }}>
                  <td style={S.td}><span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '15px', fontWeight: '600', color: '#B8965A' }}>{job.crms_ref}</span></td>
                  <td style={S.td}><div style={{ fontWeight: 500 }}>{job.event_name}</div><div style={{ fontSize: '11.5px', color: '#6B6860' }}>{job.client_name}</div></td>
                  <td style={{ ...S.td, fontSize: '12px', color: '#6B6860', maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.venue || '—'}</td>
                  <td style={S.td}>{fmt(job.event_date)}</td>
                  <td style={S.td}>
                    {job.delivery_date ? (<><span style={{ background: '#FEF2F2', color: '#991B1B', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px', marginRight: '4px' }}>DEL</span>{fmt(job.delivery_date)}{job.delivery_time && <div style={{ fontSize: '11px', color: '#6B6860' }}>{job.delivery_time}</div>}</>) : '—'}
                  </td>
                  <td style={S.td}>
                    {job.collection_date ? (<><span style={{ background: '#F0FDF4', color: '#166534', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px', marginRight: '4px' }}>COL</span>{fmt(job.collection_date)}{job.collection_time && <div style={{ fontSize: '11px', color: '#6B6860' }}>{job.collection_time}</div>}</>) : '—'}
                  </td>
                  <td style={S.td}>
                    {job.assigned_driver_name
                      ? <span style={{ background: '#1D4ED8', color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>{job.assigned_driver_name}</span>
                      : <span style={{ color: '#D1D5DB', fontSize: '11px' }}>—</span>}
                  </td>
                  <td style={S.td}><span style={{ background: ss.bg, color: ss.color, padding: '4px 10px', borderRadius: '20px', fontSize: '11.5px', fontWeight: '500' }}>{ss.label}</span></td>
                  <td style={S.td}>{jobChanges > 0 ? <span style={{ background: '#FEF3C7', color: '#92400E', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>⚡ {jobChanges}</span> : <span style={{ color: '#D1D5DB', fontSize: '11px' }}>—</span>}</td>
                  <td style={S.td}><button style={S.btnGhost}>View →</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Detail panel */}
      {selectedJob && (
        <JobDetailPanel
          job={selectedJob}
          changes={changes.filter(c => c.crms_id === selectedJob.crms_id)}
          tab={tab} setTab={setTab}
          onClose={() => setSelected(null)}
          onAcknowledge={acknowledgeChange}
        />
      )}
    </div>
  )
}

// ── JOB DETAIL PANEL ──────────────────────────────────────────────────────────
function JobDetailPanel({ job, changes, tab, setTab, onClose, onAcknowledge }) {
  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(true)

  useEffect(() => {
    setItemsLoading(true)
    supabase
      .from('crms_job_items')
      .select('*')
      .eq('crms_opportunity_id', job.crms_id)
      .order('item_name')
      .then(({ data }) => {
        if (data) setItems(data)
        setItemsLoading(false)
      })
  }, [job.crms_id])

  const ss = STATUS_STYLE[job.status] || STATUS_STYLE.pending

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.panel}>

        {/* Header */}
        <div style={S.panelHeader}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600' }}>{job.event_name}</span>
              <span style={{ background: ss.bg, color: ss.color, padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: '500', whiteSpace: 'nowrap' }}>{ss.label}</span>
              {changes.length > 0 && <span style={{ background: '#FEF3C7', color: '#92400E', padding: '3px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600', whiteSpace: 'nowrap' }}>⚡ {changes.length} changes</span>}
            </div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>{job.crms_ref} · {job.client_name} · Synced from Current RMS</div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #DDD8CF', padding: '0 24px' }}>
          {[
            ['details', '📋 Details'],
            ['items',   `📦 Items${items.length > 0 ? ` (${items.length})` : ''}`],
            ['changes', `⚡ Changes (${changes.length})`],
          ].map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)}
              style={{ ...S.tabBtn, ...(tab === t ? S.tabBtnActive : {}) }}>{label}</button>
          ))}
          <button
            style={{ ...S.tabBtn, ...(tab === 'notes' ? S.tabBtnActive : {}) }}
            onClick={() => setTab('notes')}
          >
            Notes
          </button>
        </div>

        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>

          {/* ── DETAILS TAB ── */}
          {tab === 'details' && (
            <div>
              <div style={S.sectionLabel}>Event Details</div>
              <div style={S.detailGrid}>
                {[
                  ['Client',             job.client_name],
                  ['Reference',          job.crms_ref],
                  ['Event Date',         job.event_date ? fmtLong(job.event_date) : '—'],
                  ['Current RMS Status', job.crms_status],
                  ['Total Value',        job.total_value ? `£${parseFloat(job.total_value).toFixed(2)}` : '—'],
                  ['Assigned Driver',    job.assigned_driver_name || 'Not assigned'],
                ].map(([label, value]) => (
                  <div key={label} style={S.detailItem}>
                    <div style={S.detailLabel}>{label}</div>
                    <div style={S.detailValue}>{value || '—'}</div>
                  </div>
                ))}
              </div>

              {/* ── ISSUE 4: Venue & Full Address ── */}
              <hr style={S.divider} />
              <div style={S.sectionLabel}>Venue & Address</div>
              <div style={{ background: '#F7F3EE', borderRadius: '8px', padding: '16px' }}>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: '20px', flexShrink: 0 }}>📍</span>
                  <div>
                    {job.venue && (
                      <div style={{ fontWeight: '600', fontSize: '14px', color: '#1C1C1E', marginBottom: '4px' }}>
                        {job.venue}
                      </div>
                    )}
                    {job.venue_address ? (
                      <div style={{ fontSize: '13px', color: '#6B6860', lineHeight: '1.6' }}>
                        {job.venue_address}
                      </div>
                    ) : (
                      <div style={{ fontSize: '12px', color: '#9CA3AF', fontStyle: 'italic' }}>
                        Full address not yet available — check Current RMS
                      </div>
                    )}
                    {(job.venue || job.venue_address) && (
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((job.venue_address || job.venue || ''))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: '12px', color: '#1D4ED8', textDecoration: 'none', display: 'inline-block', marginTop: '8px', fontWeight: '500' }}>
                        🗺 Open in Google Maps →
                      </a>
                    )}
                  </div>
                </div>
              </div>

              {/* Delivery & Collection */}
              <hr style={S.divider} />
              <div style={S.sectionLabel}>Delivery & Collection</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ background: '#FEF2F2', border: '1.5px solid #EF4444', borderRadius: '8px', padding: '16px' }}>
                  <div style={{ color: '#991B1B', fontWeight: '700', fontSize: '11px', letterSpacing: '0.1em', marginBottom: '8px' }}>🚚 DELIVERY</div>
                  <div style={{ fontSize: '16px', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600' }}>
                    {job.delivery_date ? fmt(job.delivery_date) : '—'}
                  </div>
                  {job.delivery_time && <div style={{ fontSize: '14px', color: '#991B1B', marginTop: '4px' }}>🕐 {job.delivery_time}</div>}
                  {job.delivery_end_time && <div style={{ fontSize: '12px', color: '#991B1B', opacity: 0.7 }}>until {job.delivery_end_time}</div>}
                </div>
                <div style={{ background: '#F0FDF4', border: '1.5px solid #22C55E', borderRadius: '8px', padding: '16px' }}>
                  <div style={{ color: '#166534', fontWeight: '700', fontSize: '11px', letterSpacing: '0.1em', marginBottom: '8px' }}>📦 COLLECTION</div>
                  <div style={{ fontSize: '16px', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600' }}>
                    {job.collection_date ? fmt(job.collection_date) : '—'}
                  </div>
                  {job.collection_time && <div style={{ fontSize: '14px', color: '#166534', marginTop: '4px' }}>🕐 {job.collection_time}</div>}
                  {job.collection_end_time && <div style={{ fontSize: '12px', color: '#166534', opacity: 0.7 }}>until {job.collection_end_time}</div>}
                </div>
              </div>

              {/* Notes */}
              {(job.notes || job.special_instructions) && (
                <>
                  <hr style={S.divider} />
                  <div style={S.sectionLabel}>Notes & Instructions</div>
                  {job.notes && (
                    <div style={{ background: '#F7F3EE', borderRadius: '6px', padding: '14px', fontSize: '13px', marginBottom: '10px', lineHeight: '1.6' }}>
                      {job.notes}
                    </div>
                  )}
                  {job.special_instructions && (
                    <div style={{ background: '#FFF8F0', border: '1px solid #B8965A', borderRadius: '6px', padding: '14px', fontSize: '13px', lineHeight: '1.6' }}>
                      <strong>Special Instructions:</strong> {job.special_instructions}
                    </div>
                  )}
                </>
              )}

              <hr style={S.divider} />
              <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
                Last synced: {job.last_synced_at ? new Date(job.last_synced_at).toLocaleString('en-GB') : '—'}
              </div>
            </div>
          )}

          {/* ── ITEMS TAB ── */}
          {tab === 'items' && (
            <div>
              <div style={S.sectionLabel}>Order Items — Equipment List</div>

              {itemsLoading ? (
                <div style={{ color: '#9CA3AF', fontSize: '13px', padding: '16px' }}>Loading items…</div>
              ) : items.length === 0 ? (
                <div style={{ background: '#F7F3EE', borderRadius: '8px', padding: '20px', textAlign: 'center' }}>
                  <div style={{ fontSize: '24px', marginBottom: '8px' }}>📦</div>
                  <div style={{ color: '#6B6860', fontSize: '13px', marginBottom: '4px' }}>No items synced yet</div>
                  <div style={{ color: '#9CA3AF', fontSize: '12px' }}>
                    Items sync automatically. If this job has items in Current RMS,<br />
                    they will appear here within 5 minutes.
                  </div>
                </div>
              ) : (
                <>
                  {/* Summary badges */}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
                    <span style={{ background: '#1C1C1E', color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: '600' }}>
                      {items.length} line item{items.length !== 1 ? 's' : ''}
                    </span>
                    <span style={{ background: '#F7F3EE', color: '#B8965A', padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: '500' }}>
                      {items.reduce((s, i) => s + (parseInt(i.quantity) || 0), 0)} total units
                    </span>
                  </div>

                  {/* Items list — mobile-friendly cards */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {items.map((item, i) => (
                      <div key={i} style={{ background: '#F7F3EE', borderRadius: '8px', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: '600', fontSize: '13.5px', color: '#1C1C1E' }}>{item.item_name}</div>
                          <div style={{ fontSize: '11.5px', color: '#6B6860', marginTop: '2px', textTransform: 'capitalize' }}>
                            {item.category}{item.item_type && item.item_type !== 'rental' ? ` · ${item.item_type}` : ''}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', fontWeight: '600', color: '#1C1C1E', lineHeight: 1 }}>
                            {item.quantity}
                          </div>
                          <div style={{ fontSize: '10px', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {item.unit || 'units'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '16px', textAlign: 'center' }}>
                    Synced from Current RMS opportunity items
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── CHANGES TAB ── */}
          {tab === 'changes' && (
            <div>
              <div style={S.sectionLabel}>Change History from Current RMS</div>
              {changes.length === 0 ? (
                <div style={{ color: '#9CA3AF', fontSize: '13px', padding: '16px' }}>No changes detected for this job</div>
              ) : changes.map(c => (
                <div key={c.id} style={{ ...S.changeCard, borderLeft: `4px solid ${c.is_urgent ? '#EF4444' : '#F59E0B'}`, marginBottom: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap' }}>
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
                    <button style={S.ackBtn} onClick={() => onAcknowledge(c.id)}>Acknowledge</button>
                  )}
                  {c.acknowledged_at && <span style={{ fontSize: '11px', color: '#22C55E' }}>✓ Acknowledged</span>}
                </div>
              ))}
            </div>
          )}

          {tab === 'notes' && job && (
            <div style={{ padding: '20px 24px' }}>
              <JobNotes
                jobId={job.id}
                jobTable='crms_jobs'
                crmsRef={job.crms_ref}
                eventName={job.event_name}
              />
            </div>
          )}

          {tab === 'evidence' && job && (
            <div style={{ padding: '20px 24px' }}>
              <EvidenceUpload
                jobId={job.id}
                jobTable='crms_jobs'
                crmsRef={job.crms_ref}
                eventName={job.event_name}
              />
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  syncBar:       { background: '#F7F3EE', border: '1px solid #DDD8CF', borderRadius: '6px', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' },
  urgentBanner:  { background: '#FEF2F2', border: '1.5px solid #EF4444', borderRadius: '6px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', fontSize: '13px', color: '#991B1B' },
  statsRow:      { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '24px' },
  statCard:      { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px 20px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(28,28,30,0.04)' },
  sectionLabel:  { fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B8965A', fontWeight: '600', marginBottom: '12px' },
  filterBar:     { display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' },
  searchInput:   { flex: 1, minWidth: '200px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none' },
  filterBtn:     { padding: '8px 14px', borderRadius: '4px', border: '1.5px solid #DDD8CF', background: 'transparent', color: '#6B6860', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  filterBtnActive: { background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  card:          { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(28,28,30,0.08)' },
  table:         { width: '100%', borderCollapse: 'collapse' },
  th:            { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '12px 16px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500', whiteSpace: 'nowrap' },
  td:            { padding: '13px 16px', fontSize: '13px', borderBottom: '1px solid #EDE8E0', verticalAlign: 'middle' },
  btnGhost:      { background: 'transparent', color: '#B8965A', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' },
  changeCard:    { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '6px', padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: '12px' },
  ackBtn:        { background: '#1C1C1E', color: 'white', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '11px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap', flexShrink: 0 },
  overlay:       { position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
  panel:         { background: '#fff', width: '100%', maxWidth: '680px', height: '100vh', display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 48px rgba(28,28,30,0.14)' },
  panelHeader:   { padding: '20px 24px', borderBottom: '1px solid #DDD8CF', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: '#F7F3EE', flexShrink: 0, gap: '12px' },
  closeBtn:      { background: '#DDD8CF', border: 'none', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '14px', color: '#1C1C1E', flexShrink: 0 },
  tabBtn:        { padding: '14px 16px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer', fontSize: '13px', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" },
  tabBtnActive:  { color: '#B8965A', borderBottomColor: '#B8965A', fontWeight: '600' },
  detailGrid:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
  detailItem:    { background: '#F7F3EE', borderRadius: '6px', padding: '12px' },
  detailLabel:   { fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '4px' },
  detailValue:   { fontSize: '13.5px', fontWeight: '500', color: '#1C1C1E' },
  divider:       { border: 'none', borderTop: '1px solid #DDD8CF', margin: '18px 0' },
}

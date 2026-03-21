import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts)
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const FILTERS = ['all', 'new', 'delivery', 'collection', 'cancelled']

export default function Notifications() {
  const [changes, setChanges]   = useState([])
  const [newJobs, setNewJobs]   = useState([])
  const [filter, setFilter]     = useState('all')
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    fetchAll()
    const channel = supabase.channel('notifications-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'change_log' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sync_log' }, fetchAll)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function fetchAll() {
    const [{ data: changesData }, { data: syncData }] = await Promise.all([
      supabase.from('change_log')
        .select('*')
        .order('detected_at', { ascending: false })
        .limit(50),
      supabase.from('sync_log')
        .select('*')
        .eq('event_type', 'job_created')
        .order('synced_at', { ascending: false })
        .limit(20),
    ])
    if (changesData) setChanges(changesData)
    if (syncData) setNewJobs(syncData)
    setLoading(false)
  }

  async function acknowledge(id) {
    await supabase.from('change_log')
      .update({ acknowledged_at: new Date().toISOString() })
      .eq('id', id)
    fetchAll()
  }

  async function acknowledgeAll() {
    await supabase.from('change_log')
      .update({ acknowledged_at: new Date().toISOString() })
      .is('acknowledged_at', null)
    fetchAll()
  }

  // Build unified notification list
  const allNotifs = [
    ...newJobs.map(j => ({
      id: `new-${j.id}`,
      type: 'new',
      title: j.description || 'New job confirmed',
      sub: `Confirmed in Current RMS · ${j.crms_id}`,
      time: j.synced_at,
      read: true,
    })),
    ...changes.map(c => ({
      id: c.id,
      type: c.field_changed?.includes('delivery') ? 'delivery'
          : c.field_changed?.includes('collection') ? 'collection'
          : c.field_changed?.includes('cancel') || c.crms_status === 'cancelled' ? 'cancelled'
          : 'other',
      title: `${c.field_changed?.replace(/_/g, ' ')} — ${c.event_name}`,
      sub: `${c.old_value || '(empty)'} → ${c.new_value} · ${c.job_ref}`,
      time: c.detected_at,
      read: !!c.acknowledged_at,
      changeId: c.id,
    })),
  ].sort((a, b) => new Date(b.time) - new Date(a.time))

  const filtered = allNotifs.filter(n => {
    if (filter === 'all') return true
    if (filter === 'new') return n.type === 'new'
    if (filter === 'delivery') return n.type === 'delivery'
    if (filter === 'collection') return n.type === 'collection'
    if (filter === 'cancelled') return n.type === 'cancelled'
    return true
  })

  const unreadCount = allNotifs.filter(n => !n.read).length

  const BADGE = {
    new:        { label: 'NEW JOB',            bg: '#EAF3DE', color: '#3B6D11' },
    delivery:   { label: 'DELIVERY CHANGED',   bg: '#FCEBEB', color: '#A32D2D' },
    collection: { label: 'COLLECTION CHANGED', bg: '#E6F1FB', color: '#0C447C' },
    cancelled:  { label: 'CANCELLED',          bg: '#FEF3C7', color: '#633806' },
    other:      { label: 'UPDATED',            bg: '#F1EFE8', color: '#5F5E5A' },
  }

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860' }}>Loading notifications…</div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Header bar */}
      <div style={S.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '13px', color: '#6B6860' }}>
            {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
          </span>
          {unreadCount > 0 && (
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#378ADD', display: 'inline-block' }} />
          )}
        </div>
        {unreadCount > 0 && (
          <button style={S.ackAllBtn} onClick={acknowledgeAll}>Mark all as read</button>
        )}
      </div>

      {/* Filters */}
      <div style={S.filterBar}>
        {FILTERS.map(f => (
          <button
            key={f}
            style={{ ...S.chip, ...(filter === f ? S.chipActive : {}) }}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'new' ? 'New jobs' : f === 'delivery' ? 'Delivery' : f === 'collection' ? 'Collection' : 'Cancelled'}
          </button>
        ))}
      </div>

      {/* Notification list */}
      <div style={S.card}>
        {filtered.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9CA3AF', fontSize: '13px' }}>
            No notifications
          </div>
        ) : filtered.map((n, i) => {
          const badge = BADGE[n.type] || BADGE.other
          return (
            <div key={n.id} style={{
              ...S.row,
              background: n.read ? 'transparent' : '#F7F9FF',
              borderBottom: i < filtered.length - 1 ? '0.5px solid #EDE8E0' : 'none',
            }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50', flexShrink: 0, marginTop: '5px',
                background: n.read ? '#DDD8CF' : '#378ADD',
                borderRadius: '50%',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ marginBottom: '3px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: '600', padding: '2px 7px',
                    borderRadius: '4px', marginRight: '8px',
                    background: badge.bg, color: badge.color,
                  }}>{badge.label}</span>
                </div>
                <div style={{ fontSize: '13px', fontWeight: '500', marginBottom: '2px' }}>{n.title}</div>
                <div style={{ fontSize: '11px', color: '#6B6860' }}>{n.sub}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: 0 }}>
                <span style={{ fontSize: '11px', color: '#9CA3AF' }}>{timeAgo(n.time)}</span>
                {!n.read && n.changeId && (
                  <button style={S.ackBtn} onClick={() => acknowledge(n.changeId)}>✓ Read</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const S = {
  topBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' },
  filterBar: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' },
  chip: { fontSize: '12px', padding: '6px 14px', borderRadius: '20px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  chipActive: { background: '#1C1C1E', color: '#fff', borderColor: '#1C1C1E' },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden' },
  row: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 16px' },
  ackBtn: { fontSize: '11px', padding: '3px 10px', borderRadius: '4px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  ackAllBtn: { fontSize: '12px', padding: '6px 14px', borderRadius: '4px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
}

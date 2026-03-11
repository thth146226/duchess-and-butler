import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Dashboard({ onNavigate }) {
  const [stats, setStats] = useState({ active: 0, deliveries: 0, collections: 0, pending: 0 })
  const [upcoming, setUpcoming] = useState([])
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const today = new Date().toISOString().split('T')[0]

    const { data: orders } = await supabase
      .from('orders')
      .select('*, users(name)')
      .not('status', 'eq', 'cancelled')
      .order('event_date', { ascending: true })
      .limit(10)

    if (orders) {
      setUpcoming(orders.slice(0, 5))
      setStats({
        active: orders.filter(o => ['confirmed','amended'].includes(o.status)).length,
        deliveries: orders.filter(o => o.delivery_date === today).length,
        collections: orders.filter(o => o.collection_date === today).length,
        pending: orders.filter(o => o.status === 'pending').length,
      })
    }

    const { data: logs } = await supabase
      .from('activity_log')
      .select('*, users(name)')
      .order('created_at', { ascending: false })
      .limit(5)

    if (logs) setActivity(logs)
    setLoading(false)
  }

  function formatDate(d) {
    if (!d) return '—'
    return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  function timeAgo(ts) {
    const diff = Date.now() - new Date(ts)
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  const statusStyle = {
    confirmed: { background: '#ECFDF5', color: '#065F46' },
    pending: { background: '#FFFBEB', color: '#92400E' },
    amended: { background: '#EFF6FF', color: '#1D4ED8' },
    cancelled: { background: '#FEF2F2', color: '#991B1B' },
    collected: { background: '#F5F3FF', color: '#5B21B6' },
  }

  if (loading) return <div style={styles.loading}>Loading dashboard…</div>

  return (
    <div>
      {/* Stats */}
      <div style={styles.statsGrid}>
        {[
          { label: 'Active Orders', value: stats.active, color: '#B8965A', sub: 'confirmed & amended' },
          { label: 'Deliveries Today', value: stats.deliveries, color: '#7A8C78', sub: 'scheduled for today' },
          { label: 'Collections Today', value: stats.collections, color: '#6B2D3E', sub: 'scheduled for today' },
          { label: 'Pending Review', value: stats.pending, color: '#3D5A73', sub: 'needs action' },
        ].map(s => (
          <div key={s.label} style={{ ...styles.statCard, borderTop: `3px solid ${s.color}` }}>
            <div style={styles.statLabel}>{s.label}</div>
            <div style={styles.statValue}>{s.value}</div>
            <div style={styles.statSub}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Main grid */}
      <div style={styles.mainGrid}>
        {/* Upcoming events */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Upcoming Events</div>
              <div style={styles.cardSub}>Next scheduled orders</div>
            </div>
            <button style={styles.linkBtn} onClick={() => onNavigate('orders')}>View all →</button>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                {['Event / Client','Date','Delivery','Collection','Status'].map(h => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {upcoming.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: '32px', color: '#6B6860' }}>No upcoming orders</td></tr>
              ) : upcoming.map(o => (
                <tr key={o.id}>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 500 }}>{o.event_name}</div>
                    <div style={{ fontSize: '11.5px', color: '#6B6860' }}>{o.client_name}</div>
                  </td>
                  <td style={styles.td}>{formatDate(o.event_date)}</td>
                  <td style={styles.td}>{formatDate(o.delivery_date)}<br /><small style={{ color: '#6B6860' }}>{o.delivery_time}</small></td>
                  <td style={styles.td}>{formatDate(o.collection_date)}<br /><small style={{ color: '#6B6860' }}>{o.collection_time}</small></td>
                  <td style={styles.td}>
                    <span style={{ ...styles.status, ...(statusStyle[o.status] || statusStyle.pending) }}>
                      {o.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Activity log */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div style={styles.cardTitle}>Activity Log</div>
          </div>
          {activity.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: '#6B6860' }}>No activity yet</div>
          ) : activity.map(a => (
            <div key={a.id} style={styles.timelineItem}>
              <div style={styles.dot} />
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 500 }}>{a.action}</div>
                <div style={{ fontSize: '11.5px', color: '#6B6860', marginTop: '3px' }}>
                  {timeAgo(a.created_at)} · by {a.users?.name || 'System'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const styles = {
  loading: { padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" },
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '28px' },
  statCard: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '22px 24px' },
  statLabel: { fontSize: '11px', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '10px' },
  statValue: { fontFamily: "'Cormorant Garamond', serif", fontSize: '36px', fontWeight: '600', color: '#1C1C1E', lineHeight: 1, marginBottom: '8px' },
  statSub: { fontSize: '12px', color: '#6B6860' },
  mainGrid: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px' },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(28,28,30,0.08)', marginBottom: '24px' },
  cardHeader: { padding: '20px 24px', borderBottom: '1px solid #DDD8CF', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontFamily: "'Cormorant Garamond', serif", fontSize: '18px', fontWeight: '600' },
  cardSub: { fontSize: '12.5px', color: '#6B6860', marginTop: '2px' },
  linkBtn: { background: 'none', border: 'none', color: '#6B6860', cursor: 'pointer', fontSize: '13px', fontFamily: "'DM Sans', sans-serif" },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '12px 24px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500' },
  td: { padding: '14px 24px', fontSize: '13.5px', borderBottom: '1px solid #EDE8E0', verticalAlign: 'middle' },
  status: { display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: '20px', fontSize: '11.5px', fontWeight: '500', textTransform: 'capitalize' },
  timelineItem: { display: 'flex', gap: '16px', padding: '16px 24px', borderBottom: '1px solid #EDE8E0', alignItems: 'flex-start' },
  dot: { width: '10px', height: '10px', borderRadius: '50%', background: '#B8965A', flexShrink: 0, marginTop: '5px' },
}

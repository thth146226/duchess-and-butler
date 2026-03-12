import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

const DEL_COLOR = { bg: '#FEF2F2', border: '#EF4444', text: '#991B1B', badge: '#EF4444' }
const COL_COLOR = { bg: '#F0FDF4', border: '#22C55E', text: '#166534', badge: '#22C55E' }

function getWeekDates(offset = 0) {
  const now = new Date()
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

function fmt(date) {
  return date.toISOString().split('T')[0]
}

function fmtDisplay(date) {
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

export default function Schedule() {
  const { profile } = useAuth()
  const [orders, setOrders] = useState([])
  const [drivers, setDrivers] = useState([])
  const [weekOffset, setWeekOffset] = useState(0)
  const [view, setView] = useState('week') // 'week' | 'list'
  const [editingRun, setEditingRun] = useState(null)
  const [toast, setToast] = useState(null)
  const [loading, setLoading] = useState(true)
  const weekDates = getWeekDates(weekOffset)
  const weekLabel = `${weekDates[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${weekDates[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  useEffect(() => {
    fetchOrders()
    fetchDrivers()

    // Real-time subscription — updates instantly for all users
    const channel = supabase
      .channel('orders-schedule')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        fetchOrders()
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [weekOffset])

  async function fetchOrders() {
    const from = fmt(weekDates[0])
    const to = fmt(weekDates[6])
    const { data } = await supabase
      .from('orders')
      .select('*, users(name)')
      .not('status', 'eq', 'cancelled')
      .or(`delivery_date.gte.${from},collection_date.gte.${from}`)
      .or(`delivery_date.lte.${to},collection_date.lte.${to}`)
    if (data) setOrders(data)
    setLoading(false)
  }

  async function fetchDrivers() {
    const { data } = await supabase.from('users').select('id, name').in('role', ['admin', 'driver', 'operations'])
    if (data) setDrivers(data)
  }

  // Build runs from orders — each order can have 1 DEL and 1 COL run
  function buildRuns() {
    const runs = []
    orders.forEach(o => {
      if (o.delivery_date) runs.push({ ...o, runType: 'DEL', runDate: o.delivery_date, runTime: o.delivery_time })
      if (o.collection_date) runs.push({ ...o, runType: 'COL', runDate: o.collection_date, runTime: o.collection_time })
    })
    return runs
  }

  function runsForDate(dateStr) {
    return buildRuns()
      .filter(r => r.runDate === dateStr)
      .sort((a, b) => (a.runTime || '').localeCompare(b.runTime || ''))
  }

  async function saveRunEdit(run, changes) {
    const update = {}
    if (run.runType === 'DEL') {
      if (changes.date) update.delivery_date = changes.date
      if (changes.time !== undefined) update.delivery_time = changes.time
    } else {
      if (changes.date) update.collection_date = changes.date
      if (changes.time !== undefined) update.collection_time = changes.time
    }
    if (changes.venue !== undefined) update.venue = changes.venue
    if (changes.postcode !== undefined) {
      update.venue = (changes.venue ?? run.venue ?? '').replace(/\s+[A-Z]{1,2}[0-9][0-9A-Z]?\s+[0-9][A-Z]{2}$/i, '').trim() + (changes.postcode ? ' ' + changes.postcode : '')
    }
    if (changes.notes !== undefined) update.notes = changes.notes
    if (changes.driver_id !== undefined) update.driver_id = changes.driver_id

    const { error } = await supabase.from('orders').update(update).eq('id', run.id)
    if (!error) {
      if (profile?.id) {
        await supabase.from('activity_log').insert({
          user_id: profile.id,
          action: `${run.runType} for ${run.event_name || run.client_name} updated`,
          entity_type: 'order', entity_id: run.id
        })
      }
      showToast('Schedule updated — visible to all team members instantly')
      await fetchOrders()
    }
    setEditingRun(null)
  }

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  function extractPostcode(venue) {
    if (!venue) return ''
    const match = venue.match(/[A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2}/i)
    return match ? match[0].toUpperCase() : ''
  }

  function extractVenueName(venue) {
    if (!venue) return ''
    return venue.replace(/\s+[A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2}$/i, '').trim()
  }

  // ─── RUN CARD ───
  function RunCard({ run }) {
    const colors = run.runType === 'DEL' ? DEL_COLOR : COL_COLOR
    const postcode = extractPostcode(run.venue)
    const venueName = extractVenueName(run.venue) || run.client_name
    const driverName = run.users?.name || drivers.find(d => d.id === run.driver_id)?.name

    return (
      <div
        style={{
          background: colors.bg,
          border: `1.5px solid ${colors.border}`,
          borderRadius: '6px',
          padding: '8px 10px',
          marginBottom: '6px',
          cursor: 'pointer',
          transition: 'box-shadow 0.15s',
        }}
        onClick={() => setEditingRun({ ...run, _postcode: postcode, _venueName: venueName })}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <span style={{
            background: colors.badge, color: 'white',
            fontSize: '10px', fontWeight: '700', padding: '2px 6px',
            borderRadius: '3px', letterSpacing: '0.06em', flexShrink: 0
          }}>{run.runType}</span>
          <span style={{ fontSize: '12.5px', fontWeight: '600', color: colors.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {run.event_name || run.client_name}
          </span>
        </div>
        {postcode && <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '2px' }}>📍 {postcode}</div>}
        {run.runTime && <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '2px' }}>🕐 {run.runTime}</div>}
        {driverName && <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '2px' }}>👤 {driverName}</div>}
        {run.notes && <div style={{ fontSize: '10.5px', color: colors.text, marginTop: '4px', fontStyle: 'italic' }}>{run.notes}</div>}
        <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: '4px' }}>tap to edit</div>
      </div>
    )
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>Loading schedule…</div>

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Controls */}
      <div style={styles.filterBar}>
        <button style={styles.btnOutline} onClick={() => setWeekOffset(w => w - 1)}>← Prev</button>
        <span style={styles.weekLabel}>{weekLabel}</span>
        <button style={styles.btnOutline} onClick={() => setWeekOffset(0)}>Today</button>
        <button style={styles.btnOutline} onClick={() => setWeekOffset(w => w + 1)}>Next →</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          <button style={{ ...styles.btnOutline, ...(view === 'week' ? styles.btnActive : {}) }} onClick={() => setView('week')}>📅 Week</button>
          <button style={{ ...styles.btnOutline, ...(view === 'list' ? styles.btnActive : {}) }} onClick={() => setView('list')}>☰ List</button>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
          <span style={{ background: '#EF4444', color: 'white', padding: '2px 8px', borderRadius: '3px', fontSize: '11px', fontWeight: '700' }}>DEL</span> Delivery
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
          <span style={{ background: '#22C55E', color: 'white', padding: '2px 8px', borderRadius: '3px', fontSize: '11px', fontWeight: '700' }}>COL</span> Collection
        </span>
        <span style={{ fontSize: '12px', color: '#6B6860', marginLeft: 'auto' }}>⚡ Live — changes visible to all instantly</span>
      </div>

      {/* WEEK VIEW */}
      {view === 'week' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
          {weekDates.map((date, i) => {
            const dateStr = fmt(date)
            const runs = runsForDate(dateStr)
            const isToday = fmt(new Date()) === dateStr
            return (
              <div key={i} style={{ minHeight: '120px' }}>
                <div style={{
                  background: isToday ? '#1C1C1E' : '#3D5A73',
                  color: 'white', padding: '8px', borderRadius: '6px',
                  textAlign: 'center', marginBottom: '8px',
                  border: isToday ? '2px solid #B8965A' : 'none'
                }}>
                  <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.7 }}>{DAYS[i].slice(0, 3)}</div>
                  <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '24px', fontWeight: '300' }}>{date.getDate()}</div>
                </div>
                {runs.length === 0
                  ? <div style={{ fontSize: '11px', color: '#D1D5DB', textAlign: 'center', padding: '8px' }}>—</div>
                  : runs.map((run, j) => <RunCard key={j} run={run} />)
                }
              </div>
            )
          })}
        </div>
      )}

      {/* LIST VIEW */}
      {view === 'list' && (
        <div>
          {weekDates.map((date, i) => {
            const dateStr = fmt(date)
            const runs = runsForDate(dateStr)
            const isToday = fmt(new Date()) === dateStr
            return (
              <div key={i} style={{ marginBottom: '16px' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 16px',
                  background: isToday ? '#1C1C1E' : '#F7F3EE',
                  color: isToday ? 'white' : '#1C1C1E',
                  borderRadius: '6px', marginBottom: '8px',
                  border: isToday ? '2px solid #B8965A' : '1px solid #DDD8CF'
                }}>
                  <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600' }}>
                    {DAYS[i]} {date.getDate()}
                  </span>
                  {isToday && <span style={{ fontSize: '11px', background: '#B8965A', padding: '2px 8px', borderRadius: '10px' }}>TODAY</span>}
                  <span style={{ marginLeft: 'auto', fontSize: '12px', opacity: 0.6 }}>{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
                </div>
                {runs.length === 0
                  ? <div style={{ padding: '12px 16px', fontSize: '13px', color: '#9CA3AF' }}>No runs scheduled</div>
                  : (
                    <div style={styles.card}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            {['D/C', 'Venue / Job', 'Postcode', 'Time', 'Driver', 'Notes', ''].map(h => (
                              <th key={h} style={styles.th}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {runs.map((run, j) => {
                            const colors = run.runType === 'DEL' ? DEL_COLOR : COL_COLOR
                            const postcode = extractPostcode(run.venue)
                            const venueName = extractVenueName(run.venue) || run.client_name
                            const driverName = run.users?.name || drivers.find(d => d.id === run.driver_id)?.name
                            return (
                              <tr key={j}>
                                <td style={styles.td}>
                                  <span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>
                                    {run.runType}
                                  </span>
                                </td>
                                <td style={styles.td}>
                                  <div style={{ fontWeight: 500 }}>{run.event_name || run.client_name}</div>
                                  <div style={{ fontSize: '11.5px', color: '#6B6860' }}>{venueName}</div>
                                </td>
                                <td style={{ ...styles.td, fontWeight: 600, color: colors.text }}>{postcode || '—'}</td>
                                <td style={styles.td}>{run.runTime || '—'}</td>
                                <td style={styles.td}>{driverName || <span style={{ color: '#D1D5DB' }}>TBC</span>}</td>
                                <td style={{ ...styles.td, fontSize: '12px', color: run.notes ? colors.text : '#D1D5DB', fontStyle: run.notes ? 'italic' : 'normal' }}>
                                  {run.notes || '—'}
                                </td>
                                <td style={styles.td}>
                                  <button style={styles.btnGhost} onClick={() => setEditingRun({ ...run, _postcode: postcode, _venueName: venueName })}>
                                    Edit
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </div>
            )
          })}
        </div>
      )}

      {/* EDIT MODAL */}
      {editingRun && (
        <EditRunModal
          run={editingRun}
          drivers={drivers}
          onSave={saveRunEdit}
          onClose={() => setEditingRun(null)}
        />
      )}

      {/* Toast */}
      {toast && <div style={styles.toast}>⚡ {toast}</div>}
    </div>
  )
}

function EditRunModal({ run, drivers, onSave, onClose }) {
  const colors = run.runType === 'DEL' ? DEL_COLOR : COL_COLOR
  const [date, setDate] = useState(run.runDate || '')
  const [time, setTime] = useState(run.runTime || '')
  const [venueName, setVenueName] = useState(run._venueName || '')
  const [postcode, setPostcode] = useState(run._postcode || '')
  const [notes, setNotes] = useState(run.notes || '')
  const [driverId, setDriverId] = useState(run.driver_id || '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave(run, { date, time, venue: venueName, postcode, notes, driver_id: driverId || null })
    setSaving(false)
  }

  return (
    <div style={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={styles.modal}>
        <div style={{ ...styles.modalHeader, borderBottom: `3px solid ${colors.border}` }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ background: colors.badge, color: 'white', fontSize: '12px', fontWeight: '700', padding: '4px 10px', borderRadius: '4px' }}>
                {run.runType}
              </span>
              <span style={styles.modalTitle}>{run.event_name || run.client_name}</span>
            </div>
            <div style={styles.modalSub}>Edit this {run.runType === 'DEL' ? 'delivery' : 'collection'} — updates instantly for all team members</div>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.modalBody}>
          <div style={styles.sectionLabel}>Date & Time</div>
          <div style={styles.formGrid2}>
            <div>
              <label style={styles.label}>{run.runType === 'DEL' ? 'Delivery' : 'Collection'} Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={styles.input} />
            </div>
            <div>
              <label style={styles.label}>Time</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} style={styles.input} />
            </div>
          </div>

          <hr style={styles.divider} />
          <div style={styles.sectionLabel}>Location</div>
          <div style={styles.formGrid2}>
            <div>
              <label style={styles.label}>Venue / Job Name</label>
              <input value={venueName} onChange={e => setVenueName(e.target.value)} placeholder="e.g. Moriarty Events" style={styles.input} />
            </div>
            <div>
              <label style={styles.label}>Postcode</label>
              <input value={postcode} onChange={e => setPostcode(e.target.value.toUpperCase())} placeholder="e.g. W1J 5PU" style={{ ...styles.input, fontWeight: '600', letterSpacing: '0.08em' }} />
            </div>
          </div>

          <hr style={styles.divider} />
          <div style={styles.sectionLabel}>Driver & Notes</div>
          <div style={styles.formGrid2}>
            <div>
              <label style={styles.label}>Assigned Driver</label>
              <select value={driverId} onChange={e => setDriverId(e.target.value)} style={styles.select}>
                <option value="">— TBC —</option>
                {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={styles.label}>Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. ** TIMED 8AM DELIVERY **" style={styles.input} />
            </div>
          </div>
        </div>

        <div style={styles.modalFooter}>
          <button style={styles.btnOutline} onClick={onClose}>Cancel</button>
          <button style={{ ...styles.btnPrimary, background: colors.badge }} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : `Save ${run.runType === 'DEL' ? 'Delivery' : 'Collection'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles = {
  filterBar: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' },
  weekLabel: { fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600', padding: '0 12px' },
  btnOutline: { background: 'transparent', color: '#1C1C1E', border: '1.5px solid #DDD8CF', borderRadius: '4px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnActive: { background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  btnGhost: { background: 'transparent', color: '#6B6860', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnPrimary: { background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', padding: '10px 24px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(28,28,30,0.08)', marginBottom: '8px' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '10px 16px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500' },
  td: { padding: '12px 16px', fontSize: '13.5px', borderBottom: '1px solid #EDE8E0', verticalAlign: 'middle' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
  modal: { background: '#fff', borderRadius: '8px', width: '100%', maxWidth: '560px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 48px rgba(28,28,30,0.14)' },
  modalHeader: { padding: '24px 28px 18px', borderBottom: '1px solid #DDD8CF', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', position: 'sticky', top: 0, background: '#fff', zIndex: 1 },
  modalTitle: { fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600' },
  modalSub: { fontSize: '12px', color: '#6B6860', marginTop: '4px' },
  closeBtn: { background: '#F7F3EE', border: 'none', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '14px', color: '#6B6860', flexShrink: 0 },
  modalBody: { padding: '24px 28px' },
  modalFooter: { padding: '16px 28px', borderTop: '1px solid #DDD8CF', display: 'flex', justifyContent: 'flex-end', gap: '10px', background: '#F7F3EE' },
  sectionLabel: { fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B8965A', fontWeight: '600', marginBottom: '12px' },
  formGrid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' },
  divider: { border: 'none', borderTop: '1px solid #DDD8CF', margin: '18px 0' },
  input: { fontFamily: "'DM Sans', sans-serif", fontSize: '13.5px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  select: { fontFamily: "'DM Sans', sans-serif", fontSize: '13px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  label: { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#1C1C1E', marginBottom: '6px' },
  toast: { position: 'fixed', bottom: '24px', right: '24px', background: '#1C1C1E', color: '#fff', padding: '14px 20px', borderRadius: '8px', fontSize: '13.5px', borderLeft: '3px solid #22C55E', boxShadow: '0 12px 48px rgba(28,28,30,0.14)', zIndex: 999 },
}

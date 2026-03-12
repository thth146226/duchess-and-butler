import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

const DEL_COLOR = { bg: '#FEF2F2', border: '#EF4444', text: '#991B1B', badge: '#EF4444' }
const COL_COLOR = { bg: '#F0FDF4', border: '#22C55E', text: '#166534', badge: '#22C55E' }

function getWeekDates(offset = 0) {
  const now = new Date()
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7)
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d })
}

function getMonthDates(year, month) {
  const first = new Date(year, month, 1)
  const last = new Date(year, month + 1, 0)
  const startDay = first.getDay() === 0 ? 6 : first.getDay() - 1
  const dates = []
  for (let i = 0; i < startDay; i++) dates.push(null)
  for (let d = 1; d <= last.getDate(); d++) dates.push(new Date(year, month, d))
  return dates
}

function fmt(date) { return date ? date.toISOString().split('T')[0] : '' }
const today = fmt(new Date())

export default function Schedule() {
  const { profile } = useAuth()
  const [orders, setOrders] = useState([])
  const [drivers, setDrivers] = useState([])
  const [view, setView] = useState('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthDate, setMonthDate] = useState(new Date())
  const [yearDate, setYearDate] = useState(new Date())
  const [editingRun, setEditingRun] = useState(null)
  const [toast, setToast] = useState(null)
  const [loading, setLoading] = useState(true)

  const weekDates = getWeekDates(weekOffset)
  const weekLabel = `${weekDates[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${weekDates[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  useEffect(() => {
    fetchAll()
    const channel = supabase.channel('schedule-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, fetchAll)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function fetchAll() {
    const { data } = await supabase.from('orders').select('*, users(name)').not('status', 'eq', 'cancelled')
    if (data) setOrders(data)
    const { data: d } = await supabase.from('users').select('id, name')
    if (d) setDrivers(d)
    setLoading(false)
  }

  function buildRuns() {
    const runs = []
    orders.forEach(o => {
      if (o.delivery_date) runs.push({ ...o, runType: 'DEL', runDate: o.delivery_date, runTime: o.delivery_time })
      if (o.collection_date) runs.push({ ...o, runType: 'COL', runDate: o.collection_date, runTime: o.collection_time })
    })
    return runs
  }

  function runsForDate(dateStr) {
    return buildRuns().filter(r => r.runDate === dateStr).sort((a, b) => (a.runTime || '').localeCompare(b.runTime || ''))
  }

  function runsForMonth(year, month) {
    return buildRuns().filter(r => { const d = new Date(r.runDate); return d.getFullYear() === year && d.getMonth() === month })
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

  async function saveRunEdit(run, changes) {
    const update = {}
    if (run.runType === 'DEL') {
      if (changes.date) update.delivery_date = changes.date
      if (changes.time !== undefined) update.delivery_time = changes.time
    } else {
      if (changes.date) update.collection_date = changes.date
      if (changes.time !== undefined) update.collection_time = changes.time
    }
    if (changes.venue !== undefined) update.venue = (changes.venue || '') + (changes.postcode ? ' ' + changes.postcode : '')
    if (changes.notes !== undefined) update.notes = changes.notes
    if (changes.driver_id !== undefined) update.driver_id = changes.driver_id || null
    const { error } = await supabase.from('orders').update(update).eq('id', run.id)
    if (!error) { showToast('Schedule updated — visible to all instantly'); fetchAll() }
    setEditingRun(null)
  }

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 3500) }

  function RunCard({ run, compact = false }) {
    const colors = run.runType === 'DEL' ? DEL_COLOR : COL_COLOR
    const postcode = extractPostcode(run.venue)
    const venueName = extractVenueName(run.venue) || run.client_name
    const driverName = run.users?.name || drivers.find(d => d.id === run.driver_id)?.name

    if (compact) return (
      <div onClick={() => setEditingRun({ ...run, _postcode: postcode, _venueName: venueName })}
        style={{ background: colors.bg, border: `1.5px solid ${colors.border}`, borderRadius: '4px', padding: '3px 6px', marginBottom: '3px', cursor: 'pointer', fontSize: '10px' }}>
        <span style={{ background: colors.badge, color: 'white', fontSize: '9px', fontWeight: '700', padding: '1px 4px', borderRadius: '2px', marginRight: '4px' }}>{run.runType}</span>
        <span style={{ fontWeight: '600', color: colors.text }}>{run.event_name || run.client_name}</span>
        {postcode && <span style={{ color: '#6B6860', marginLeft: '4px' }}>{postcode}</span>}
      </div>
    )

    return (
      <div onClick={() => setEditingRun({ ...run, _postcode: postcode, _venueName: venueName })}
        style={{ background: colors.bg, border: `1.5px solid ${colors.border}`, borderRadius: '6px', padding: '8px 10px', marginBottom: '6px', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' }}>{run.runType}</span>
          <span style={{ fontSize: '12.5px', fontWeight: '600', color: colors.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.event_name || run.client_name}</span>
        </div>
        {postcode && <div style={{ fontSize: '11px', color: '#6B6860' }}>📍 {postcode}</div>}
        {run.runTime && <div style={{ fontSize: '11px', color: '#6B6860' }}>🕐 {run.runTime}</div>}
        {driverName && <div style={{ fontSize: '11px', color: '#6B6860' }}>👤 {driverName}</div>}
        {run.notes && <div style={{ fontSize: '10.5px', color: colors.text, fontStyle: 'italic', marginTop: '4px' }}>{run.notes}</div>}
        <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: '4px' }}>tap to edit</div>
      </div>
    )
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>Loading schedule…</div>

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* View switcher */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {[['week','📅 Week'],['month','🗓 Month'],['year','📆 Year']].map(([v, label]) => (
          <button key={v} style={{ ...styles.btnOutline, ...(view === v ? styles.btnActive : {}) }} onClick={() => setView(v)}>{label}</button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6B6860' }}>⚡ Live — changes visible to all instantly</span>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
        {[['DEL','#EF4444','Delivery'],['COL','#22C55E','Collection']].map(([type, color, label]) => (
          <span key={type} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
            <span style={{ background: color, color: 'white', padding: '2px 8px', borderRadius: '3px', fontSize: '11px', fontWeight: '700' }}>{type}</span> {label}
          </span>
        ))}
      </div>

      {/* ── WEEK VIEW ── */}
      {view === 'week' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <button style={styles.btnOutline} onClick={() => setWeekOffset(w => w - 1)}>← Prev</button>
            <span style={styles.weekLabel}>{weekLabel}</span>
            <button style={styles.btnOutline} onClick={() => setWeekOffset(0)}>Today</button>
            <button style={styles.btnOutline} onClick={() => setWeekOffset(w => w + 1)}>Next →</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
            {weekDates.map((date, i) => {
              const dateStr = fmt(date)
              const runs = runsForDate(dateStr)
              const isToday = dateStr === today
              return (
                <div key={i}>
                  <div style={{ background: isToday ? '#1C1C1E' : '#3D5A73', color: 'white', padding: '8px', borderRadius: '6px', textAlign: 'center', marginBottom: '8px', border: isToday ? '2px solid #B8965A' : 'none' }}>
                    <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.7 }}>{DAYS[i].slice(0, 3)}</div>
                    <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '24px', fontWeight: '300' }}>{date.getDate()}</div>
                  </div>
                  {runs.length === 0 ? <div style={{ fontSize: '11px', color: '#D1D5DB', textAlign: 'center', padding: '8px' }}>—</div>
                    : runs.map((run, j) => <RunCard key={j} run={run} />)}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── MONTH VIEW ── */}
      {view === 'month' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <button style={styles.btnOutline} onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() - 1))}>← Prev</button>
            <span style={styles.weekLabel}>{MONTHS[monthDate.getMonth()]} {monthDate.getFullYear()}</span>
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
              {getMonthDates(monthDate.getFullYear(), monthDate.getMonth()).map((date, i) => {
                const dateStr = date ? fmt(date) : null
                const runs = dateStr ? runsForDate(dateStr) : []
                const isToday = dateStr === today
                return (
                  <div key={i} style={{ minHeight: '100px', padding: '6px', borderRight: '1px solid #EDE8E0', borderBottom: '1px solid #EDE8E0', background: isToday ? '#FFF8F0' : 'white' }}>
                    {date && <>
                      <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '18px', fontWeight: isToday ? '700' : '400', color: isToday ? '#B8965A' : '#1C1C1E', marginBottom: '4px' }}>{date.getDate()}</div>
                      {runs.map((run, j) => <RunCard key={j} run={run} compact />)}
                    </>}
                  </div>
                )
              })}
            </div>
          </div>
          <div style={styles.sectionLabel}>All runs — {MONTHS[monthDate.getMonth()]} {monthDate.getFullYear()}</div>
          {(() => {
            const runs = runsForMonth(monthDate.getFullYear(), monthDate.getMonth()).sort((a, b) => a.runDate.localeCompare(b.runDate))
            if (!runs.length) return <div style={{ color: '#9CA3AF', fontSize: '13px', padding: '16px' }}>No runs scheduled this month</div>
            return (
              <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>{['D/C','Date','Venue / Job','Postcode','Driver','Notes',''].map(h => <th key={h} style={styles.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {runs.map((run, i) => {
                      const colors = run.runType === 'DEL' ? DEL_COLOR : COL_COLOR
                      const postcode = extractPostcode(run.venue)
                      const venueName = extractVenueName(run.venue) || run.client_name
                      const driverName = run.users?.name || drivers.find(d => d.id === run.driver_id)?.name
                      return (
                        <tr key={i}>
                          <td style={styles.td}><span style={{ background: colors.badge, color: 'white', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '3px' }}>{run.runType}</span></td>
                          <td style={styles.td}>{new Date(run.runDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}{run.runTime && <div style={{ fontSize: '11px', color: '#6B6860' }}>{run.runTime}</div>}</td>
                          <td style={styles.td}><div style={{ fontWeight: 500 }}>{run.event_name || run.client_name}</div><div style={{ fontSize: '11px', color: '#6B6860' }}>{venueName}</div></td>
                          <td style={{ ...styles.td, fontWeight: 600, color: colors.text }}>{postcode || '—'}</td>
                          <td style={styles.td}>{driverName || <span style={{ color: '#D1D5DB' }}>TBC</span>}</td>
                          <td style={{ ...styles.td, fontSize: '12px', fontStyle: 'italic', color: run.notes ? colors.text : '#D1D5DB' }}>{run.notes || '—'}</td>
                          <td style={styles.td}><button style={styles.btnGhost} onClick={() => setEditingRun({ ...run, _postcode: postcode, _venueName: venueName })}>Edit</button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          })()}
        </>
      )}

      {/* ── YEAR VIEW ── */}
      {view === 'year' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
            <button style={styles.btnOutline} onClick={() => setYearDate(d => new Date(d.getFullYear() - 1, 0))}>← {yearDate.getFullYear() - 1}</button>
            <span style={styles.weekLabel}>{yearDate.getFullYear()}</span>
            <button style={styles.btnOutline} onClick={() => setYearDate(new Date())}>This Year</button>
            <button style={styles.btnOutline} onClick={() => setYearDate(d => new Date(d.getFullYear() + 1, 0))}>{yearDate.getFullYear() + 1} →</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
            {MONTHS.map((monthName, monthIdx) => {
              const runs = runsForMonth(yearDate.getFullYear(), monthIdx)
              const delCount = runs.filter(r => r.runType === 'DEL').length
              const colCount = runs.filter(r => r.runType === 'COL').length
              const isCurrentMonth = new Date().getFullYear() === yearDate.getFullYear() && new Date().getMonth() === monthIdx
              return (
                <div key={monthIdx} style={{ background: '#fff', border: `1.5px solid ${isCurrentMonth ? '#B8965A' : '#DDD8CF'}`, borderRadius: '8px', overflow: 'hidden' }}>
                  <div style={{ background: isCurrentMonth ? '#1C1C1E' : '#3D5A73', color: 'white', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '16px', fontWeight: '600' }}>{monthName}</span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {delCount > 0 && <span style={{ background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' }}>{delCount} DEL</span>}
                      {colCount > 0 && <span style={{ background: '#22C55E', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' }}>{colCount} COL</span>}
                    </div>
                  </div>
                  <div style={{ padding: '8px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: '4px' }}>
                      {['M','T','W','T','F','S','S'].map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: '9px', color: '#9CA3AF', padding: '2px' }}>{d}</div>)}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '1px' }}>
                      {getMonthDates(yearDate.getFullYear(), monthIdx).map((date, i) => {
                        if (!date) return <div key={i} />
                        const dateStr = fmt(date)
                        const dayRuns = runsForDate(dateStr)
                        const hasDel = dayRuns.some(r => r.runType === 'DEL')
                        const hasCol = dayRuns.some(r => r.runType === 'COL')
                        const isToday = dateStr === today
                        return (
                          <div key={i} onClick={() => { if (dayRuns.length > 0) { setView('month'); setMonthDate(new Date(yearDate.getFullYear(), monthIdx)) } }}
                            style={{ textAlign: 'center', padding: '3px 1px', borderRadius: '3px', cursor: dayRuns.length > 0 ? 'pointer' : 'default', background: isToday ? '#FFF8F0' : 'transparent', border: isToday ? '1px solid #B8965A' : '1px solid transparent' }}>
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
                  {runs.length > 0 && (
                    <div style={{ borderTop: '1px solid #EDE8E0', padding: '8px' }}>
                      {runs.sort((a, b) => a.runDate.localeCompare(b.runDate)).slice(0, 4).map((run, j) => {
                        const colors = run.runType === 'DEL' ? DEL_COLOR : COL_COLOR
                        return (
                          <div key={j} onClick={() => setEditingRun({ ...run, _postcode: extractPostcode(run.venue), _venueName: extractVenueName(run.venue) || run.client_name })}
                            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 0', borderBottom: j < Math.min(runs.length, 4) - 1 ? '1px solid #F7F3EE' : 'none', cursor: 'pointer' }}>
                            <span style={{ background: colors.badge, color: 'white', fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '2px', flexShrink: 0 }}>{run.runType}</span>
                            <span style={{ fontSize: '11px', color: '#1C1C1E', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.event_name || run.client_name}</span>
                            <span style={{ fontSize: '10px', color: '#9CA3AF', flexShrink: 0 }}>{new Date(run.runDate + 'T12:00:00').getDate()}</span>
                          </div>
                        )
                      })}
                      {runs.length > 4 && <div onClick={() => { setView('month'); setMonthDate(new Date(yearDate.getFullYear(), monthIdx)) }} style={{ fontSize: '10px', color: '#9CA3AF', textAlign: 'center', padding: '4px', cursor: 'pointer' }}>+{runs.length - 4} more →</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {editingRun && <EditRunModal run={editingRun} drivers={drivers} onSave={saveRunEdit} onClose={() => setEditingRun(null)} />}
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
              <span style={{ background: colors.badge, color: 'white', fontSize: '12px', fontWeight: '700', padding: '4px 10px', borderRadius: '4px' }}>{run.runType}</span>
              <span style={styles.modalTitle}>{run.event_name || run.client_name}</span>
            </div>
            <div style={styles.modalSub}>Edit this {run.runType === 'DEL' ? 'delivery' : 'collection'} — updates instantly for all</div>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={styles.modalBody}>
          <div style={styles.sectionLabel}>Date & Time</div>
          <div style={styles.formGrid2}>
            <div><label style={styles.label}>{run.runType === 'DEL' ? 'Delivery' : 'Collection'} Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} style={styles.input} /></div>
            <div><label style={styles.label}>Time</label><input type="time" value={time} onChange={e => setTime(e.target.value)} style={styles.input} /></div>
          </div>
          <hr style={styles.divider} />
          <div style={styles.sectionLabel}>Location</div>
          <div style={styles.formGrid2}>
            <div><label style={styles.label}>Venue / Job</label><input value={venueName} onChange={e => setVenueName(e.target.value)} style={styles.input} /></div>
            <div><label style={styles.label}>Postcode</label><input value={postcode} onChange={e => setPostcode(e.target.value.toUpperCase())} style={{ ...styles.input, fontWeight: '600', letterSpacing: '0.08em' }} /></div>
          </div>
          <hr style={styles.divider} />
          <div style={styles.sectionLabel}>Driver & Notes</div>
          <div style={styles.formGrid2}>
            <div><label style={styles.label}>Driver</label>
              <select value={driverId} onChange={e => setDriverId(e.target.value)} style={styles.select}>
                <option value="">— TBC —</option>
                {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}><label style={styles.label}>Notes</label><input value={notes} onChange={e => setNotes(e.target.value)} style={styles.input} /></div>
          </div>
        </div>
        <div style={styles.modalFooter}>
          <button style={styles.btnOutline} onClick={onClose}>Cancel</button>
          <button style={{ ...styles.btnPrimary, background: colors.badge }} onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : `Save ${run.runType === 'DEL' ? 'Delivery' : 'Collection'}`}</button>
        </div>
      </div>
    </div>
  )
}

const styles = {
  btnOutline: { background: 'transparent', color: '#1C1C1E', border: '1.5px solid #DDD8CF', borderRadius: '4px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnActive: { background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  btnGhost: { background: 'transparent', color: '#6B6860', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnPrimary: { background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', padding: '10px 24px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  weekLabel: { fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600', padding: '0 12px' },
  sectionLabel: { fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B8965A', fontWeight: '600', marginBottom: '12px' },
  th: { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '10px 16px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500' },
  td: { padding: '12px 16px', fontSize: '13px', borderBottom: '1px solid #EDE8E0', verticalAlign: 'middle' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
  modal: { background: '#fff', borderRadius: '8px', width: '100%', maxWidth: '560px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 48px rgba(28,28,30,0.14)' },
  modalHeader: { padding: '24px 28px 18px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', position: 'sticky', top: 0, background: '#fff', zIndex: 1 },
  modalTitle: { fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: '600' },
  modalSub: { fontSize: '12px', color: '#6B6860', marginTop: '4px' },
  closeBtn: { background: '#F7F3EE', border: 'none', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '14px', color: '#6B6860', flexShrink: 0 },
  modalBody: { padding: '24px 28px' },
  modalFooter: { padding: '16px 28px', borderTop: '1px solid #DDD8CF', display: 'flex', justifyContent: 'flex-end', gap: '10px', background: '#F7F3EE' },
  formGrid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' },
  divider: { border: 'none', borderTop: '1px solid #DDD8CF', margin: '18px 0' },
  input: { fontFamily: "'DM Sans', sans-serif", fontSize: '13.5px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  select: { fontFamily: "'DM Sans', sans-serif", fontSize: '13px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  label: { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#1C1C1E', marginBottom: '6px' },
  toast: { position: 'fixed', bottom: '24px', right: '24px', background: '#1C1C1E', color: '#fff', padding: '14px 20px', borderRadius: '8px', fontSize: '13.5px', borderLeft: '3px solid #22C55E', boxShadow: '0 12px 48px rgba(28,28,30,0.14)', zIndex: 999 },
}

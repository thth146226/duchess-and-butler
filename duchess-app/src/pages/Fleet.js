import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const EVENT_TYPES = [
  { value: 'mot', label: 'MOT', color: '#A32D2D', bg: '#FCEBEB' },
  { value: 'tax', label: 'Road tax', color: '#633806', bg: '#FEF3C7' },
  { value: 'insurance', label: 'Insurance', color: '#0C447C', bg: '#E6F1FB' },
  { value: 'service', label: 'Service', color: '#3B6D11', bg: '#EAF3DE' },
  { value: 'repair', label: 'Repair', color: '#7C2D12', bg: '#FFEDD5' },
  { value: 'breakdown', label: 'Breakdown / recovery', color: '#5B21B6', bg: '#EDE9FE' },
  { value: 'cleaning', label: 'Cleaning / valet', color: '#0F766E', bg: '#CCFBF1' },
  { value: 'other', label: 'Other', color: '#5F5E5A', bg: '#F7F3EE' },
]

function eventMeta(value) {
  return EVENT_TYPES.find(e => e.value === value) || EVENT_TYPES[EVENT_TYPES.length - 1]
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  })
}

function DateInputDMY({ value, onChange }) {
  const [day, setDay] = useState('')
  const [month, setMonth] = useState('')
  const [year, setYear] = useState('')

  useEffect(() => {
    if (value) {
      const [y, m, d] = value.split('-')
      setYear(y || '')
      setMonth(m || '')
      setDay(d || '')
    } else {
      setYear('')
      setMonth('')
      setDay('')
    }
  }, [value])

  function update(d, m, y) {
    if (d && m && y && y.length === 4) {
      onChange(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`)
    }
  }

  const inputStyle = {
    padding: '9px 8px',
    border: '1px solid #DDD8CF',
    borderRadius: '6px',
    fontSize: '13px',
    fontFamily: "'DM Sans', sans-serif",
    textAlign: 'center',
    boxSizing: 'border-box',
    width: '100%',
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '60px 60px 80px', gap: '6px' }}>
      <input type="number" min="1" max="31" placeholder="DD"
        value={day}
        onChange={e => { setDay(e.target.value); update(e.target.value, month, year) }}
        style={inputStyle} />
      <input type="number" min="1" max="12" placeholder="MM"
        value={month}
        onChange={e => { setMonth(e.target.value); update(day, e.target.value, year) }}
        style={inputStyle} />
      <input type="number" min="2020" max="2035" placeholder="YYYY"
        value={year}
        onChange={e => { setYear(e.target.value); update(day, month, e.target.value) }}
        style={inputStyle} />
    </div>
  )
}

function daysUntil(dateStr) {
  if (!dateStr) return null
  const end = new Date(dateStr + 'T12:00:00')
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)
  return Math.ceil((end - start) / 86400000)
}

export default function Fleet() {
  const { profile } = useAuth()
  const [vehicles, setVehicles] = useState([])
  const [events, setEvents] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(null)
  const [toast, setToast] = useState(null)
  const [savingVehicle, setSavingVehicle] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [newVehicleOpen, setNewVehicleOpen] = useState(false)
  const [newVehicle, setNewVehicle] = useState({
    registration: '',
    nickname: '',
    make: '',
    model: '',
    colour: '',
  })
  const [eventForm, setEventForm] = useState({
    event_type: 'service',
    event_date: new Date().toISOString().slice(0, 10),
    odometer_km: '',
    cost_gbp: '',
    vendor: '',
    notes: '',
  })
  const [notesDraft, setNotesDraft] = useState('')
  const selectedIdRef = useRef(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  const selected = vehicles.find(v => v.id === selectedId) || null

  useEffect(() => {
    setNotesDraft(selected?.notes || '')
  }, [selectedId, selected?.notes])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3200)
  }

  const fetchVehicles = useCallback(async () => {
    setListError(null)
    let q = supabase
      .from('fleet_vans')
      .select('*')
      .order('registration', { ascending: true })
    if (!showInactive) q = q.eq('active', true)
    const { data, error } = await q
    if (error) {
      setListError(error.message)
      setVehicles([])
    } else {
      setVehicles(data || [])
      setSelectedId(current => {
        if (current && !(data || []).some(v => v.id === current)) return null
        return current
      })
    }
    setLoading(false)
  }, [showInactive])

  async function fetchEvents(vehicleId) {
    if (!vehicleId) {
      setEvents([])
      return
    }
    const { data, error } = await supabase
      .from('fleet_events')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('event_date', { ascending: false })
    if (error) {
      showToast(error.message, 'error')
      setEvents([])
    } else {
      setEvents(data || [])
    }
  }

  useEffect(() => {
    fetchVehicles()
    const ch = supabase
      .channel('fleet-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet_vans' }, fetchVehicles)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet_events' }, () => {
        const id = selectedIdRef.current
        if (id) fetchEvents(id)
      })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [fetchVehicles])

  useEffect(() => {
    if (selectedId) fetchEvents(selectedId)
    else setEvents([])
  }, [selectedId])

  async function addVehicle(e) {
    e.preventDefault()
    const reg = newVehicle.registration.trim().toUpperCase()
    if (!reg) {
      showToast('Registration is required', 'error')
      return
    }
    setSavingVehicle(true)
    const { data, error } = await supabase
      .from('fleet_vans')
      .insert({
        registration: reg,
        nickname: newVehicle.nickname.trim() || null,
        make: newVehicle.make.trim() || null,
        model: newVehicle.model.trim() || null,
        colour: newVehicle.colour.trim() || null,
      })
      .select()
      .single()
    setSavingVehicle(false)
    if (error) {
      showToast(error.message, 'error')
      return
    }
    showToast('Vehicle added')
    setNewVehicleOpen(false)
    setNewVehicle({ registration: '', nickname: '', make: '', model: '', colour: '' })
    await fetchVehicles()
    if (data?.id) setSelectedId(data.id)
  }

  async function updateVehicleField(id, patch) {
    const { error } = await supabase.from('fleet_vans').update(patch).eq('id', id)
    if (error) showToast(error.message, 'error')
    else fetchVehicles()
  }

  async function deleteVehicle(id, name) {
    if (!window.confirm(`Remove ${name || 'this van'} from fleet?`)) return
    const { error } = await supabase
      .from('fleet_vans')
      .update({ active: false })
      .eq('id', id)
    if (error) showToast(error.message, 'error')
    else {
      showToast('Vehicle removed from fleet')
      if (selectedId === id) setSelectedId(null)
      fetchVehicles()
    }
  }

  async function addEvent(e) {
    e.preventDefault()
    if (!selectedId) return
    setSavingEvent(true)
    const odo = eventForm.odometer_km === '' ? null : parseInt(eventForm.odometer_km, 10)
    const cost = eventForm.cost_gbp === '' ? null : parseFloat(eventForm.cost_gbp)
    const { error } = await supabase.from('fleet_events').insert({
      vehicle_id: selectedId,
      event_type: eventForm.event_type,
      event_date: eventForm.event_date,
      odometer_km: Number.isFinite(odo) ? odo : null,
      cost_gbp: Number.isFinite(cost) ? cost : null,
      vendor: eventForm.vendor.trim() || null,
      notes: eventForm.notes.trim() || null,
      created_by: profile?.id || null,
    })
    setSavingEvent(false)
    if (error) {
      showToast(error.message, 'error')
      return
    }
    showToast('Event logged')
    setEventForm({
      event_type: 'service',
      event_date: new Date().toISOString().slice(0, 10),
      odometer_km: '',
      cost_gbp: '',
      vendor: '',
      notes: '',
    })
    fetchEvents(selectedId)
    fetchVehicles()
  }

  async function deleteEvent(id) {
    if (!window.confirm('Remove this event?')) return
    const { error } = await supabase.from('fleet_events').delete().eq('id', id)
    if (error) showToast(error.message, 'error')
    else {
      showToast('Event removed')
      fetchEvents(selectedId)
    }
  }

  function complianceBadge(label, dateStr) {
    const d = daysUntil(dateStr)
    if (dateStr == null || dateStr === '') {
      return (
        <span style={{ fontSize: '11px', color: '#9CA3AF' }}>{label}: —</span>
      )
    }
    let tone = '#3B6D11'
    let bg = '#ECFDF5'
    if (d < 0) { tone = '#A32D2D'; bg = '#FCEBEB' }
    else if (d <= 14) { tone = '#633806'; bg = '#FEF3C7' }
    else if (d <= 60) { tone = '#0C447C'; bg = '#E6F1FB' }
    return (
      <span style={{ fontSize: '11px', fontWeight: '600', color: tone, background: bg, padding: '3px 8px', borderRadius: '6px' }}>
        {label}: {fmtDate(dateStr)} ({d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? 'today' : `${d}d`})
      </span>
    )
  }

  const visibleVehicles = vehicles

  if (loading) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
        Loading fleet…
      </div>
    )
  }

  if (listError) {
    return (
      <div style={{ padding: '32px', maxWidth: '560px', fontFamily: "'DM Sans', sans-serif" }}>
        <h1 style={S.h1}>Fleet</h1>
        <p style={{ color: '#A32D2D', fontSize: '14px', lineHeight: 1.6 }}>
          Could not load fleet data: {listError}
        </p>
        <p style={{ color: '#6B6860', fontSize: '13px', lineHeight: 1.6, marginTop: '12px' }}>
          Create the <code style={{ fontSize: '12px' }}>fleet_vans</code> and <code style={{ fontSize: '12px' }}>fleet_events</code> tables in Supabase (with RLS for authenticated users), then refresh.
        </p>
      </div>
    )
  }

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", color: '#1C1C1E', paddingBottom: '48px' }}>
      {toast && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: 200,
          padding: '12px 18px',
          borderRadius: '8px',
          fontSize: '13px',
          fontWeight: '500',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          background: toast.type === 'error' ? '#FCEBEB' : '#ECFDF5',
          color: toast.type === 'error' ? '#A32D2D' : '#065F46',
          border: `1px solid ${toast.type === 'error' ? '#FCA5A5' : '#BBF7D0'}`,
        }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px', marginBottom: '20px' }}>
        <div>
          <h1 style={S.h1}>Fleet management</h1>
          <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#6B6860', maxWidth: '520px', lineHeight: 1.5 }}>
            Compliance dates, history, and maintenance log for company vehicles.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '12px', color: '#6B6860', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show archived
          </label>
          <button type="button" onClick={() => setNewVehicleOpen(o => !o)} style={S.btnPrimary}>
            {newVehicleOpen ? 'Cancel' : '+ Add vehicle'}
          </button>
        </div>
      </div>

      {newVehicleOpen && (
        <form onSubmit={addVehicle} style={S.card} className="fleet-new-vehicle">
          <div style={S.cardTitle}>New vehicle</div>
          <div style={S.formGrid}>
            <label style={S.label}>
              Registration *
              <input
                style={S.input}
                value={newVehicle.registration}
                onChange={e => setNewVehicle(v => ({ ...v, registration: e.target.value }))}
                placeholder="AB12 CDE"
              />
            </label>
            <label style={S.label}>
              Nickname
              <input style={S.input} value={newVehicle.nickname} onChange={e => setNewVehicle(v => ({ ...v, nickname: e.target.value }))} />
            </label>
            <label style={S.label}>
              Make
              <input style={S.input} value={newVehicle.make} onChange={e => setNewVehicle(v => ({ ...v, make: e.target.value }))} />
            </label>
            <label style={S.label}>
              Model
              <input style={S.input} value={newVehicle.model} onChange={e => setNewVehicle(v => ({ ...v, model: e.target.value }))} />
            </label>
            <label style={S.label}>
              Colour
              <input style={S.input} value={newVehicle.colour} onChange={e => setNewVehicle(v => ({ ...v, colour: e.target.value }))} />
            </label>
          </div>
          <button type="submit" disabled={savingVehicle} style={{ ...S.btnPrimary, marginTop: '12px', opacity: savingVehicle ? 0.7 : 1 }}>
            {savingVehicle ? 'Saving…' : 'Save vehicle'}
          </button>
        </form>
      )}

      <div style={S.layout} className="fleet-layout">
        <aside style={S.listPanel}>
          <div style={{ fontSize: '11px', fontWeight: '600', letterSpacing: '0.08em', color: '#6B6860', marginBottom: '10px' }}>VEHICLES ({visibleVehicles.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '70vh', overflowY: 'auto' }}>
            {visibleVehicles.length === 0 && (
              <div style={{ fontSize: '13px', color: '#9CA3AF', padding: '12px 0' }}>No vehicles yet.</div>
            )}
            {visibleVehicles.map(v => {
              const active = v.id === selectedId
              const muted = v.active === false
              return (
                <div key={v.id} style={{ display: 'flex', gap: '6px', alignItems: 'stretch' }}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(v.id)}
                    style={{
                      ...S.listItem,
                      flex: 1,
                      minWidth: 0,
                      borderColor: active ? '#3D5A73' : '#DDD8CF',
                      background: active ? '#F0F4F7' : '#fff',
                      opacity: muted ? 0.65 : 1,
                    }}
                  >
                    <div style={{ fontWeight: '600', fontSize: '14px' }}>{v.registration}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px' }}>
                      {[v.nickname, v.make, v.model].filter(Boolean).join(' · ') || '—'}
                    </div>
                    {muted && <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: '4px' }}>Archived</div>}
                  </button>
                  {v.active !== false && (
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); deleteVehicle(v.id, v.nickname || v.registration) }}
                      style={{
                        fontSize: '11px',
                        padding: '5px 12px',
                        borderRadius: '6px',
                        border: '1px solid #FECACA',
                        background: '#FEF2F2',
                        color: '#DC2626',
                        cursor: 'pointer',
                        fontFamily: "'DM Sans', sans-serif",
                        fontWeight: '500',
                        alignSelf: 'center',
                        flexShrink: 0,
                      }}
                    >Remove</button>
                  )}
                </div>
              )
            })}
          </div>
        </aside>

        <section style={S.detailPanel}>
          {!selected && (
            <div style={S.empty}>Select a vehicle or add one to get started.</div>
          )}
          {selected && (
            <>
              <div style={S.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                  <div>
                    <div style={S.cardTitle}>{selected.registration}</div>
                    <div style={{ fontSize: '13px', color: '#6B6860', marginTop: '4px' }}>
                      {[selected.make, selected.model, selected.colour].filter(Boolean).join(' · ') || '—'}
                      {selected.nickname ? ` · “${selected.nickname}”` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateVehicleField(selected.id, { active: selected.active === false })}
                    style={selected.active === false ? S.btnSecondary : { ...S.btnSecondary, color: '#A32D2D', borderColor: '#FCA5A5' }}
                  >
                    {selected.active === false ? 'Restore vehicle' : 'Archive vehicle'}
                  </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' }}>
                  {complianceBadge('MOT', selected.mot_expiry)}
                  {complianceBadge('Tax', selected.tax_expiry)}
                  {complianceBadge('Insurance', selected.insurance_expiry)}
                </div>

                <div style={{ ...S.formGrid, marginTop: '18px' }}>
                  <label style={S.label}>
                    MOT expiry
                    <DateInputDMY
                      value={selected.mot_expiry || ''}
                      onChange={val => updateVehicleField(selected.id, { mot_expiry: val || null })}
                    />
                  </label>
                  <label style={S.label}>
                    Tax expiry
                    <DateInputDMY
                      value={selected.tax_expiry || ''}
                      onChange={val => updateVehicleField(selected.id, { tax_expiry: val || null })}
                    />
                  </label>
                  <label style={S.label}>
                    Insurance expiry
                    <DateInputDMY
                      value={selected.insurance_expiry || ''}
                      onChange={val => updateVehicleField(selected.id, { insurance_expiry: val || null })}
                    />
                  </label>
                  <label style={S.label}>
                    Last recorded mileage
                    <input
                      type="number"
                      style={S.input}
                      key={`mileage-${selected.id}`}
                      defaultValue={selected.mileage_last_recorded ?? ''}
                      onBlur={e => {
                        const raw = e.target.value.trim()
                        const v = raw === '' ? null : parseInt(raw, 10)
                        if (Number.isNaN(v) && raw !== '') return
                        if (v !== selected.mileage_last_recorded) updateVehicleField(selected.id, { mileage_last_recorded: v })
                      }}
                    />
                  </label>
                  <label style={{ ...S.label, gridColumn: '1 / -1' }}>
                    Notes
                    <textarea
                      style={{ ...S.input, minHeight: '72px', resize: 'vertical' }}
                      value={notesDraft}
                      onChange={e => setNotesDraft(e.target.value)}
                      onBlur={() => {
                        const t = notesDraft.trim()
                        if (t !== (selected.notes || '').trim()) updateVehicleField(selected.id, { notes: t || null })
                      }}
                    />
                  </label>
                </div>
                <p style={{ fontSize: '11px', color: '#9CA3AF', margin: '10px 0 0' }}>
                  Compliance dates save when changed. Mileage and notes save when you leave the field.
                </p>
              </div>

              <div style={{ ...S.card, marginTop: '16px' }}>
                <div style={S.cardTitle}>Log event</div>
                <form onSubmit={addEvent} style={S.formGrid}>
                  <label style={S.label}>
                    Type
                    <select
                      style={S.input}
                      value={eventForm.event_type}
                      onChange={e => setEventForm(f => ({ ...f, event_type: e.target.value }))}
                    >
                      {EVENT_TYPES.map(et => (
                        <option key={et.value} value={et.value}>{et.label}</option>
                      ))}
                    </select>
                  </label>
                  <label style={S.label}>
                    Date
                    <DateInputDMY
                      value={eventForm.event_date}
                      onChange={val => setEventForm(f => ({ ...f, event_date: val }))}
                    />
                  </label>
                  <label style={S.label}>
                    Odometer (km)
                    <input
                      style={S.input}
                      value={eventForm.odometer_km}
                      onChange={e => setEventForm(f => ({ ...f, odometer_km: e.target.value }))}
                      placeholder="Optional"
                    />
                  </label>
                  <label style={S.label}>
                    Cost (£)
                    <input
                      style={S.input}
                      value={eventForm.cost_gbp}
                      onChange={e => setEventForm(f => ({ ...f, cost_gbp: e.target.value }))}
                      placeholder="Optional"
                    />
                  </label>
                  <label style={S.label}>
                    Vendor / garage
                    <input style={S.input} value={eventForm.vendor} onChange={e => setEventForm(f => ({ ...f, vendor: e.target.value }))} />
                  </label>
                  <label style={{ ...S.label, gridColumn: '1 / -1' }}>
                    Notes
                    <textarea style={{ ...S.input, minHeight: '64px' }} value={eventForm.notes} onChange={e => setEventForm(f => ({ ...f, notes: e.target.value }))} />
                  </label>
                  <button type="submit" disabled={savingEvent} style={{ ...S.btnPrimary, opacity: savingEvent ? 0.7 : 1 }}>
                    {savingEvent ? 'Saving…' : 'Add event'}
                  </button>
                </form>
              </div>

              <div style={{ marginTop: '20px' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', letterSpacing: '0.08em', color: '#6B6860', marginBottom: '10px' }}>HISTORY</div>
                {events.length === 0 && <div style={{ fontSize: '13px', color: '#9CA3AF' }}>No events logged yet.</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {events.map(ev => {
                    const m = eventMeta(ev.event_type)
                    return (
                      <div key={ev.id} style={{ ...S.eventRow, borderLeftColor: m.color }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                          <div>
                            <span style={{ fontSize: '12px', fontWeight: '600', color: m.color, background: m.bg, padding: '2px 8px', borderRadius: '4px' }}>{m.label}</span>
                            <span style={{ fontSize: '13px', marginLeft: '10px', fontWeight: '500' }}>{fmtDate(ev.event_date)}</span>
                          </div>
                          <button type="button" onClick={() => deleteEvent(ev.id)} style={S.iconBtn}>Remove</button>
                        </div>
                        <div style={{ fontSize: '12px', color: '#6B6860', marginTop: '6px' }}>
                          {[ev.odometer_km != null && `${ev.odometer_km.toLocaleString()} km`, ev.cost_gbp != null && `£${Number(ev.cost_gbp).toFixed(2)}`, ev.vendor].filter(Boolean).join(' · ')}
                        </div>
                        {ev.notes && <div style={{ fontSize: '13px', marginTop: '8px', lineHeight: 1.5 }}>{ev.notes}</div>}
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .fleet-layout { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  )
}

const S = {
  h1: { fontFamily: "'Cormorant Garamond', serif", fontSize: '28px', fontWeight: '600', margin: 0, color: '#1C1C1E' },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: '20px', alignItems: 'start' },
  listPanel: { minWidth: 0 },
  detailPanel: { minWidth: 0 },
  listItem: {
    textAlign: 'left',
    padding: '12px 14px',
    borderRadius: '8px',
    border: '1.5px solid #DDD8CF',
    background: '#fff',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  },
  card: {
    background: '#fff',
    border: '1px solid #DDD8CF',
    borderRadius: '10px',
    padding: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  cardTitle: { fontFamily: "'Cormorant Garamond', serif", fontSize: '18px', fontWeight: '600' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' },
  label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: '600', color: '#5F5E5A', letterSpacing: '0.03em' },
  input: {
    padding: '8px 10px',
    border: '1.5px solid #DDD8CF',
    borderRadius: '6px',
    fontSize: '13px',
    fontFamily: "'DM Sans', sans-serif",
    outline: 'none',
    boxSizing: 'border-box',
    width: '100%',
  },
  btnPrimary: {
    padding: '10px 18px',
    background: '#3D5A73',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  },
  btnSecondary: {
    padding: '8px 14px',
    background: '#fff',
    color: '#3D5A73',
    border: '1.5px solid #DDD8CF',
    borderRadius: '8px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  },
  empty: { padding: '48px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px', border: '1px dashed #DDD8CF', borderRadius: '10px' },
  eventRow: {
    background: '#fff',
    border: '1px solid #EDE8E0',
    borderLeft: '4px solid #3D5A73',
    borderRadius: '8px',
    padding: '12px 14px',
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#9CA3AF',
    fontSize: '11px',
    cursor: 'pointer',
    textDecoration: 'underline',
    padding: 0,
    fontFamily: "'DM Sans', sans-serif",
  },
}

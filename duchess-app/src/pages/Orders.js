import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const STATUS_OPTIONS = ['pending', 'confirmed', 'amended', 'cancelled', 'collected']
const CATEGORY_OPTIONS = ['crockery', 'cutlery', 'glassware', 'linens', 'furniture', 'other']
const JOB_TYPE_OPTIONS = [
  { value: 'both',       label: 'Delivery & Collection' },
  { value: 'delivery',   label: 'Delivery Only' },
  { value: 'collection', label: 'Collection Only' },
]

const STATUS_STYLE = {
  confirmed: { bg: '#ECFDF5', color: '#065F46' },
  pending:   { bg: '#FFFBEB', color: '#92400E' },
  amended:   { bg: '#EFF6FF', color: '#1D4ED8' },
  cancelled: { bg: '#FEF2F2', color: '#991B1B' },
  collected: { bg: '#F5F3FF', color: '#5B21B6' },
}

const emptyOrder = {
  event_name: '', client_name: '', venue: '', event_date: '',
  delivery_date: '', delivery_time: '', collection_date: '', collection_time: '',
  assigned_driver_id: '', status: 'pending', notes: '', special_instructions: '',
  job_type: 'both',
}

function fmt(d) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function Orders() {
  const { profile } = useAuth()
  const [orders, setOrders]       = useState([])
  const [drivers, setDrivers]     = useState([])
  const [search, setSearch]       = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [loading, setLoading]     = useState(true)
  const [modalOpen, setModal]     = useState(false)
  const [editOrder, setEditOrder] = useState(null)
  const [form, setForm]           = useState(emptyOrder)
  const [items, setItems]         = useState([{ item_name: '', category: 'crockery', quantity: '' }])
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState(null)
  const [deleteTarget, setDel]    = useState(null)   // order to confirm-delete
  const [deleting, setDeleting]   = useState(false)

  useEffect(() => { fetchOrders(); fetchDrivers() }, [])

  async function fetchOrders() {
    const { data, error } = await supabase
      .from('orders')
      .select('*, users(name)')
      .eq('deleted', false)
      .order('event_date', { ascending: true })
    console.log('Orders fetched:', data?.length, 'Error:', error)
    if (data) setOrders(data)
    setLoading(false)
  }

  async function fetchDrivers() {
    const { data } = await supabase
      .from('drivers')
      .select('id, name, colour')
      .eq('active', true)
      .order('name')
    if (data) setDrivers(data)
  }

  // ── Open / close modal ──────────────────────────────────────────────────────

  function openNew() {
    setEditOrder(null)
    setForm(emptyOrder)
    setItems([{ item_name: '', category: 'crockery', quantity: '' }])
    setModal(true)
  }

  async function openEdit(order) {
    setEditOrder(order)
    setForm({
      event_name:            order.event_name            || '',
      client_name:           order.client_name           || '',
      venue:                 order.venue                 || '',
      event_date:            order.event_date            || '',
      delivery_date:         order.delivery_date         || '',
      delivery_time:         order.delivery_time         || '',
      collection_date:       order.collection_date       || '',
      collection_time:       order.collection_time       || '',
      assigned_driver_id:    order.assigned_driver_id    || '',
      status:                order.status                || 'pending',
      notes:                 order.notes                 || '',
      special_instructions:  order.special_instructions  || '',
      job_type:              order.job_type              || 'both',
    })
    const { data: orderItems } = await supabase.from('order_items').select('*').eq('order_id', order.id)
    setItems(orderItems?.length ? orderItems : [{ item_name: '', category: 'crockery', quantity: '' }])
    setModal(true)
  }

  // ── Save (create / update) ──────────────────────────────────────────────────

  async function saveOrder() {
    if (!form.event_name || !form.client_name) {
      showToast('Please fill in Event Name and Client Name', 'error'); return
    }
    setSaving(true)

    // Resolve driver name for denormalised column
    const driver = drivers.find(d => d.id === form.assigned_driver_id)
    const orderData = {
      ...form,
      assigned_driver_name: driver?.name || null,
      assigned_by:          form.assigned_driver_id ? profile?.id : null,
      assigned_at:          form.assigned_driver_id ? new Date().toISOString() : null,
    }

    if (editOrder) {
      const { error } = await supabase.from('orders').update(orderData).eq('id', editOrder.id)
      if (!error) {
        await supabase.from('order_items').delete().eq('order_id', editOrder.id)
        const valid = items.filter(i => i.item_name)
        if (valid.length) await supabase.from('order_items').insert(valid.map(i => ({ ...i, order_id: editOrder.id })))
        await log(`Order updated: ${form.event_name}`, 'order', editOrder.id)
        showToast('Order updated successfully')
      } else {
        showToast('Error updating order', 'error')
      }
    } else {
      const { data, error } = await supabase.from('orders').insert({ ...orderData, deleted: false }).select().single()
      if (!error && data) {
        const valid = items.filter(i => i.item_name)
        if (valid.length) await supabase.from('order_items').insert(valid.map(i => ({ ...i, order_id: data.id })))
        await log(`New order created: ${form.event_name}`, 'order', data.id)
        showToast('Order created successfully')
      } else {
        showToast('Error creating order', 'error')
      }
    }
    await fetchOrders()
    setModal(false)
    setSaving(false)
  }

  // ── Soft delete ─────────────────────────────────────────────────────────────

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const { error } = await supabase
      .from('orders')
      .update({
        deleted:    true,
        deleted_at: new Date().toISOString(),
        deleted_by: profile?.id || null,
        status:     'cancelled',
      })
      .eq('id', deleteTarget.id)

    if (!error) {
      await log(`Order deleted: ${deleteTarget.event_name}`, 'order', deleteTarget.id)
      showToast(`"${deleteTarget.event_name}" has been removed`)
      await fetchOrders()
    } else {
      showToast('Error deleting order', 'error')
    }
    setDel(null)
    setDeleting(false)
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async function log(action, entity_type, entity_id) {
    if (!profile?.id) return
    await supabase.from('activity_log').insert({ action, entity_type, entity_id, user_id: profile.id })
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const filtered = orders.filter(o => {
    const s = !search || [o.event_name, o.client_name, o.venue, o.ref]
      .some(f => f?.toLowerCase().includes(search.toLowerCase()))
    const st = statusFilter === 'all' || o.status === statusFilter
    return s && st
  })

  const driverById = drivers.reduce((m, d) => ({ ...m, [d.id]: d }), {})

  if (loading) return (
    <div style={{ padding: '48px', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading orders…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* ── Filter bar ── */}
      <div style={S.filterBar}>
        <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
          <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#6B6860' }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search orders, clients, venues…"
            style={{ ...S.input, paddingLeft: '36px' }} />
        </div>
        <select value={statusFilter} onChange={e => setStatus(e.target.value)} style={{ ...S.select, width: 'auto' }}>
          <option value="all">All Statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        <button style={S.btnPrimary} onClick={openNew}>＋ New Order</button>
      </div>

      {/* ── Table ── */}
      <div style={S.card}>
        <table style={S.table}>
          <thead>
            <tr>
              {['Ref', 'Event / Client', 'Venue', 'Delivery', 'Collection', 'Driver', 'Status', ''].map(h => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: '48px', color: '#9CA3AF', fontSize: '14px' }}>No orders found</td></tr>
            ) : filtered.map(o => {
              const ss = STATUS_STYLE[o.status] || STATUS_STYLE.pending
              const drv = o.assigned_driver_id ? driverById[o.assigned_driver_id] : null
              return (
                <tr key={o.id} style={{ borderBottom: '1px solid #EDE8E0' }}>
                  <td style={S.td}>
                    <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '15px', fontWeight: '600', color: '#B8965A' }}>{o.ref || '—'}</span>
                  </td>
                  <td style={S.td}>
                    <div style={{ fontWeight: 500 }}>{o.event_name}</div>
                    <div style={{ fontSize: '11.5px', color: '#6B6860' }}>{o.client_name}</div>
                  </td>
                  <td style={{ ...S.td, fontSize: '12px', color: '#6B6860', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.venue || '—'}</td>
                  <td style={S.td}>
                    {o.delivery_date ? (
                      <><span style={S.delBadge}>DEL</span><br />{fmt(o.delivery_date)}<br /><small style={{ color: '#6B6860' }}>{o.delivery_time || ''}</small></>
                    ) : '—'}
                  </td>
                  <td style={S.td}>
                    {o.collection_date ? (
                      <><span style={S.colBadge}>COL</span><br />{fmt(o.collection_date)}<br /><small style={{ color: '#6B6860' }}>{o.collection_time || ''}</small></>
                    ) : '—'}
                  </td>
                  <td style={S.td}>
                    {drv
                      ? <span style={{ background: drv.colour || '#3D5A73', color: 'white', padding: '3px 10px', borderRadius: '12px', fontSize: '11.5px', fontWeight: '600' }}>{drv.name}</span>
                      : <span style={{ color: '#D1D5DB', fontSize: '12px' }}>Unassigned</span>}
                  </td>
                  <td style={S.td}>
                    <span style={{ ...S.badge, background: ss.bg, color: ss.color }}>{o.status}</span>
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    <button style={S.btnGhost} onClick={() => openEdit(o)}>Edit</button>
                    <button style={{ ...S.btnGhost, color: '#EF4444' }} onClick={() => setDel(o)}>Delete</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Create / Edit Modal ── */}
      {modalOpen && (
        <div style={S.overlay} onClick={e => e.target === e.currentTarget && setModal(false)}>
          <div style={S.modal}>

            {/* Header */}
            <div style={S.modalHeader}>
              <div>
                <div style={S.modalTitle}>{editOrder ? 'Edit Order' : 'New Order'}</div>
                <div style={S.modalSub}>{editOrder ? editOrder.ref : 'Fill in the details below'}</div>
              </div>
              <button style={S.closeBtn} onClick={() => setModal(false)}>✕</button>
            </div>

            <div style={S.modalBody}>

              {/* Client & Event */}
              <div style={S.sectionLabel}>Client & Event</div>
              <div style={S.grid2}>
                <div>
                  <label style={S.label}>Client Name *</label>
                  <input value={form.client_name} onChange={e => setForm({ ...form, client_name: e.target.value })}
                    placeholder="e.g. Sarah Hartley" style={S.input} />
                </div>
                <div>
                  <label style={S.label}>Event Name *</label>
                  <input value={form.event_name} onChange={e => setForm({ ...form, event_name: e.target.value })}
                    placeholder="e.g. Hartley Wedding" style={S.input} />
                </div>
                <div>
                  <label style={S.label}>Event Date</label>
                  <input type="date" value={form.event_date} onChange={e => setForm({ ...form, event_date: e.target.value })} style={S.input} />
                </div>
                <div>
                  <label style={S.label}>Status</label>
                  <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={S.select}>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={S.label}>Venue & Address</label>
                  <input value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })}
                    placeholder="e.g. The Manor House, Oxford Road, OX1 1AA" style={S.input} />
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={S.label}>Job Type</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {JOB_TYPE_OPTIONS.map(opt => (
                      <button key={opt.value}
                        style={{ ...S.typeBtn, ...(form.job_type === opt.value ? S.typeBtnActive : {}) }}
                        onClick={() => setForm({ ...form, job_type: opt.value })}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <hr style={S.divider} />

              {/* Delivery & Collection */}
              <div style={S.sectionLabel}>Delivery & Collection</div>
              <div style={S.grid2}>
                {(form.job_type === 'delivery' || form.job_type === 'both') && (<>
                  <div>
                    <label style={S.label}>Delivery Date</label>
                    <input type="date" value={form.delivery_date} onChange={e => setForm({ ...form, delivery_date: e.target.value })} style={S.input} />
                  </div>
                  <div>
                    <label style={S.label}>Delivery Time</label>
                    <input type="time" value={form.delivery_time} onChange={e => setForm({ ...form, delivery_time: e.target.value })} style={S.input} />
                  </div>
                </>)}
                {(form.job_type === 'collection' || form.job_type === 'both') && (<>
                  <div>
                    <label style={S.label}>Collection Date</label>
                    <input type="date" value={form.collection_date} onChange={e => setForm({ ...form, collection_date: e.target.value })} style={S.input} />
                  </div>
                  <div>
                    <label style={S.label}>Collection Time</label>
                    <input type="time" value={form.collection_time} onChange={e => setForm({ ...form, collection_time: e.target.value })} style={S.input} />
                  </div>
                </>)}
              </div>

              <hr style={S.divider} />

              {/* Driver Assignment */}
              <div style={S.sectionLabel}>Driver Assignment</div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
                <button
                  style={{ ...S.driverBtn, ...(form.assigned_driver_id === '' ? S.driverBtnNone : {}) }}
                  onClick={() => setForm({ ...form, assigned_driver_id: '' })}>
                  Unassigned
                </button>
                {drivers.map(d => (
                  <button key={d.id}
                    style={{
                      ...S.driverBtn,
                      ...(form.assigned_driver_id === d.id ? { background: d.colour, color: 'white', borderColor: d.colour } : {}),
                    }}
                    onClick={() => setForm({ ...form, assigned_driver_id: d.id })}>
                    {d.name}
                  </button>
                ))}
              </div>

              <hr style={S.divider} />

              {/* Items */}
              <div style={S.sectionLabel}>Items / Equipment</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '4px' }}>
                <thead>
                  <tr>{['Item', 'Category', 'Qty', ''].map(h => <th key={h} style={{ ...S.th, fontSize: '10.5px' }}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={i}>
                      <td style={{ padding: '5px 6px' }}>
                        <input value={item.item_name} onChange={e => { const n = [...items]; n[i].item_name = e.target.value; setItems(n) }}
                          placeholder="e.g. Dinner Plates" style={{ ...S.input, padding: '7px 10px' }} />
                      </td>
                      <td style={{ padding: '5px 6px' }}>
                        <select value={item.category} onChange={e => { const n = [...items]; n[i].category = e.target.value; setItems(n) }}
                          style={{ ...S.select, padding: '7px 10px' }}>
                          {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '5px 6px' }}>
                        <input type="number" value={item.quantity} onChange={e => { const n = [...items]; n[i].quantity = e.target.value; setItems(n) }}
                          placeholder="0" style={{ ...S.input, padding: '7px 10px', width: '80px' }} />
                      </td>
                      <td style={{ padding: '5px 6px' }}>
                        <button style={S.btnGhost} onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button style={{ ...S.btnGhost, marginTop: '8px' }}
                onClick={() => setItems([...items, { item_name: '', category: 'crockery', quantity: '' }])}>
                ＋ Add Item
              </button>

              <hr style={S.divider} />

              {/* Notes */}
              <div style={S.grid2}>
                <div>
                  <label style={S.label}>Notes</label>
                  <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                    placeholder="General notes for this order…"
                    style={{ ...S.input, minHeight: '80px', resize: 'vertical' }} />
                </div>
                <div>
                  <label style={S.label}>Special Instructions</label>
                  <textarea value={form.special_instructions} onChange={e => setForm({ ...form, special_instructions: e.target.value })}
                    placeholder="e.g. Access via rear entrance. Set up by 14:00."
                    style={{ ...S.input, minHeight: '80px', resize: 'vertical' }} />
                </div>
              </div>
            </div>

            {/* Footer */}
            <div style={S.modalFooter}>
              {editOrder && (
                <button style={{ ...S.btnOutline, color: '#EF4444', borderColor: '#EF4444', marginRight: 'auto' }}
                  onClick={() => { setModal(false); setDel(editOrder) }}>
                  Delete Order
                </button>
              )}
              <button style={S.btnOutline} onClick={() => setModal(false)}>Cancel</button>
              <button style={S.btnPrimary} onClick={saveOrder} disabled={saving}>
                {saving ? 'Saving…' : editOrder ? 'Save Changes' : 'Create Order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deleteTarget && (
        <div style={S.overlay} onClick={e => e.target === e.currentTarget && setDel(null)}>
          <div style={{ background: '#fff', borderRadius: '8px', width: '100%', maxWidth: '440px', boxShadow: '0 12px 48px rgba(28,28,30,0.18)', padding: '32px', fontFamily: "'DM Sans', sans-serif" }}>
            <div style={{ fontSize: '20px', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600', marginBottom: '8px' }}>
              Delete Order
            </div>
            <div style={{ fontSize: '13.5px', color: '#6B6860', marginBottom: '20px', lineHeight: '1.6' }}>
              Are you sure you want to delete <strong>{deleteTarget.event_name}</strong>?
              <br />
              This will remove the job from the schedule and operations view.
              <br />
              <span style={{ fontSize: '12px', color: '#9CA3AF' }}>The record will be retained in the database for audit purposes.</span>
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button style={S.btnOutline} onClick={() => setDel(null)}>Cancel</button>
              <button
                style={{ ...S.btnPrimary, background: '#EF4444' }}
                onClick={confirmDelete}
                disabled={deleting}>
                {deleting ? 'Deleting…' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div style={{ ...S.toast, borderLeftColor: toast.type === 'error' ? '#EF4444' : '#10B981' }}>
          {toast.type === 'error' ? '⚠ ' : '✓ '}{toast.msg}
        </div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  filterBar:    { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' },
  card:         { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(28,28,30,0.08)' },
  table:        { width: '100%', borderCollapse: 'collapse' },
  th:           { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '12px 16px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500', whiteSpace: 'nowrap' },
  td:           { padding: '13px 16px', fontSize: '13px', verticalAlign: 'middle' },
  badge:        { display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: '20px', fontSize: '11.5px', fontWeight: '500', textTransform: 'capitalize' },
  delBadge:     { background: '#EF4444', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' },
  colBadge:     { background: '#22C55E', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px' },
  input:        { fontFamily: "'DM Sans', sans-serif", fontSize: '13.5px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  select:       { fontFamily: "'DM Sans', sans-serif", fontSize: '13px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  label:        { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#1C1C1E', marginBottom: '6px' },
  btnPrimary:   { background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', padding: '9px 20px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' },
  btnOutline:   { background: 'transparent', color: '#1C1C1E', border: '1.5px solid #DDD8CF', borderRadius: '4px', padding: '9px 20px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnGhost:     { background: 'transparent', color: '#6B6860', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  typeBtn:      { padding: '8px 16px', border: '1.5px solid #DDD8CF', borderRadius: '20px', background: 'transparent', color: '#6B6860', fontSize: '12.5px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  typeBtnActive:{ background: '#1C1C1E', color: 'white', borderColor: '#1C1C1E' },
  driverBtn:    { padding: '8px 18px', border: '1.5px solid #DDD8CF', borderRadius: '20px', background: 'transparent', color: '#1C1C1E', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' },
  driverBtnNone:{ background: '#F7F3EE', borderColor: '#B8965A', color: '#B8965A' },
  overlay:      { position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
  modal:        { background: '#fff', borderRadius: '8px', width: '100%', maxWidth: '660px', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 12px 48px rgba(28,28,30,0.14)' },
  modalHeader:  { padding: '28px 32px 20px', borderBottom: '1px solid #DDD8CF', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', position: 'sticky', top: 0, background: '#fff', zIndex: 1 },
  modalTitle:   { fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', fontWeight: '600' },
  modalSub:     { fontSize: '12.5px', color: '#6B6860', marginTop: '3px' },
  closeBtn:     { background: '#F7F3EE', border: 'none', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '14px', color: '#6B6860' },
  modalBody:    { padding: '28px 32px' },
  modalFooter:  { padding: '20px 32px', borderTop: '1px solid #DDD8CF', display: 'flex', justifyContent: 'flex-end', gap: '10px', background: '#F7F3EE', alignItems: 'center' },
  sectionLabel: { fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B8965A', fontWeight: '600', marginBottom: '14px' },
  grid2:        { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  divider:      { border: 'none', borderTop: '1px solid #DDD8CF', margin: '22px 0' },
  toast:        { position: 'fixed', bottom: '24px', right: '24px', background: '#1C1C1E', color: '#fff', padding: '14px 20px', borderRadius: '8px', fontSize: '13.5px', borderLeft: '3px solid #10B981', boxShadow: '0 12px 48px rgba(28,28,30,0.14)', zIndex: 999 },
}

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import EvidencePhotos from '../components/EvidencePhotos'

const STATUS_OPTIONS = ['pending', 'confirmed', 'amended', 'cancelled', 'collected']
const CATEGORY_OPTIONS = ['crockery', 'cutlery', 'glassware', 'linens', 'furniture', 'other']

const statusStyle = {
  confirmed: { background: '#ECFDF5', color: '#065F46' },
  pending: { background: '#FFFBEB', color: '#92400E' },
  amended: { background: '#EFF6FF', color: '#1D4ED8' },
  cancelled: { background: '#FEF2F2', color: '#991B1B' },
  collected: { background: '#F5F3FF', color: '#5B21B6' },
}

const emptyOrder = {
  event_name: '', client_name: '', venue: '', event_date: '',
  delivery_date: '', delivery_time: '', collection_date: '', collection_time: '',
  driver_id: '', status: 'pending', notes: ''
}

export default function Orders() {
  const { profile } = useAuth()
  const [orders, setOrders] = useState([])
  const [drivers, setDrivers] = useState([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editOrder, setEditOrder] = useState(null)
  const [form, setForm] = useState(emptyOrder)
  const [items, setItems] = useState([{ item_name: '', category: 'crockery', quantity: '' }])
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  useEffect(() => { fetchOrders(); fetchDrivers() }, [])

  async function fetchOrders() {
    const { data } = await supabase
      .from('orders')
      .select('*, users(name)')
      .order('event_date', { ascending: true })
    if (data) setOrders(data)
    setLoading(false)
  }

  async function fetchDrivers() {
    const { data } = await supabase.from('users').select('id, name').in('role', ['admin','driver'])
    if (data) setDrivers(data)
  }

  function openNew() {
    setEditOrder(null)
    setForm(emptyOrder)
    setItems([{ item_name: '', category: 'crockery', quantity: '' }])
    setModalOpen(true)
  }

  async function openEdit(order) {
    setEditOrder(order)
    setForm({
      event_name: order.event_name || '', client_name: order.client_name || '',
      venue: order.venue || '', event_date: order.event_date || '',
      delivery_date: order.delivery_date || '', delivery_time: order.delivery_time || '',
      collection_date: order.collection_date || '', collection_time: order.collection_time || '',
      driver_id: order.driver_id || '', status: order.status || 'pending', notes: order.notes || ''
    })
    const { data: orderItems } = await supabase.from('order_items').select('*').eq('order_id', order.id)
    setItems(orderItems?.length ? orderItems : [{ item_name: '', category: 'crockery', quantity: '' }])
    setModalOpen(true)
  }

  async function saveOrder() {
    setSaving(true)
    const orderData = { ...form }

    if (editOrder) {
      const { error } = await supabase.from('orders').update(orderData).eq('id', editOrder.id)
      if (!error) {
        await supabase.from('order_items').delete().eq('order_id', editOrder.id)
        const validItems = items.filter(i => i.item_name)
        if (validItems.length) {
          await supabase.from('order_items').insert(validItems.map(i => ({ ...i, order_id: editOrder.id })))
        }
        await logActivity(`Order updated: ${form.event_name}`, 'order', editOrder.id)
        showToast('Order updated successfully')
      }
    } else {
      const { data, error } = await supabase.from('orders').insert(orderData).select().single()
      if (!error && data) {
        const validItems = items.filter(i => i.item_name)
        if (validItems.length) {
          await supabase.from('order_items').insert(validItems.map(i => ({ ...i, order_id: data.id })))
        }
        await logActivity(`New order created: ${form.event_name}`, 'order', data.id)
        showToast('Order created successfully')
      }
    }
    await fetchOrders()
    setModalOpen(false)
    setSaving(false)
  }

  async function logActivity(action, entity_type, entity_id) {
    if (!profile?.id) return
    await supabase.from('activity_log').insert({ action, entity_type, entity_id, user_id: profile.id })
  }

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  function formatDate(d) {
    if (!d) return '—'
    return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  const filtered = orders.filter(o => {
    const matchSearch = !search || [o.event_name, o.client_name, o.venue].some(f => f?.toLowerCase().includes(search.toLowerCase()))
    const matchStatus = statusFilter === 'all' || o.status === statusFilter
    return matchSearch && matchStatus
  })

  if (loading) return <div style={{ padding: '48px', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>Loading orders…</div>

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      {/* Filter bar */}
      <div style={styles.filterBar}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#6B6860' }}>🔍</span>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search orders, clients, venues…"
            style={{ ...styles.input, paddingLeft: '36px', width: '100%' }}
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={styles.select}>
          <option value="all">All Statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s} style={{ textTransform: 'capitalize' }}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
        <button style={styles.btnPrimary} onClick={openNew}>＋ New Order</button>
      </div>

      {/* Table */}
      <div style={styles.card}>
        <table style={styles.table}>
          <thead>
            <tr>
              {['Ref','Event / Client','Venue','Event Date','Delivery','Collection','Status',''].map(h => (
                <th key={h} style={styles.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: '48px', color: '#6B6860' }}>No orders found</td></tr>
            ) : filtered.map(o => (
              <tr key={o.id}>
                <td style={styles.td}><span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '15px', fontWeight: '600', color: '#B8965A' }}>{o.ref || '—'}</span></td>
                <td style={styles.td}><div style={{ fontWeight: 500 }}>{o.event_name}</div><div style={{ fontSize: '11.5px', color: '#6B6860' }}>{o.client_name}</div></td>
                <td style={{ ...styles.td, fontSize: '12.5px', color: '#6B6860' }}>{o.venue}</td>
                <td style={styles.td}>{formatDate(o.event_date)}</td>
                <td style={styles.td}>{formatDate(o.delivery_date)}<br /><small style={{ color: '#6B6860' }}>{o.delivery_time}</small></td>
                <td style={styles.td}>{formatDate(o.collection_date)}<br /><small style={{ color: '#6B6860' }}>{o.collection_time}</small></td>
                <td style={styles.td}><span style={{ ...styles.badge, ...(statusStyle[o.status] || statusStyle.pending) }}>{o.status}</span></td>
                <td style={styles.td}><button style={styles.btnGhost} onClick={() => openEdit(o)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {modalOpen && (
        <div style={styles.overlay} onClick={e => e.target === e.currentTarget && setModalOpen(false)}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div>
                <div style={styles.modalTitle}>{editOrder ? 'Edit Order' : 'New Order'}</div>
                <div style={styles.modalSub}>{editOrder ? editOrder.event_name : 'Fill in the details below'}</div>
              </div>
              <button style={styles.closeBtn} onClick={() => setModalOpen(false)}>✕</button>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.sectionLabel}>Client & Event</div>
              <div style={styles.formGrid2}>
                {[
                  { label: 'Client Name', key: 'client_name', placeholder: 'e.g. Sarah Hartley' },
                  { label: 'Event Name', key: 'event_name', placeholder: 'e.g. Hartley Wedding' },
                ].map(f => (
                  <div key={f.key}>
                    <label style={styles.label}>{f.label}</label>
                    <input value={form[f.key]} onChange={e => setForm({ ...form, [f.key]: e.target.value })} placeholder={f.placeholder} style={styles.input} />
                  </div>
                ))}
                <div>
                  <label style={styles.label}>Event Date</label>
                  <input type="date" value={form.event_date} onChange={e => setForm({ ...form, event_date: e.target.value })} style={styles.input} />
                </div>
                <div>
                  <label style={styles.label}>Status</label>
                  <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={styles.select}>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={styles.label}>Venue & Address</label>
                  <input value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })} placeholder="e.g. The Manor House, Oxford Road, OX1 1AA" style={styles.input} />
                </div>
              </div>

              <hr style={styles.divider} />
              <div style={styles.sectionLabel}>Delivery & Collection</div>
              <div style={styles.formGrid2}>
                <div><label style={styles.label}>Delivery Date</label><input type="date" value={form.delivery_date} onChange={e => setForm({ ...form, delivery_date: e.target.value })} style={styles.input} /></div>
                <div><label style={styles.label}>Delivery Time</label><input type="time" value={form.delivery_time} onChange={e => setForm({ ...form, delivery_time: e.target.value })} style={styles.input} /></div>
                <div><label style={styles.label}>Collection Date</label><input type="date" value={form.collection_date} onChange={e => setForm({ ...form, collection_date: e.target.value })} style={styles.input} /></div>
                <div><label style={styles.label}>Collection Time</label><input type="time" value={form.collection_time} onChange={e => setForm({ ...form, collection_time: e.target.value })} style={styles.input} /></div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={styles.label}>Assigned Driver</label>
                  <select value={form.driver_id} onChange={e => setForm({ ...form, driver_id: e.target.value })} style={styles.select}>
                    <option value="">— Select driver —</option>
                    {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              </div>

              <hr style={styles.divider} />
              <div style={styles.sectionLabel}>Items / Equipment</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px' }}>
                <thead><tr>{['Item', 'Category', 'Qty', ''].map(h => <th key={h} style={{ ...styles.th, fontSize: '10.5px' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={i}>
                      <td style={{ padding: '6px 8px' }}><input value={item.item_name} onChange={e => { const n = [...items]; n[i].item_name = e.target.value; setItems(n) }} placeholder='e.g. Dinner Plates' style={{ ...styles.input, padding: '6px 10px' }} /></td>
                      <td style={{ padding: '6px 8px' }}>
                        <select value={item.category} onChange={e => { const n = [...items]; n[i].category = e.target.value; setItems(n) }} style={{ ...styles.select, padding: '6px 10px' }}>
                          {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '6px 8px' }}><input type="number" value={item.quantity} onChange={e => { const n = [...items]; n[i].quantity = e.target.value; setItems(n) }} placeholder="0" style={{ ...styles.input, padding: '6px 10px', width: '80px' }} /></td>
                      <td style={{ padding: '6px 8px' }}><button style={styles.btnGhost} onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button style={{ ...styles.btnGhost, marginTop: '10px' }} onClick={() => setItems([...items, { item_name: '', category: 'crockery', quantity: '' }])}>＋ Add Item</button>

              <hr style={styles.divider} />
              <div>
                <label style={styles.label}>Notes / Special Instructions</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Access via rear entrance. All chairs set up by 14:00." style={{ ...styles.input, minHeight: '80px', resize: 'vertical' }} />
              </div>

              {editOrder && (
                <>
                  <hr style={styles.divider} />
                  <EvidencePhotos orderId={editOrder.id} orderName={editOrder.event_name || editOrder.client_name} />
                </>
              )}
            </div>
            <div style={styles.modalFooter}>
              <button style={styles.btnOutline} onClick={() => setModalOpen(false)}>Cancel</button>
              <button style={styles.btnPrimary} onClick={saveOrder} disabled={saving}>{saving ? 'Saving…' : 'Save Order'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={styles.toast}>✓ {toast}</div>
      )}
    </div>
  )
}

const styles = {
  filterBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 24px rgba(28,28,30,0.08)' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', padding: '12px 20px', textAlign: 'left', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', fontWeight: '500' },
  td: { padding: '13px 20px', fontSize: '13.5px', borderBottom: '1px solid #EDE8E0', verticalAlign: 'middle' },
  badge: { display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: '20px', fontSize: '11.5px', fontWeight: '500', textTransform: 'capitalize' },
  input: { fontFamily: "'DM Sans', sans-serif", fontSize: '13.5px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  select: { fontFamily: "'DM Sans', sans-serif", fontSize: '13px', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', background: '#fff', color: '#1C1C1E', outline: 'none', boxSizing: 'border-box', width: '100%' },
  label: { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#1C1C1E', marginBottom: '6px' },
  btnPrimary: { background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', padding: '9px 20px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' },
  btnOutline: { background: 'transparent', color: '#1C1C1E', border: '1.5px solid #DDD8CF', borderRadius: '4px', padding: '9px 20px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnGhost: { background: 'transparent', color: '#6B6860', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
  modal: { background: '#fff', borderRadius: '8px', width: '100%', maxWidth: '640px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 48px rgba(28,28,30,0.14)' },
  modalHeader: { padding: '28px 32px 20px', borderBottom: '1px solid #DDD8CF', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', position: 'sticky', top: 0, background: '#fff', zIndex: 1 },
  modalTitle: { fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', fontWeight: '600' },
  modalSub: { fontSize: '12.5px', color: '#6B6860', marginTop: '3px' },
  closeBtn: { background: '#F7F3EE', border: 'none', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B6860' },
  modalBody: { padding: '28px 32px' },
  modalFooter: { padding: '20px 32px', borderTop: '1px solid #DDD8CF', display: 'flex', justifyContent: 'flex-end', gap: '10px', background: '#F7F3EE' },
  sectionLabel: { fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B8965A', fontWeight: '600', marginBottom: '14px' },
  formGrid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  divider: { border: 'none', borderTop: '1px solid #DDD8CF', margin: '20px 0' },
  toast: { position: 'fixed', bottom: '24px', right: '24px', background: '#1C1C1E', color: '#fff', padding: '14px 20px', borderRadius: '8px', fontSize: '13.5px', borderLeft: '3px solid #10B981', boxShadow: '0 12px 48px rgba(28,28,30,0.14)', zIndex: 999 },
}

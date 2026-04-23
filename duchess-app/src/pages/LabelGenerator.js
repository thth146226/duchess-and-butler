import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

const SELF_COLLECTION_DEFAULT_POSTCODE = 'HP2 6EZ'
const UK_POSTCODE_REGEX = /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i

function extractUkPostcode(text) {
  if (!text) return null
  const match = String(text).match(UK_POSTCODE_REGEX)
  return match ? match[1].toUpperCase() : null
}

export default function LabelGenerator() {
  const { profile } = useAuth()
  const [orders, setOrders] = useState([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [selectedOrderLoading, setSelectedOrderLoading] = useState(false)
  const [jobItems, setJobItems] = useState([])
  const [jobItemsLoading, setJobItemsLoading] = useState(false)
  const [ataItems, setAtaItems] = useState([])
  const [ataItemsLoading, setAtaItemsLoading] = useState(false)
  const [showPastOrders, setShowPastOrders] = useState(false)
  const [search, setSearch] = useState('')
  const [error, setError] = useState(null)

  const isDev = process.env.NODE_ENV === 'development'
  function devLog(message, payload) {
    if (!isDev) return
    console.log(message, payload)
  }

  const today = new Date().toISOString().slice(0, 10)
  
  // Defense in depth — only admin role
  if (profile?.role !== 'admin') {
    return (
      <div style={{ 
        padding: '40px', 
        fontFamily: "'DM Sans', sans-serif",
        textAlign: 'center'
      }}>
        <div style={{ fontSize: '14px', color: '#6B6860' }}>
          Access restricted to administrators.
        </div>
      </div>
    )
  }

  async function fetchOrders(includePast) {
    setOrdersLoading(true)
    setError(null)
    let query = supabase
      .from('crms_jobs')
      .select('id, crms_ref, event_name, client_name, venue, venue_address, delivery_date, collection_date, assigned_driver_name, status')
      .order('delivery_date', { ascending: true, nullsFirst: false })

    if (!includePast) {
      query = query.gte('delivery_date', today)
    }

    const { data, error: ordersError } = await query
    if (ordersError) {
      setError('Error loading orders: ' + ordersError.message)
      setOrders([])
      setOrdersLoading(false)
      return
    }

    setOrders(data || [])
    setOrdersLoading(false)
    devLog('[labels-phase2] orders loaded', { count: (data || []).length, includePast })
  }

  async function loadOrderDiagnostics(orderId) {
    setSelectedOrderLoading(true)
    setJobItemsLoading(true)
    setAtaItemsLoading(true)
    setError(null)

    const [{ data: orderData, error: orderError }, { data: itemsData, error: itemsError }, { data: ataData, error: ataError }] = await Promise.all([
      supabase
        .from('crms_jobs')
        .select('id, crms_ref, event_name, client_name, venue, venue_address, delivery_date, collection_date, assigned_driver_name, status')
        .eq('id', orderId)
        .single(),
      supabase
        .from('crms_job_items')
        .select('id, job_id, item_name, quantity, category')
        .eq('job_id', orderId)
        .order('item_name', { ascending: true }),
      supabase
        .from('ata_items')
        .select('id, name, category, pieces_per_unit, unit_name, active')
        .eq('active', true)
        .order('name', { ascending: true }),
    ])

    if (orderError) {
      setError('Error loading selected order: ' + orderError.message)
      setSelectedOrder(null)
    } else {
      setSelectedOrder(orderData || null)
      devLog('[labels-phase2] order selected', { id: orderData?.id, crms_ref: orderData?.crms_ref })
    }

    if (itemsError) {
      setError('Error loading job items: ' + itemsError.message)
      setJobItems([])
    } else {
      setJobItems(itemsData || [])
      devLog('[labels-phase2] job items loaded', { count: (itemsData || []).length, orderId })
    }

    if (ataError) {
      setError('Error loading ATA items: ' + ataError.message)
      setAtaItems([])
    } else {
      setAtaItems(ataData || [])
      devLog('[labels-phase2] ata items loaded', { count: (ataData || []).length })
    }

    setSelectedOrderLoading(false)
    setJobItemsLoading(false)
    setAtaItemsLoading(false)
  }

  function handleSelectOrder(order) {
    loadOrderDiagnostics(order.id)
  }

  useEffect(() => {
    fetchOrders(showPastOrders)
  }, [showPastOrders])

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return orders
    return orders.filter(o =>
      (o.crms_ref || '').toLowerCase().includes(q) ||
      (o.event_name || '').toLowerCase().includes(q) ||
      (o.client_name || '').toLowerCase().includes(q)
    )
  }, [orders, search])

  const postcodeDiagnostic = useMemo(() => {
    if (!selectedOrder) {
      return { status: 'postcode unresolved', value: null }
    }

    const driver = (selectedOrder.assigned_driver_name || '').toLowerCase().trim()
    if (driver === 'self collection') {
      return { status: 'postcode resolved from self collection default', value: SELF_COLLECTION_DEFAULT_POSTCODE }
    }

    const resolved = extractUkPostcode(selectedOrder.venue_address)
    if (resolved) {
      return { status: 'postcode resolved from venue_address', value: resolved }
    }

    return { status: 'postcode unresolved', value: null }
  }, [selectedOrder])

  useEffect(() => {
    if (!selectedOrder) return
    devLog('[labels-phase2] postcode diagnostic', {
      orderId: selectedOrder.id,
      crms_ref: selectedOrder.crms_ref,
      status: postcodeDiagnostic.status,
      value: postcodeDiagnostic.value,
    })
  }, [selectedOrder, postcodeDiagnostic])
  
  return (
    <div style={{ 
      padding: '40px',
      fontFamily: "'DM Sans', sans-serif",
      maxWidth: '1200px',
      margin: '0 auto'
    }}>
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ 
          fontSize: '24px', 
          fontWeight: '600', 
          color: '#1C1C1E', 
          margin: 0,
          letterSpacing: '-0.01em'
        }}>
          Label Generator
        </h1>
        <div style={{ 
          fontSize: '13px', 
          color: '#6B6860', 
          marginTop: '6px' 
        }}>
          Phase 2 diagnostics: real order, item and ATA data loading.
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by ref, event or client"
            style={{ flex: 1, minWidth: '220px', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif" }}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6B6860' }}>
            <input type="checkbox" checked={showPastOrders} onChange={e => setShowPastOrders(e.target.checked)} />
            Show past orders
          </label>
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', marginBottom: '20px' }}>
        <div style={{ padding: '12px 16px', background: '#F7F3EE', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860', fontWeight: '600' }}>
          Orders ({filteredOrders.length})
        </div>
        {ordersLoading ? (
          <div style={{ padding: '20px 16px', fontSize: '13px', color: '#6B6860' }}>Loading orders...</div>
        ) : filteredOrders.length === 0 ? (
          <div style={{ padding: '20px 16px', fontSize: '13px', color: '#9CA3AF' }}>No orders found for this filter.</div>
        ) : (
          filteredOrders.map(order => {
            const isSelected = selectedOrder?.id === order.id
            return (
              <button
                key={order.id}
                onClick={() => handleSelectOrder(order)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  borderTop: '1px solid #F1EFE8',
                  background: isSelected ? '#FFFEF8' : '#fff',
                  padding: '12px 16px',
                  cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: '600', color: '#1C1C1E' }}>{order.crms_ref || '—'} · {order.event_name || '—'}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '3px' }}>{order.client_name || '—'} · {order.delivery_date || '—'} · {order.status || '—'}</div>
                  </div>
                  <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{order.collection_date || '—'}</div>
                </div>
              </button>
            )
          })
        )}
      </div>

      <div style={{ background: '#FDFCFA', border: '1px dashed #DDD8CF', borderRadius: '8px', padding: '16px' }}>
        <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '12px' }}>
          Phase 2 · Diagnostic panel
        </div>

        {error && (
          <div style={{ marginBottom: '12px', fontSize: '12px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px' }}>
            {error}
          </div>
        )}

        {!selectedOrder && !selectedOrderLoading && (
          <div style={{ fontSize: '13px', color: '#6B6860' }}>No selection state: choose an order above to load diagnostics.</div>
        )}

        {selectedOrderLoading && (
          <div style={{ fontSize: '13px', color: '#6B6860', marginBottom: '8px' }}>Selected order loading...</div>
        )}

        {selectedOrder && (
          <div style={{ display: 'grid', gap: '8px' }}>
            <div style={{ fontSize: '12px', color: '#1C1C1E' }}><strong>Order selected:</strong></div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>crms_ref: {selectedOrder.crms_ref || '—'}</div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>event_name: {selectedOrder.event_name || '—'}</div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>client_name: {selectedOrder.client_name || '—'}</div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>venue: {selectedOrder.venue || '—'}</div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>venue_address: {selectedOrder.venue_address || '—'}</div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>assigned_driver_name: {selectedOrder.assigned_driver_name || '—'}</div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>delivery_date: {selectedOrder.delivery_date || '—'}</div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>collection_date: {selectedOrder.collection_date || '—'}</div>

            <div style={{ marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '20px', border: '1px solid #DDD8CF', background: '#fff', color: '#6B6860' }}>
                {postcodeDiagnostic.status}
              </span>
              <span style={{ fontSize: '12px', color: '#1C1C1E' }}>
                {postcodeDiagnostic.value ? `postcode: ${postcodeDiagnostic.value}` : 'postcode: —'}
              </span>
            </div>

            <div style={{ marginTop: '12px', fontSize: '12px', color: '#1C1C1E' }}><strong>Items diagnostic:</strong></div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>
              {jobItemsLoading ? 'job items loading...' : `total items loaded: ${jobItems.length}`}
            </div>
            {!jobItemsLoading && jobItems.length === 0 && (
              <div style={{ fontSize: '12px', color: '#9CA3AF' }}>empty state: no job items found.</div>
            )}
            {!jobItemsLoading && jobItems.length > 0 && (
              <div style={{ display: 'grid', gap: '6px' }}>
                {jobItems.map(item => (
                  <div key={item.id} style={{ fontSize: '12px', color: '#6B6860' }}>
                    {item.item_name || '—'} · qty: {item.quantity ?? 0} · category: {item.category || '—'}
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: '12px', fontSize: '12px', color: '#1C1C1E' }}><strong>ATA diagnostic:</strong></div>
            <div style={{ fontSize: '12px', color: '#6B6860' }}>
              {ataItemsLoading ? 'ata items loading...' : `total ata_items active loaded: ${ataItems.length}`}
            </div>
            {!ataItemsLoading && ataItems.length === 0 && (
              <div style={{ fontSize: '12px', color: '#9CA3AF' }}>empty state: no ATA items found.</div>
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: '12px', fontSize: '11px', color: '#9CA3AF' }}>
        This phase does not generate labels.
      </div>
    </div>
  )
}

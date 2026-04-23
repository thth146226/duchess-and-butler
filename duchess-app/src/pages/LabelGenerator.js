import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import {
  LABEL_ORDER_COLOURS,
  buildAtaCapacityMap,
  generateLabelsForItem,
  getLabelOrderColour,
  isManualSplitValid,
  isNonLabelJobItem,
  normalizeItemName,
  normalizeManualLabels,
  resolveJobItemRule,
  sumManualLabels,
} from '../lib/labelGenerator'

const SELF_COLLECTION_DEFAULT_POSTCODE = 'HP2 6EZ'
const UK_POSTCODE_REGEX = /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i

function extractUkPostcode(text) {
  if (!text) return null
  const match = String(text).match(UK_POSTCODE_REGEX)
  return match ? match[1].toUpperCase() : null
}

function confidenceStyle(level) {
  if (level === 'high') return { bg: '#EAF3DE', color: '#3B6D11' }
  if (level === 'medium') return { bg: '#FEF3C7', color: '#854F0B' }
  return { bg: '#FCEBEB', color: '#A32D2D' }
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
  const [manualLabelsByItem, setManualLabelsByItem] = useState({})
  const [orderColourKey, setOrderColourKey] = useState('black')

  const isDev = process.env.NODE_ENV === 'development'
  function devLog(message, payload) {
    if (!isDev) return
    console.log(message, payload)
  }

  const today = new Date().toISOString().slice(0, 10)
  const orderColour = getLabelOrderColour(orderColourKey)

  // Defense in depth — only admin role
  if (profile?.role !== 'admin') {
    return (
      <div style={{ padding: '40px', fontFamily: "'DM Sans', sans-serif", textAlign: 'center' }}>
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

  async function loadOrderData(orderId) {
    setSelectedOrderLoading(true)
    setJobItemsLoading(true)
    setAtaItemsLoading(true)
    setError(null)
    setManualLabelsByItem({})
    setOrderColourKey('black')

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

  useEffect(() => {
    fetchOrders(showPastOrders)
  }, [showPastOrders])

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return orders
    return orders.filter(order =>
      (order.crms_ref || '').toLowerCase().includes(q) ||
      (order.event_name || '').toLowerCase().includes(q) ||
      (order.client_name || '').toLowerCase().includes(q)
    )
  }, [orders, search])

  const postcodeDiagnostic = useMemo(() => {
    if (!selectedOrder) return { status: 'postcode unresolved', value: null }
    const driver = (selectedOrder.assigned_driver_name || '').toLowerCase().trim()
    if (driver === 'self collection') {
      return { status: 'postcode resolved from self collection default', value: SELF_COLLECTION_DEFAULT_POSTCODE }
    }
    const resolved = extractUkPostcode(selectedOrder.venue_address)
    if (resolved) return { status: 'postcode resolved from venue_address', value: resolved }
    return { status: 'postcode unresolved', value: null }
  }, [selectedOrder])

  const processing = useMemo(() => {
    const ataCapacityMap = buildAtaCapacityMap(ataItems)
    const ignoredItems = []
    const eligibleMatchedItems = []
    const outOfScopeItems = []

    for (let idx = 0; idx < jobItems.length; idx++) {
      const item = jobItems[idx]
      const totalQty = Number.parseInt(item.quantity, 10)
      if (isNonLabelJobItem(item.item_name, totalQty)) {
        ignoredItems.push(item)
        continue
      }

      const itemKey = `${selectedOrder?.id || 'order'}:${normalizeItemName(item.item_name)}:${idx}`
      const candidate = { ...item, itemKey }
      const resolvedRule = resolveJobItemRule(candidate, ataCapacityMap)

      if (!resolvedRule.matched) {
        outOfScopeItems.push({
          ...candidate,
          reason: resolvedRule.reason || 'No ATA rule found',
        })
        continue
      }

      eligibleMatchedItems.push(generateLabelsForItem(candidate, resolvedRule))
    }

    return { ignoredItems, eligibleMatchedItems, outOfScopeItems }
  }, [ataItems, jobItems, selectedOrder])

  useEffect(() => {
    setManualLabelsByItem(prev => {
      const next = {}
      for (const item of processing.eligibleMatchedItems) {
        if (Array.isArray(prev[item.itemKey]) && prev[item.itemKey].length > 0) {
          next[item.itemKey] = prev[item.itemKey]
        } else {
          next[item.itemKey] = item.autoLabels.map(l => ({ id: l.id, quantity: l.quantity }))
        }
      }
      return next
    })
  }, [processing.eligibleMatchedItems])

  const manualStateByItem = useMemo(() => {
    const map = {}
    for (const item of processing.eligibleMatchedItems) {
      const normalized = normalizeManualLabels(manualLabelsByItem[item.itemKey] || item.autoLabels, item.totalQty)
      const total = sumManualLabels(normalized)
      const valid = isManualSplitValid(normalized, item.totalQty)
      map[item.itemKey] = { labels: normalized, total, valid }
    }
    return map
  }, [manualLabelsByItem, processing.eligibleMatchedItems])

  const previewLabels = useMemo(() => {
    const labels = []
    for (const item of processing.eligibleMatchedItems) {
      const manual = manualStateByItem[item.itemKey]
      for (const split of manual?.labels || []) {
        labels.push({
          id: `${item.itemKey}:${split.id}`,
          productName: item.productName,
          quantity: split.quantity,
          category: item.category || 'other',
          packagingType: item.packagingType || 'unit',
        })
      }
    }
    return labels
  }, [manualStateByItem, processing.eligibleMatchedItems])

  useEffect(() => {
    if (!selectedOrder) return
    devLog('[labels-phase2] postcode diagnostic', {
      orderId: selectedOrder.id,
      crms_ref: selectedOrder.crms_ref,
      status: postcodeDiagnostic.status,
      value: postcodeDiagnostic.value,
    })
  }, [postcodeDiagnostic, selectedOrder])

  function setItemManualQuantity(itemKey, labelId, value) {
    setManualLabelsByItem(prev => ({
      ...prev,
      [itemKey]: (prev[itemKey] || []).map(label => (
        label.id === labelId ? { ...label, quantity: value } : label
      )),
    }))
  }

  function addManualLabelRow(itemKey) {
    setManualLabelsByItem(prev => {
      const current = prev[itemKey] || []
      return {
        ...prev,
        [itemKey]: [...current, { id: `${itemKey}-manual-${Date.now()}`, quantity: '' }],
      }
    })
  }

  function removeManualLabelRow(itemKey, labelId) {
    setManualLabelsByItem(prev => {
      const current = prev[itemKey] || []
      return {
        ...prev,
        [itemKey]: current.filter(label => label.id !== labelId),
      }
    })
  }

  function resetItemToAutomatic(item) {
    setManualLabelsByItem(prev => ({
      ...prev,
      [item.itemKey]: item.autoLabels.map(l => ({ id: l.id, quantity: l.quantity })),
    }))
  }

  function resetAllToAutomatic() {
    const next = {}
    for (const item of processing.eligibleMatchedItems) {
      next[item.itemKey] = item.autoLabels.map(l => ({ id: l.id, quantity: l.quantity }))
    }
    setManualLabelsByItem(next)
  }

  return (
    <div style={{ padding: '40px', fontFamily: "'DM Sans', sans-serif", maxWidth: '1280px', margin: '0 auto' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', color: '#1C1C1E', margin: 0, letterSpacing: '-0.01em' }}>
          Label Generator
        </h1>
        <div style={{ fontSize: '13px', color: '#6B6860', marginTop: '6px' }}>
          Build and validate label splits from real order + ATA rule data.
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by ref, event or client"
            style={{ flex: 1, minWidth: '240px', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px' }}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6B6860' }}>
            <input type="checkbox" checked={showPastOrders} onChange={e => setShowPastOrders(e.target.checked)} />
            Show past orders
          </label>
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
        <div style={{ padding: '12px 16px', background: '#F7F3EE', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860', fontWeight: '600' }}>
          Order selection ({filteredOrders.length})
        </div>
        {ordersLoading ? (
          <div style={{ padding: '20px 16px', fontSize: '13px', color: '#6B6860' }}>orders loading...</div>
        ) : filteredOrders.length === 0 ? (
          <div style={{ padding: '20px 16px', fontSize: '13px', color: '#9CA3AF' }}>empty state: no orders found.</div>
        ) : (
          filteredOrders.map(order => {
            const isSelected = selectedOrder?.id === order.id
            return (
              <button
                key={order.id}
                onClick={() => loadOrderData(order.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  borderTop: '1px solid #F1EFE8',
                  background: isSelected ? '#FFFEF8' : '#fff',
                  padding: '12px 16px',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: '600', color: '#1C1C1E' }}>{order.crms_ref || '—'} · {order.event_name || '—'}</div>
                <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '3px' }}>
                  {order.client_name || '—'} · DEL {order.delivery_date || '—'} · COL {order.collection_date || '—'} · {order.status || '—'}
                </div>
              </button>
            )
          })
        )}
      </div>

      {!selectedOrder && !selectedOrderLoading && (
        <div style={{ background: '#FDFCFA', border: '1px dashed #DDD8CF', borderRadius: '8px', padding: '20px', fontSize: '13px', color: '#6B6860', marginBottom: '16px' }}>
          No selection state: choose an order to run the label engine.
        </div>
      )}

      {selectedOrderLoading && (
        <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', fontSize: '13px', color: '#6B6860', marginBottom: '16px' }}>
          selected order loading...
        </div>
      )}

      {error && (
        <div style={{ marginBottom: '16px', fontSize: '12px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px' }}>
          {error}
        </div>
      )}

      {selectedOrder && (
        <>
          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '10px' }}>
              Selected order summary
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: '12px', color: '#6B6860' }}>
              <div><strong style={{ color: '#1C1C1E' }}>ref:</strong> {selectedOrder.crms_ref || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>event:</strong> {selectedOrder.event_name || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>client:</strong> {selectedOrder.client_name || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>venue:</strong> {selectedOrder.venue || '—'}</div>
              <div style={{ gridColumn: '1 / -1' }}><strong style={{ color: '#1C1C1E' }}>venue_address:</strong> {selectedOrder.venue_address || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>delivery date:</strong> {selectedOrder.delivery_date || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>collection date:</strong> {selectedOrder.collection_date || '—'}</div>
            </div>
            <div style={{ marginTop: '12px', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '20px', border: '1px solid #DDD8CF', background: '#fff', color: '#6B6860' }}>
                {postcodeDiagnostic.status}
              </span>
              <span style={{ fontSize: '12px', color: '#1C1C1E' }}>
                {postcodeDiagnostic.value ? `postcode: ${postcodeDiagnostic.value}` : 'postcode: —'}
              </span>
            </div>
          </div>

          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '10px' }}>
              Processing summary
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', background: '#F7F3EE', border: '1px solid #DDD8CF', borderRadius: '20px', padding: '4px 10px', color: '#6B6860' }}>
                ignored rows: {processing.ignoredItems.length}
              </span>
              <span style={{ fontSize: '12px', background: '#EAF3DE', border: '1px solid #C8E0A8', borderRadius: '20px', padding: '4px 10px', color: '#3B6D11' }}>
                matched label items: {processing.eligibleMatchedItems.length}
              </span>
              <span style={{ fontSize: '12px', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: '20px', padding: '4px 10px', color: '#854F0B' }}>
                out-of-scope items: {processing.outOfScopeItems.length}
              </span>
              <span style={{ fontSize: '12px', background: '#EEEDFE', border: '1px solid #DDD8CF', borderRadius: '20px', padding: '4px 10px', color: '#3C3489' }}>
                total preview labels: {previewLabels.length}
              </span>
              <span style={{ fontSize: '12px', background: '#F0F9FF', border: '1px solid #DDD8CF', borderRadius: '20px', padding: '4px 10px', color: '#1D4ED8' }}>
                ata items loaded: {ataItemsLoading ? 'loading...' : ataItems.length}
              </span>
            </div>
          </div>

          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '10px' }}>
              Order colour
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {Object.values(LABEL_ORDER_COLOURS).map(c => (
                <button
                  key={c.key}
                  onClick={() => setOrderColourKey(c.key)}
                  style={{
                    fontSize: '12px',
                    padding: '5px 10px',
                    borderRadius: '20px',
                    border: `1px solid ${orderColourKey === c.key ? c.color : '#DDD8CF'}`,
                    background: orderColourKey === c.key ? '#F7F3EE' : '#fff',
                    color: orderColourKey === c.key ? c.color : '#6B6860',
                    cursor: 'pointer',
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A' }}>
                Eligible matched items editor
              </div>
              <button
                onClick={resetAllToAutomatic}
                style={{ fontSize: '11px', padding: '5px 10px', borderRadius: '6px', border: '1px solid #DDD8CF', background: '#fff', color: '#6B6860', cursor: 'pointer' }}
              >
                Reset all to automatic
              </button>
            </div>
            {jobItemsLoading || ataItemsLoading ? (
              <div style={{ fontSize: '13px', color: '#6B6860' }}>job items loading...</div>
            ) : processing.eligibleMatchedItems.length === 0 ? (
              <div style={{ fontSize: '13px', color: '#9CA3AF' }}>empty state: no matched items to generate labels.</div>
            ) : (
              <div style={{ display: 'grid', gap: '14px' }}>
                {processing.eligibleMatchedItems.map(item => {
                  const conf = confidenceStyle(item.confidence)
                  const manual = manualStateByItem[item.itemKey] || { labels: [], total: 0, valid: false }
                  return (
                    <div key={item.itemKey} style={{ border: '1px solid #EDE8E0', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                        <div style={{ fontSize: '13px', fontWeight: '600', color: '#1C1C1E' }}>{item.productName}</div>
                        <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '12px', background: conf.bg, color: conf.color }}>
                          {item.confidence}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '8px' }}>
                        total: {item.totalQty} · capacity: {item.capacity} · packaging: {(item.packagingType || 'unit').toUpperCase()} · category: {(item.category || 'other').toUpperCase()}
                      </div>
                      {item.flags.length > 0 && (
                        <div style={{ marginBottom: '8px', display: 'grid', gap: '4px' }}>
                          {item.flags.map((flag, idx) => (
                            <div key={`${item.itemKey}-flag-${idx}`} style={{ fontSize: '11px', color: flag.level === 'error' ? '#A32D2D' : '#854F0B' }}>
                              {flag.level === 'error' ? 'Error:' : 'Warning:'} {flag.message}
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'grid', gap: '6px' }}>
                        {manualLabelsByItem[item.itemKey]?.map(label => (
                          <div key={label.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                              value={label.quantity}
                              onChange={e => setItemManualQuantity(item.itemKey, label.id, e.target.value)}
                              style={{ width: '80px', padding: '6px 8px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '12px' }}
                            />
                            <span style={{ fontSize: '11px', color: '#6B6860' }}>{item.productName}</span>
                            <button
                              onClick={() => removeManualLabelRow(item.itemKey, label.id)}
                              style={{ marginLeft: 'auto', fontSize: '11px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #FECACA', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer' }}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => addManualLabelRow(item.itemKey)}
                          style={{ fontSize: '11px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #DDD8CF', background: '#fff', color: '#6B6860', cursor: 'pointer' }}
                        >
                          Add label row
                        </button>
                        <button
                          onClick={() => resetItemToAutomatic(item)}
                          style={{ fontSize: '11px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #DDD8CF', background: '#F7F3EE', color: '#6B6860', cursor: 'pointer' }}
                        >
                          Reset item to automatic
                        </button>
                      </div>
                      <div style={{ marginTop: '8px', fontSize: '11px', color: manual.valid ? '#3B6D11' : '#A32D2D' }}>
                        {manual.valid ? `Valid split (${manual.total}/${item.totalQty})` : `Mismatch (${manual.total}/${item.totalQty})`}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '10px' }}>
              Out-of-scope items
            </div>
            {processing.outOfScopeItems.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6B6860' }}>No out-of-scope items.</div>
            ) : (
              <div style={{ display: 'grid', gap: '6px' }}>
                {processing.outOfScopeItems.map(item => (
                  <div key={item.itemKey} style={{ fontSize: '12px', color: '#854F0B' }}>
                    {item.item_name || '—'} · qty: {item.quantity ?? 0} · {item.reason}. Analysis check recommended — no ATA rule found.
                  </div>
                ))}
              </div>
            )}
          </div>

          <details style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
            <summary style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', cursor: 'pointer' }}>
              Ignored rows
            </summary>
            <div style={{ marginTop: '10px', display: 'grid', gap: '6px' }}>
              {processing.ignoredItems.length === 0 ? (
                <div style={{ fontSize: '12px', color: '#6B6860' }}>No ignored rows.</div>
              ) : (
                processing.ignoredItems.map((item, idx) => (
                  <div key={`${item.id || idx}`} style={{ fontSize: '12px', color: '#9CA3AF' }}>
                    {item.item_name || '—'} · qty: {item.quantity ?? 0}
                  </div>
                ))
              )}
            </div>
          </details>

          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '10px' }}>
              Labels preview
            </div>
            {previewLabels.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6B6860' }}>No preview labels generated yet.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                {previewLabels.map(label => (
                  <div key={label.id} style={{ background: '#fff', border: '1px solid #D9D9D9', borderRadius: '8px', padding: '14px 12px' }}>
                    <div style={{ textAlign: 'center', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600', fontSize: '18px', color: '#1C1C1E' }}>
                      Duchess & Butler
                    </div>
                    <div style={{ textAlign: 'center', marginTop: '4px', fontSize: '11px', fontWeight: '700', letterSpacing: '0.05em', color: '#1C1C1E' }}>
                      {(selectedOrder.event_name || '').toUpperCase()}
                    </div>
                    <div style={{ textAlign: 'center', marginTop: '2px', fontSize: '11px', color: '#6B6860' }}>
                      {selectedOrder.client_name || '—'}
                    </div>
                    <div style={{ textAlign: 'center', marginTop: '2px', fontSize: '11px', color: '#6B6860' }}>
                      {postcodeDiagnostic.value || '—'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px', fontSize: '10px', color: '#6B6860' }}>
                      <span>Ref: {selectedOrder.crms_ref || '—'}</span>
                      <span>{(label.packagingType || 'unit').toUpperCase()}</span>
                    </div>
                    <div style={{ marginTop: '8px', border: '1.5px solid #1C1C1E', borderRadius: '6px', padding: '8px 6px', textAlign: 'center' }}>
                      <span style={{ fontSize: '14px', fontWeight: '700', color: orderColour.color }}>
                        {label.quantity}x {label.productName}
                      </span>
                    </div>
                    <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#6B6860', textTransform: 'uppercase' }}>
                      <span>{label.category || 'other'}</span>
                      <span>{(label.packagingType || 'unit').toUpperCase()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: '12px', fontSize: '11px', color: '#9CA3AF' }}>
              Print and PDF export will be added in the next phase.
            </div>
          </div>
        </>
      )}
    </div>
  )
}

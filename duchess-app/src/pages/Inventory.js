import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildAtaCapacityMap, normalizeItemName, resolveJobItemRule } from '../lib/labelGenerator'
import { classifyJobItemWorkflow } from '../lib/itemWorkflowClassification'
import { useAuth } from '../contexts/AuthContext'

const ITEM_FETCH_LIMIT = 5000

const WORKFLOW_OPTIONS = [
  'all',
  'operational_candidate',
  'linen',
  'furniture_large_hire',
  'service_fee',
  'display_prop',
  'ignored',
]

const ATA_STATUS_OPTIONS = ['all', 'found', 'missing', 'not_required']

const WORKFLOW_LABELS = {
  operational_candidate: 'Operational label item',
  linen: 'DB Linen Studio',
  furniture_large_hire: 'Furniture / large hire',
  service_fee: 'Service / fee',
  display_prop: 'Display / prop',
  ignored: 'Ignored',
}

const WORKFLOW_ACTION_OPTIONS = [
  { value: 'operational_candidate', label: 'Operational label item' },
  { value: 'linen', label: 'DB Linen Studio' },
  { value: 'furniture_large_hire', label: 'Furniture / large hire' },
  { value: 'service_fee', label: 'Service / fee' },
  { value: 'display_prop', label: 'Display / prop' },
  { value: 'ignored', label: 'Ignored' },
]

function parseQuantity(value) {
  const qty = Number.parseFloat(value)
  return Number.isFinite(qty) ? qty : 0
}

function getDateValue(value) {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export default function Inventory() {
  const { profile } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [overridesWarning, setOverridesWarning] = useState(null)
  const [actionMessage, setActionMessage] = useState(null)
  const [truncated, setTruncated] = useState(false)
  const [rows, setRows] = useState([])
  const [overrideByKey, setOverrideByKey] = useState({})
  const [refreshToken, setRefreshToken] = useState(0)

  const [search, setSearch] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState('all')
  const [ataStatusFilter, setAtaStatusFilter] = useState('all')
  const [needsSetupOnly, setNeedsSetupOnly] = useState(false)

  const [viewOrdersRow, setViewOrdersRow] = useState(null)
  const [classifyRow, setClassifyRow] = useState(null)
  const [classifyWorkflowType, setClassifyWorkflowType] = useState('operational_candidate')
  const [classifyNotes, setClassifyNotes] = useState('')
  const [actionError, setActionError] = useState(null)
  const [actionSaving, setActionSaving] = useState(false)

  const canManageActions = Boolean(profile && profile.active !== false && (profile.role === 'admin' || profile.role === 'operations'))

  useEffect(() => {
    let cancelled = false

    async function loadData() {
      setLoading(true)
      setError(null)
      setOverridesWarning(null)
      setActionError(null)

      const [{ data: jobItems, error: jobItemsError }, { data: jobs, error: jobsError }, { data: ataItems, error: ataError }, { data: overrides, error: overridesError }] = await Promise.all([
        supabase
          .from('crms_job_items')
          .select('id, job_id, item_name, category, quantity')
          .order('id', { ascending: false })
          .limit(ITEM_FETCH_LIMIT + 1),
        supabase
          .from('crms_jobs')
          .select('id, crms_ref, event_name, delivery_date, status'),
        supabase
          .from('ata_items')
          .select('id, name, category, pieces_per_unit, unit_name, active')
          .eq('active', true),
        supabase
          .from('inventory_item_overrides')
          .select('*')
          .eq('active', true),
      ])

      if (cancelled) return

      if (jobItemsError || jobsError || ataError) {
        const message = jobItemsError?.message || jobsError?.message || ataError?.message || 'Failed to load inventory intelligence data.'
        setError(message)
        setRows([])
        setLoading(false)
        return
      }
      if (overridesError) {
        setOverridesWarning('Item overrides could not be loaded. Showing automatic classification only.')
      }

      const allJobItems = jobItems || []
      const isTruncated = allJobItems.length > ITEM_FETCH_LIMIT
      const selectedItems = isTruncated ? allJobItems.slice(0, ITEM_FETCH_LIMIT) : allJobItems
      setTruncated(isTruncated)

      const jobsById = new Map((jobs || []).map(job => [job.id, job]))
      const ataCapacityMap = buildAtaCapacityMap(ataItems || [])
      const overrideMap = new Map()
      const overrideObject = {}
      for (const entry of (overrides || [])) {
        const normalizedName = normalizeItemName(entry.normalized_item_name)
        if (!normalizedName) continue
        const normalizedCategory = normalizeItemName(entry.normalized_category)
        const key = `${normalizedName}||${normalizedCategory}`
        overrideMap.set(key, entry)
        overrideObject[key] = entry
      }
      setOverrideByKey(overrideObject)
      const aggregates = new Map()

      for (const item of selectedItems) {
        const normalizedName = normalizeItemName(item.item_name)
        if (!normalizedName) continue
        const normalizedCategory = normalizeItemName(item.category)
        const aggregateKey = `${normalizedName}||${normalizedCategory}`

        const linkedJob = jobsById.get(item.job_id)
        const jobDateRaw = linkedJob?.delivery_date || null
        const jobDateValue = getDateValue(jobDateRaw)
        const qty = parseQuantity(item.quantity)
        const workflow = classifyJobItemWorkflow(item)

        if (!aggregates.has(aggregateKey)) {
          aggregates.set(aggregateKey, {
            key: aggregateKey,
            itemName: item.item_name || normalizedName,
            normalizedName,
            category: item.category || '—',
            workflowType: workflow.workflowType,
            workflowLabel: WORKFLOW_LABELS[workflow.workflowType] || workflow.label || 'Unknown',
            seenOrderIds: new Set(item.job_id ? [item.job_id] : []),
            seenInOrders: item.job_id ? 1 : 0,
            totalQuantitySeen: qty,
            latestOrderRef: linkedJob?.crms_ref || '—',
            latestOrderDate: jobDateRaw,
            latestOrderDateValue: jobDateValue,
            orderByJob: new Map(item.job_id ? [[item.job_id, {
              jobId: item.job_id,
              orderRef: linkedJob?.crms_ref || '—',
              eventName: linkedJob?.event_name || '—',
              deliveryDate: jobDateRaw || '—',
              status: linkedJob?.status || '—',
              quantity: qty,
              dateValue: jobDateValue,
            }]] : []),
          })
          continue
        }

        const existing = aggregates.get(aggregateKey)
        if (item.job_id) existing.seenOrderIds.add(item.job_id)
        existing.totalQuantitySeen += qty
        if (item.job_id) {
          const existingOrder = existing.orderByJob.get(item.job_id)
          if (existingOrder) {
            existingOrder.quantity += qty
          } else {
            existing.orderByJob.set(item.job_id, {
              jobId: item.job_id,
              orderRef: linkedJob?.crms_ref || '—',
              eventName: linkedJob?.event_name || '—',
              deliveryDate: jobDateRaw || '—',
              status: linkedJob?.status || '—',
              quantity: qty,
              dateValue: jobDateValue,
            })
          }
        }

        if (jobDateValue && (!existing.latestOrderDateValue || jobDateValue > existing.latestOrderDateValue)) {
          existing.latestOrderDateValue = jobDateValue
          existing.latestOrderDate = jobDateRaw
          existing.latestOrderRef = linkedJob?.crms_ref || '—'
          existing.itemName = item.item_name || existing.itemName
        }
      }

      const computedRows = [...aggregates.values()].map(entry => {
        const seenInOrders = entry.seenOrderIds.size
        const normalizedCategoryKey = normalizeItemName(entry.category)
        const rowKey = `${entry.normalizedName}||${normalizedCategoryKey}`
        const ataResult = entry.workflowType === 'operational_candidate'
          ? resolveJobItemRule({ item_name: entry.itemName, category: entry.category }, ataCapacityMap)
          : null
        const autoAtaStatus = entry.workflowType === 'operational_candidate'
          ? (ataResult?.matched ? 'found' : 'missing')
          : 'not_required'
        const rowOverride = overrideMap.get(rowKey)
        if (rowOverride?.hide_from_inventory) return null
        const resolvedWorkflowType = rowOverride?.override_workflow_type || entry.workflowType
        const resolvedAtaResult = resolvedWorkflowType === 'operational_candidate'
          ? resolveJobItemRule({ item_name: entry.itemName, category: entry.category }, ataCapacityMap)
          : null
        const ataStatus = resolvedWorkflowType === 'operational_candidate'
          ? (resolvedAtaResult?.matched ? 'found' : 'missing')
          : 'not_required'
        const capacity = resolvedAtaResult?.matched ? resolvedAtaResult?.rule?.capacity || null : null
        const needsSetup = resolvedWorkflowType === 'operational_candidate' && ataStatus === 'missing'
        const recentOrders = [...entry.orderByJob.values()]
          .sort((a, b) => (b.dateValue || 0) - (a.dateValue || 0))
          .slice(0, 20)

        return {
          key: rowKey,
          item: entry.itemName,
          normalizedName: entry.normalizedName,
          normalizedCategory: normalizedCategoryKey,
          category: entry.category || '',
          autoWorkflowType: entry.workflowType,
          autoAtaStatus,
          workflowType: resolvedWorkflowType,
          workflowLabel: WORKFLOW_LABELS[resolvedWorkflowType] || entry.workflowLabel,
          hasOverride: Boolean(rowOverride),
          overrideId: rowOverride?.id || null,
          overrideNotes: rowOverride?.notes || null,
          ataNotes: rowOverride?.ata_notes || null,
          ataStatus,
          capacity,
          seenInOrders,
          totalQuantitySeen: entry.totalQuantitySeen,
          latestOrderRef: entry.latestOrderRef || '—',
          latestOrderDate: entry.latestOrderDate || '—',
          needsSetup,
          recentOrders,
        }
      }).filter(Boolean).sort((a, b) => a.item.localeCompare(b.item))

      setRows(computedRows)
      setLoading(false)
    }

    loadData()
    return () => { cancelled = true }
  }, [refreshToken])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(row => {
      if (q && !row.item.toLowerCase().includes(q)) return false
      if (workflowFilter !== 'all' && row.workflowType !== workflowFilter) return false
      if (ataStatusFilter !== 'all' && row.ataStatus !== ataStatusFilter) return false
      if (needsSetupOnly && !row.needsSetup) return false
      return true
    })
  }, [ataStatusFilter, needsSetupOnly, rows, search, workflowFilter])

  const summary = useMemo(() => {
    const totalDistinct = rows.length
    const labelReady = rows.filter(r => r.workflowType === 'operational_candidate' && r.ataStatus === 'found').length
    const needsSetup = rows.filter(r => r.needsSetup).length
    const linen = rows.filter(r => r.workflowType === 'linen').length
    const excludedNotRequired = rows.filter(r => r.ataStatus === 'not_required').length
    return { totalDistinct, labelReady, needsSetup, linen, excludedNotRequired }
  }, [rows])

  function triggerRefresh(message) {
    if (message) setActionMessage(message)
    setRefreshToken(prev => prev + 1)
  }

  async function saveOverrideForRow(row, payload) {
    const existing = overrideByKey[row.key]
    if (existing?.id) {
      const { error: updateError } = await supabase
        .from('inventory_item_overrides')
        .update({
          ...payload,
          updated_by_user_id: profile?.id || null,
          updated_by_name: profile?.name || null,
        })
        .eq('id', existing.id)
      return updateError
    }

    const { error: insertError } = await supabase
      .from('inventory_item_overrides')
      .insert({
        normalized_item_name: row.normalizedName,
        normalized_category: row.normalizedCategory || null,
        display_item_name: row.item || null,
        override_workflow_type: payload.override_workflow_type || null,
        hide_from_inventory: Boolean(payload.hide_from_inventory),
        ata_notes: payload.ata_notes || null,
        notes: payload.notes || null,
        active: true,
        created_by_user_id: profile?.id || null,
        created_by_name: profile?.name || null,
        updated_by_user_id: profile?.id || null,
        updated_by_name: profile?.name || null,
      })
    return insertError
  }

  function openClassifyModal(row) {
    setClassifyRow(row)
    setClassifyWorkflowType(row.workflowType || row.autoWorkflowType || 'operational_candidate')
    setClassifyNotes(row.overrideNotes || '')
    setActionError(null)
  }

  async function handleSaveClassify() {
    if (!classifyRow || !canManageActions) return
    setActionSaving(true)
    setActionError(null)
    const existing = overrideByKey[classifyRow.key]
    const errorResult = await saveOverrideForRow(classifyRow, {
      override_workflow_type: classifyWorkflowType,
      notes: classifyNotes || null,
      hide_from_inventory: existing?.hide_from_inventory || false,
      active: true,
    })
    setActionSaving(false)
    if (errorResult) {
      setActionError(errorResult.message || 'Could not save classification override.')
      return
    }
    setClassifyRow(null)
    triggerRefresh('Classification saved.')
  }

  async function handleHideRow(row) {
    if (!canManageActions) return
    const confirmed = window.confirm('Hide this item from Inventory Intelligence? This will not delete RMS history or affect orders.')
    if (!confirmed) return
    setActionSaving(true)
    setActionError(null)
    const existing = overrideByKey[row.key]
    const errorResult = await saveOverrideForRow(row, {
      override_workflow_type: existing?.override_workflow_type || null,
      notes: existing?.notes || 'Hidden from Inventory Intelligence',
      ata_notes: existing?.ata_notes || null,
      hide_from_inventory: true,
      active: true,
    })
    setActionSaving(false)
    if (errorResult) {
      setActionError(errorResult.message || 'Could not hide item.')
      return
    }
    triggerRefresh('Item hidden from Inventory Intelligence.')
  }

  return (
    <div style={{ padding: '6px 2px 20px', fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ marginBottom: '18px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '30px', fontWeight: '600', margin: 0, color: '#1C1C1E' }}>
          Inventory
        </h1>
        <div style={{ marginTop: '8px', fontSize: '13px', color: '#6B6860', lineHeight: 1.5 }}>
          RMS order-item intelligence and label readiness. This is not live stock control.
        </div>
        {truncated && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#86653A' }}>
            Showing recent data sample (latest {ITEM_FETCH_LIMIT} order item lines).
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: '14px', fontSize: '12px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 12px' }}>
          {error}
        </div>
      )}
      {overridesWarning && (
        <div style={{ marginBottom: '14px', fontSize: '12px', color: '#86653A', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '8px', padding: '10px 12px' }}>
          {overridesWarning}
        </div>
      )}
      {actionError && (
        <div style={{ marginBottom: '14px', fontSize: '12px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 12px' }}>
          {actionError}
        </div>
      )}
      {actionMessage && (
        <div style={{ marginBottom: '14px', fontSize: '12px', color: '#2F6A18', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px', padding: '10px 12px' }}>
          {actionMessage}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginBottom: '14px' }}>
        <SummaryCard title="Total distinct items" value={summary.totalDistinct} />
        <SummaryCard title="Label-ready" value={summary.labelReady} />
        <SummaryCard title="Needs setup" value={summary.needsSetup} highlight />
        <SummaryCard title="DB Linen Studio" value={summary.linen} />
        <SummaryCard title="Excluded / not required" value={summary.excludedNotRequired} />
      </div>

      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '10px', alignItems: 'end' }}>
          <div>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860', marginBottom: '6px' }}>Search</div>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search item name"
              style={{ width: '100%', padding: '9px 10px', border: '1px solid #DDD8CF', borderRadius: '8px', fontSize: '13px', background: '#FFFEFC' }}
            />
          </div>

          <FilterSelect
            label="Workflow"
            value={workflowFilter}
            onChange={setWorkflowFilter}
            options={WORKFLOW_OPTIONS}
          />

          <FilterSelect
            label="ATA status"
            value={ataStatusFilter}
            onChange={setAtaStatusFilter}
            options={ATA_STATUS_OPTIONS}
          />

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6B6860', marginBottom: '10px' }}>
            <input type="checkbox" checked={needsSetupOnly} onChange={e => setNeedsSetupOnly(e.target.checked)} />
            Needs setup only
          </label>
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '12px', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: '18px', fontSize: '13px', color: '#6B6860' }}>Loading inventory intelligence...</div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: '18px', fontSize: '13px', color: '#6B6860' }}>No rows match the current filters.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1000px' }}>
            <thead>
              <tr style={{ background: '#F7F3EE', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '10px' }}>
                <th style={th}>Item</th>
                <th style={th}>Category</th>
                <th style={th}>Workflow</th>
                <th style={th}>ATA status</th>
                <th style={th}>Capacity</th>
                <th style={th}>Seen in orders</th>
                <th style={th}>Total qty</th>
                <th style={th}>Latest order</th>
                <th style={th}>Latest date</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(row => (
                <tr key={`${row.normalizedName}:${row.category}`} style={{ borderTop: '1px solid #F0EBE3', background: row.needsSetup ? '#FFF9ED' : '#fff' }}>
                  <td style={tdStrong}>
                    <span>{row.item}</span>
                    {row.hasOverride && (
                      <span style={{ marginLeft: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860', border: '1px solid #DDD8CF', borderRadius: '999px', padding: '1px 6px' }}>
                        Override
                      </span>
                    )}
                    {(row.overrideNotes || row.ataNotes) && (
                      <div style={{ marginTop: '4px', fontSize: '11px', color: '#86653A', fontWeight: '400' }}>
                        {[row.overrideNotes, row.ataNotes].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td style={td}>{row.category || '—'}</td>
                  <td style={td}>{row.workflowLabel}</td>
                  <td style={td}>{row.ataStatus}</td>
                  <td style={td}>{row.capacity ?? '—'}</td>
                  <td style={td}>{row.seenInOrders}</td>
                  <td style={td}>{row.totalQuantitySeen}</td>
                  <td style={td}>{row.latestOrderRef || '—'}</td>
                  <td style={td}>{row.latestOrderDate || '—'}</td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <button onClick={() => setViewOrdersRow(row)} style={actionBtn}>
                        View orders
                      </button>
                      {canManageActions && (
                        <>
                          <button onClick={() => openClassifyModal(row)} style={actionBtn}>
                            Classify
                          </button>
                          <button onClick={() => handleHideRow(row)} disabled={actionSaving} style={actionBtn}>
                            Hide
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {viewOrdersRow && (
        <ModalFrame title="Related orders" onClose={() => setViewOrdersRow(null)}>
          <div style={{ fontSize: '12px', color: '#1C1C1E', fontWeight: '600', marginBottom: '8px' }}>{viewOrdersRow.item}</div>
          {viewOrdersRow.recentOrders.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#6B6860' }}>No related orders found.</div>
          ) : (
            <div style={{ maxHeight: '420px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#F7F3EE', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '10px' }}>
                    <th style={th}>Ref</th>
                    <th style={th}>Event</th>
                    <th style={th}>Delivery date</th>
                    <th style={th}>Qty</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {viewOrdersRow.recentOrders.map(order => (
                    <tr key={`${viewOrdersRow.key}:${order.jobId}`} style={{ borderTop: '1px solid #F0EBE3' }}>
                      <td style={td}>{order.orderRef || '—'}</td>
                      <td style={td}>{order.eventName || '—'}</td>
                      <td style={td}>{order.deliveryDate || '—'}</td>
                      <td style={td}>{order.quantity}</td>
                      <td style={td}>{order.status || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ModalFrame>
      )}

      {classifyRow && (
        <ModalFrame title="Classify item" onClose={() => setClassifyRow(null)}>
          <div style={{ fontSize: '12px', color: '#1C1C1E', marginBottom: '5px' }}><strong>Item:</strong> {classifyRow.item}</div>
          <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '5px' }}><strong>Category:</strong> {classifyRow.category || '—'}</div>
          <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '5px' }}><strong>Current automatic workflow:</strong> {WORKFLOW_LABELS[classifyRow.autoWorkflowType] || classifyRow.autoWorkflowType}</div>
          <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '5px' }}><strong>Current resolved workflow:</strong> {classifyRow.workflowLabel}</div>
          <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '10px' }}><strong>ATA status:</strong> {classifyRow.ataStatus}</div>

          <div style={{ fontSize: '11px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Workflow override</div>
          <select
            value={classifyWorkflowType}
            onChange={e => setClassifyWorkflowType(e.target.value)}
            style={{ width: '100%', padding: '9px 10px', border: '1px solid #DDD8CF', borderRadius: '8px', fontSize: '13px', background: '#FFFEFC', marginBottom: '10px' }}
          >
            {WORKFLOW_ACTION_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>

          <div style={{ fontSize: '11px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Notes (optional)</div>
          <textarea
            value={classifyNotes}
            onChange={e => setClassifyNotes(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: '9px 10px', border: '1px solid #DDD8CF', borderRadius: '8px', fontSize: '13px', background: '#FFFEFC', resize: 'vertical' }}
          />

          <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button onClick={() => setClassifyRow(null)} style={actionBtn}>Cancel</button>
            <button onClick={handleSaveClassify} disabled={actionSaving} style={actionBtn}>
              {actionSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </ModalFrame>
      )}
    </div>
  )
}

function ModalFrame({ title, children, onClose }) {
  return (
    <div style={modalBackdrop}>
      <div style={modalCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '24px', color: '#1C1C1E', fontWeight: '600' }}>{title}</div>
          <button onClick={onClose} style={actionBtn}>Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function SummaryCard({ title, value, highlight = false }) {
  return (
    <div style={{ background: highlight ? '#FFF9ED' : '#fff', border: '1px solid #DDD8CF', borderRadius: '10px', padding: '10px 12px' }}>
      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860' }}>{title}</div>
      <div style={{ marginTop: '6px', fontSize: '23px', fontWeight: '700', color: highlight ? '#9A3412' : '#1C1C1E', lineHeight: 1 }}>
        {value}
      </div>
    </div>
  )
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div>
      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860', marginBottom: '6px' }}>{label}</div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '9px 10px', border: '1px solid #DDD8CF', borderRadius: '8px', fontSize: '13px', background: '#FFFEFC' }}
      >
        {options.map(option => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </div>
  )
}

const th = {
  textAlign: 'left',
  padding: '8px 10px',
}

const td = {
  padding: '9px 10px',
  fontSize: '12px',
  color: '#6B6860',
}

const tdStrong = {
  padding: '9px 10px',
  fontSize: '12px',
  color: '#1C1C1E',
  fontWeight: '600',
}

const actionBtn = {
  fontSize: '11px',
  padding: '6px 9px',
  borderRadius: '7px',
  border: '1px solid #DDD8CF',
  background: '#fff',
  color: '#6B6860',
  cursor: 'pointer',
}

const modalBackdrop = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(28, 28, 30, 0.28)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1200,
  padding: '16px',
}

const modalCard = {
  width: 'min(860px, 96vw)',
  maxHeight: '88vh',
  overflowY: 'auto',
  background: '#fff',
  border: '1px solid #DDD8CF',
  borderRadius: '12px',
  padding: '14px',
}

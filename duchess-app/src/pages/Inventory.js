import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildAtaCapacityMap, normalizeItemName, resolveJobItemRule } from '../lib/labelGenerator'
import { classifyJobItemWorkflow } from '../lib/itemWorkflowClassification'

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [truncated, setTruncated] = useState(false)
  const [rows, setRows] = useState([])

  const [search, setSearch] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState('all')
  const [ataStatusFilter, setAtaStatusFilter] = useState('all')
  const [needsSetupOnly, setNeedsSetupOnly] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadData() {
      setLoading(true)
      setError(null)

      const [{ data: jobItems, error: jobItemsError }, { data: jobs, error: jobsError }, { data: ataItems, error: ataError }] = await Promise.all([
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
      ])

      if (cancelled) return

      if (jobItemsError || jobsError || ataError) {
        const message = jobItemsError?.message || jobsError?.message || ataError?.message || 'Failed to load inventory intelligence data.'
        setError(message)
        setRows([])
        setLoading(false)
        return
      }

      const allJobItems = jobItems || []
      const isTruncated = allJobItems.length > ITEM_FETCH_LIMIT
      const selectedItems = isTruncated ? allJobItems.slice(0, ITEM_FETCH_LIMIT) : allJobItems
      setTruncated(isTruncated)

      const jobsById = new Map((jobs || []).map(job => [job.id, job]))
      const ataCapacityMap = buildAtaCapacityMap(ataItems || [])
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
          })
          continue
        }

        const existing = aggregates.get(aggregateKey)
        if (item.job_id) existing.seenOrderIds.add(item.job_id)
        existing.totalQuantitySeen += qty

        if (jobDateValue && (!existing.latestOrderDateValue || jobDateValue > existing.latestOrderDateValue)) {
          existing.latestOrderDateValue = jobDateValue
          existing.latestOrderDate = jobDateRaw
          existing.latestOrderRef = linkedJob?.crms_ref || '—'
          existing.itemName = item.item_name || existing.itemName
        }
      }

      const computedRows = [...aggregates.values()].map(entry => {
        const seenInOrders = entry.seenOrderIds.size
        const ataResult = entry.workflowType === 'operational_candidate'
          ? resolveJobItemRule({ item_name: entry.itemName, category: entry.category }, ataCapacityMap)
          : null
        const ataStatus = entry.workflowType === 'operational_candidate'
          ? (ataResult?.matched ? 'found' : 'missing')
          : 'not_required'
        const capacity = ataResult?.matched ? ataResult?.rule?.capacity || null : null
        const needsSetup = entry.workflowType === 'operational_candidate' && ataStatus === 'missing'

        return {
          item: entry.itemName,
          normalizedName: entry.normalizedName,
          category: entry.category || '—',
          workflowType: entry.workflowType,
          workflowLabel: entry.workflowLabel,
          ataStatus,
          capacity,
          seenInOrders,
          totalQuantitySeen: entry.totalQuantitySeen,
          latestOrderRef: entry.latestOrderRef || '—',
          latestOrderDate: entry.latestOrderDate || '—',
          needsSetup,
        }
      }).sort((a, b) => a.item.localeCompare(b.item))

      setRows(computedRows)
      setLoading(false)
    }

    loadData()
    return () => { cancelled = true }
  }, [])

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
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(row => (
                <tr key={`${row.normalizedName}:${row.category}`} style={{ borderTop: '1px solid #F0EBE3', background: row.needsSetup ? '#FFF9ED' : '#fff' }}>
                  <td style={tdStrong}>{row.item}</td>
                  <td style={td}>{row.category || '—'}</td>
                  <td style={td}>{row.workflowLabel}</td>
                  <td style={td}>{row.ataStatus}</td>
                  <td style={td}>{row.capacity ?? '—'}</td>
                  <td style={td}>{row.seenInOrders}</td>
                  <td style={td}>{row.totalQuantitySeen}</td>
                  <td style={td}>{row.latestOrderRef || '—'}</td>
                  <td style={td}>{row.latestOrderDate || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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

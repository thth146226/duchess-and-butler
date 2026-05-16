import { useState } from 'react'
import {
  classifyRmsRefreshScanResult,
  countRmsRefreshChanges,
  dryRunScanJobFromRms,
  isApplyBlockedByWarnings,
  isZeroRmsItemsBlocked,
  refreshJobFromRms,
} from '../lib/refreshJobFromRms'

const btnStyle = {
  fontSize: '11px',
  fontWeight: '500',
  padding: '5px 12px',
  borderRadius: '6px',
  cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
  border: '1.5px solid #DDD8CF',
  background: '#fff',
  color: '#1C1C1E',
}

function formatChangedRow(row) {
  const local = row?.local
  const rms = row?.rms
  const name = local?.item_name || rms?.item_name || 'Item'
  const fromQty = local?.quantity ?? '—'
  const toQty = rms?.quantity ?? '—'
  return `${name} (${fromQty} → ${toQty})`
}

export default function RmsJobRefreshPanel({
  job,
  onRefreshed,
  onRowStatusUpdate,
  disabled = false,
  buttonLabel = 'Refresh from RMS',
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [successMessage, setSuccessMessage] = useState(null)

  function closePanel() {
    setOpen(false)
    setResult(null)
    setError(null)
    setSuccessMessage(null)
  }

  async function runDryRun() {
    setOpen(true)
    setLoading(true)
    setError(null)
    setSuccessMessage(null)
    setResult(null)

    try {
      const { result, row } = await dryRunScanJobFromRms(job)
      setResult(result)
      if (typeof onRowStatusUpdate === 'function') {
        onRowStatusUpdate(row)
      }
    } catch (err) {
      setError(err.message || 'RMS refresh failed.')
      if (typeof onRowStatusUpdate === 'function') {
        onRowStatusUpdate(classifyRmsRefreshScanResult({ error: err, job }))
      }
    }

    setLoading(false)
  }

  async function runApply() {
    setApplying(true)
    setError(null)

    try {
      await refreshJobFromRms({ job_id: job.id, apply: true })
      setSuccessMessage('Order refreshed from RMS')
      if (typeof onRefreshed === 'function') {
        await onRefreshed()
      }
      closePanel()
    } catch (err) {
      setError(err.message || 'Failed to apply RMS refresh.')
    }

    setApplying(false)
  }

  const stats = result?.stats
  const diff = result?.diff
  const warnings = result?.warnings || []
  const changeCount = countRmsRefreshChanges(stats)
  const zeroItemsBlocked = Boolean(result && isZeroRmsItemsBlocked(stats, warnings))
  const applyBlocked = isApplyBlockedByWarnings(stats, warnings)
  const upToDate = result && changeCount === 0 && !applyBlocked
  const canApply = result && changeCount > 0 && !applyBlocked && !loading && !applying

  return (
    <>
      <button
        type="button"
        onClick={runDryRun}
        disabled={disabled || loading}
        title={disabled ? 'RMS refresh is only available for Current RMS orders' : undefined}
        style={{
          ...btnStyle,
          opacity: disabled ? 0.45 : 1,
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
        }}
      >
        {loading && !open ? 'Checking RMS…' : buttonLabel}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
          onClick={closePanel}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: '10px',
              border: '1px solid #DDD8CF',
              maxWidth: '480px',
              width: '100%',
              maxHeight: '85vh',
              overflowY: 'auto',
              padding: '18px 20px',
              fontFamily: "'DM Sans', sans-serif",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '12px' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: '600', color: '#1C1C1E' }}>Refresh from RMS</div>
                <div style={{ fontSize: '12px', color: '#6B6860', marginTop: '4px' }}>
                  {job.crms_ref || job.event_name || job.id}
                </div>
              </div>
              <button
                type="button"
                onClick={closePanel}
                style={{ background: '#F7F3EE', border: 'none', borderRadius: '50%', width: '28px', height: '28px', cursor: 'pointer', fontSize: '13px' }}
              >
                ✕
              </button>
            </div>

            {loading && (
              <div style={{ fontSize: '13px', color: '#6B6860', padding: '12px 0' }}>Comparing with Current RMS…</div>
            )}

            {error && (
              <div style={{ fontSize: '12px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', marginBottom: '12px' }}>
                {error}
              </div>
            )}

            {successMessage && (
              <div style={{ fontSize: '12px', color: '#3B6D11', background: '#EAF3DE', border: '1px solid #BBF7D0', borderRadius: '6px', padding: '10px 12px', marginBottom: '12px' }}>
                {successMessage}
              </div>
            )}

            {result && !loading && (
              <>
                {zeroItemsBlocked ? (
                  <div style={{ fontSize: '13px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', marginBottom: '12px', lineHeight: 1.45 }}>
                    RMS returned zero items during this check. Recheck before applying — this is a safety stop, not proof the order has no items.
                  </div>
                ) : upToDate ? (
                  <div style={{ fontSize: '13px', color: '#3B6D11', background: '#EAF3DE', borderRadius: '6px', padding: '10px 12px', marginBottom: '12px' }}>
                    Order is already up to date.
                  </div>
                ) : (
                  <div style={{ fontSize: '13px', color: '#1C1C1E', marginBottom: '12px' }}>
                    RMS changes detected — review before applying.
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px', marginBottom: '12px' }}>
                  {[
                    ['Fetched from RMS', stats?.fetchedFromRms],
                    ['Existing local', stats?.existingLocal],
                    ['Added', stats?.addedFound],
                    ['Changed', stats?.changedFound],
                    ['Stale', stats?.staleFound],
                    ['Unchanged', stats?.unchangedCount],
                  ].map(([label, value]) => (
                    <div key={label} style={{ background: '#F7F3EE', borderRadius: '6px', padding: '8px 10px' }}>
                      <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                      <div style={{ fontWeight: '600', marginTop: '2px' }}>{value ?? 0}</div>
                    </div>
                  ))}
                </div>

                {warnings.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontSize: '11px', fontWeight: '600', color: '#854F0B', marginBottom: '6px' }}>Warnings</div>
                    <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#854F0B', lineHeight: 1.5 }}>
                      {warnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {(diff?.added?.length > 0) && (
                  <Section title="Added items" items={diff.added.map((row) => `${row.item_name} × ${row.quantity}`)} />
                )}

                {(diff?.changed?.length > 0) && (
                  <Section title="Changed items" items={diff.changed.map(formatChangedRow)} />
                )}

                {(diff?.stale?.length > 0) && (
                  <Section title="Stale items (would be removed)" items={diff.stale.map((row) => `${row.item_name} × ${row.quantity}`)} />
                )}

                {applyBlocked && changeCount > 0 && (
                  <div style={{ fontSize: '12px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', marginTop: '12px' }}>
                    {isZeroRmsItemsBlocked(stats, warnings)
                      ? 'Apply is blocked: RMS returned zero items during this check. Recheck before applying — this is a safety stop, not proof the order has no items.'
                      : 'Apply is blocked for safety. Resolve warnings or contact an administrator.'}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
                  {canApply && (
                    <button
                      type="button"
                      onClick={runApply}
                      disabled={applying}
                      style={{
                        ...btnStyle,
                        background: '#1C1C1E',
                        color: '#fff',
                        border: 'none',
                        opacity: applying ? 0.7 : 1,
                      }}
                    >
                      {applying ? 'Applying…' : 'Apply RMS refresh'}
                    </button>
                  )}
                  <button type="button" onClick={closePanel} style={btnStyle}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function Section({ title, items }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ fontSize: '11px', fontWeight: '600', color: '#6B6860', marginBottom: '4px' }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#1C1C1E', lineHeight: 1.45 }}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

import { useMemo, useState } from 'react'
import {
  RMS_STATUS_META,
  buildScanResultsByJobId,
  buildVisibleJobsFingerprint,
  classifyRmsRefreshScanResult,
  dryRunScanJobFromRms,
  hasRmsJobId,
  isSafeToApply,
  refreshJobFromRms,
  runWithConcurrency,
  summariseScanResults,
} from '../lib/refreshJobFromRms'

const SCAN_CONCURRENCY = 2
const APPLY_CONCURRENCY = 1

const btnPrimary = {
  fontSize: '12px',
  fontWeight: '500',
  padding: '8px 16px',
  borderRadius: '6px',
  border: 'none',
  background: '#1C1C1E',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
}

const btnSecondary = {
  fontSize: '12px',
  fontWeight: '500',
  padding: '8px 16px',
  borderRadius: '6px',
  border: '1.5px solid #DDD8CF',
  background: '#fff',
  color: '#1C1C1E',
  cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
}

function panelStyleForPhase(phase) {
  const base = {
    fontFamily: "'DM Sans', sans-serif",
    background: '#fff',
    border: '1px solid #DDD8CF',
    borderRadius: '8px',
    padding: '16px 18px',
    marginBottom: '20px',
    borderLeft: '4px solid #B8965A',
  }
  if (phase === 'results' || phase === 'done') {
    return { ...base, boxShadow: '0 1px 3px rgba(28, 28, 30, 0.06)' }
  }
  return base
}

function SegmentedBar({ summary }) {
  const segments = [
    { key: 'upToDate', count: summary.upToDate, color: RMS_STATUS_META.upToDate.barColor, label: 'Up to date' },
    { key: 'needsRefresh', count: summary.needsRefresh, color: RMS_STATUS_META.needsRefresh.barColor, label: 'Needs refresh' },
    { key: 'issues', count: summary.blocked + summary.errors, color: RMS_STATUS_META.blocked.barColor, label: 'Blocked / errors' },
    { key: 'skipped', count: summary.skipped, color: RMS_STATUS_META.skipped.barColor, label: 'Skipped non-RMS' },
  ]

  const total = segments.reduce((sum, seg) => sum + seg.count, 0)
  if (total === 0) {
    return <div style={{ height: '12px', background: '#F3F4F6', borderRadius: '999px', marginBottom: '10px' }} />
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          height: '14px',
          borderRadius: '999px',
          overflow: 'hidden',
          border: '1px solid #EDE8E0',
          marginBottom: '10px',
        }}
      >
        {segments.filter((seg) => seg.count > 0).map((seg) => (
          <div
            key={seg.key}
            title={`${seg.label}: ${seg.count}`}
            style={{
              flex: seg.count,
              background: seg.color,
              minWidth: seg.count > 0 ? '4px' : 0,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '11px', color: '#6B6860', marginBottom: '14px' }}>
        {segments.map((seg) => (
          <span key={seg.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: seg.color, border: '1px solid #DDD8CF' }} />
            {seg.label}: <strong style={{ color: '#1C1C1E' }}>{seg.count}</strong>
          </span>
        ))}
      </div>
    </>
  )
}

function AlertBanner({ tone, children }) {
  const styles = {
    green: { bg: '#EAF3DE', border: '#BBF7D0', color: '#3B6D11' },
    amber: { bg: '#FEF3C7', border: '#FDE68A', color: '#854F0B' },
    red: { bg: '#FEF2F2', border: '#FECACA', color: '#A32D2D' },
  }
  const s = styles[tone] || styles.amber

  return (
    <div
      style={{
        fontSize: '13px',
        fontWeight: '500',
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: '6px',
        padding: '10px 12px',
        marginBottom: '8px',
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  )
}

function StatusBadge({ status }) {
  const meta = RMS_STATUS_META[status] || RMS_STATUS_META.error
  return (
    <span
      style={{
        fontSize: '10px',
        fontWeight: '600',
        padding: '2px 8px',
        borderRadius: '4px',
        background: meta.bg,
        color: meta.color,
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  )
}

function DetailRow({ row }) {
  const job = row.job
  const stats = row.stats

  return (
    <div style={{ padding: '10px 12px', borderBottom: '1px solid #F3EFE7', display: 'grid', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '12px', fontWeight: '600', color: '#1C1C1E' }}>
            {job?.crms_ref || '—'} · {job?.event_name || '—'}
          </div>
          {row.errorMessage && (
            <div style={{ fontSize: '11px', color: '#A32D2D', marginTop: '4px' }}>{row.errorMessage}</div>
          )}
        </div>
        <StatusBadge status={row.status} />
      </div>
      {stats && (
        <div style={{ fontSize: '11px', color: '#6B6860' }}>
          Added {stats.addedFound || 0} · Changed {stats.changedFound || 0} · Stale {stats.staleFound || 0}
        </div>
      )}
      {row.warnings?.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#854F0B', lineHeight: 1.4 }}>
          {row.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function RmsBulkRefreshPanel({
  jobs = [],
  onScanComplete,
  onReset,
  onPhaseChange,
  onApplyComplete,
}) {
  const [phase, setPhase] = useState('idle')
  const [scanResults, setScanResults] = useState([])
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0, current: null })
  const [applyProgress, setApplyProgress] = useState({ done: 0, total: 0, current: null })
  const [applyOutcome, setApplyOutcome] = useState(null)
  const [panelError, setPanelError] = useState(null)
  const [detailExpanded, setDetailExpanded] = useState(false)

  const rmsJobs = useMemo(() => jobs.filter((job) => hasRmsJobId(job)), [jobs])
  const skippedCount = jobs.length - rmsJobs.length

  const summary = useMemo(() => summariseScanResults(scanResults), [scanResults])

  const detailRows = useMemo(
    () => scanResults.filter((row) => ['needsRefresh', 'blocked', 'error'].includes(row.status)),
    [scanResults],
  )

  const safeToApply = useMemo(() => scanResults.filter(isSafeToApply), [scanResults])

  function setPhaseAndNotify(next) {
    setPhase(next)
    if (typeof onPhaseChange === 'function') onPhaseChange(next)
  }

  function resetToIdle() {
    setPhaseAndNotify('idle')
    setScanResults([])
    setScanProgress({ done: 0, total: 0, current: null })
    setApplyProgress({ done: 0, total: 0, current: null })
    setApplyOutcome(null)
    setPanelError(null)
    setDetailExpanded(false)
    if (typeof onReset === 'function') onReset()
  }

  function notifyScanComplete(results) {
    const byJobId = buildScanResultsByJobId(results)
    const scannedJobIds = Object.keys(byJobId)
    const fingerprint = buildVisibleJobsFingerprint(jobs)
    const scanSummary = summariseScanResults(results)

    if (typeof onScanComplete === 'function') {
      onScanComplete({
        byJobId,
        summary: scanSummary,
        scannedJobIds,
        fingerprint,
      })
    }
  }

  async function runScan() {
    setPhaseAndNotify('scanning')
    setPanelError(null)
    setApplyOutcome(null)
    setScanResults([])
    setDetailExpanded(false)
    setScanProgress({ done: 0, total: rmsJobs.length, current: null })

    const skippedRows = jobs
      .filter((job) => !hasRmsJobId(job))
      .map((job) => classifyRmsRefreshScanResult({ job }))

    if (rmsJobs.length === 0) {
      const results = skippedRows
      setScanResults(results)
      setPhaseAndNotify('results')
      notifyScanComplete(results)
      return
    }

    let completed = 0

    const rmsRows = await runWithConcurrency(rmsJobs, SCAN_CONCURRENCY, async (job) => {
      setScanProgress({ done: completed, total: rmsJobs.length, current: job })

      let row
      try {
        const scanned = await dryRunScanJobFromRms(job)
        row = scanned.row
      } catch (err) {
        row = classifyRmsRefreshScanResult({ error: err, job })
      }

      completed += 1
      setScanProgress({ done: completed, total: rmsJobs.length, current: job })
      return row
    })

    const results = [...skippedRows, ...rmsRows]
    setScanResults(results)
    setScanProgress({ done: rmsJobs.length, total: rmsJobs.length, current: null })
    setPhaseAndNotify('results')
    notifyScanComplete(results)
  }

  async function runApplyAll() {
    const targets = scanResults.filter(isSafeToApply)
    if (!targets.length) return

    setPhaseAndNotify('applying')
    setPanelError(null)
    setApplyOutcome(null)
    setApplyProgress({ done: 0, total: targets.length, current: null })

    let applied = 0
    let failed = 0
    const failures = []

    await runWithConcurrency(targets, APPLY_CONCURRENCY, async (row) => {
      const job = row.job
      setApplyProgress({ done: applied + failed, total: targets.length, current: job })

      try {
        await refreshJobFromRms({ job_id: job.id, apply: true })
        applied += 1
      } catch (err) {
        failed += 1
        failures.push({
          crms_ref: job.crms_ref,
          event_name: job.event_name,
          message: err.message || 'Apply failed',
        })
      }

      setApplyProgress({ done: applied + failed, total: targets.length, current: job })
    })

    if (typeof onApplyComplete === 'function') {
      try {
        await onApplyComplete({ applied, failed, failures })
      } catch (err) {
        setPanelError(err.message || 'Failed to reload paperwork after apply.')
      }
    }

    setApplyOutcome({
      applied,
      failed,
      failures,
      skippedBlocked: summary.skipped + summary.blocked + summary.errors + summary.upToDate,
    })
    setApplyProgress({ done: targets.length, total: targets.length, current: null })
    setPhaseAndNotify('done')
  }

  const scanPercent = scanProgress.total
    ? Math.round((scanProgress.done / scanProgress.total) * 100)
    : 0

  const applyPercent = applyProgress.total
    ? Math.round((applyProgress.done / applyProgress.total) * 100)
    : 0

  const hasResults = phase === 'results' || phase === 'done'
  const allUpToDate =
    hasResults &&
    summary.needsRefresh === 0 &&
    summary.errors === 0 &&
    summary.blocked === 0 &&
    summary.totalChecked > 0

  return (
    <div style={panelStyleForPhase(phase)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '4px' }}>
            RMS Health
          </div>
          <div style={{ fontSize: '13px', color: '#6B6860', lineHeight: 1.45 }}>
            Scan visible orders to check if Paperwork is aligned with Current RMS.
          </div>
          {jobs.length > 0 && (
            <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '6px' }}>
              {jobs.length} visible · {rmsJobs.length} RMS candidates · {skippedCount} skipped non-RMS
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {phase === 'idle' && (
            <button
              type="button"
              onClick={runScan}
              disabled={jobs.length === 0}
              style={{ ...btnPrimary, opacity: jobs.length === 0 ? 0.5 : 1, cursor: jobs.length === 0 ? 'not-allowed' : 'pointer' }}
            >
              Scan visible orders
            </button>
          )}
          {hasResults && (
            <button type="button" onClick={resetToIdle} style={btnSecondary}>
              Scan again
            </button>
          )}
        </div>
      </div>

      {panelError && (
        <div style={{ fontSize: '12px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', marginBottom: '12px' }}>
          {panelError}
        </div>
      )}

      {phase === 'scanning' && (
        <div style={{ marginBottom: '8px' }}>
          <div style={{ fontSize: '12px', color: '#1C1C1E', marginBottom: '6px' }}>
            Checking {scanProgress.done} / {scanProgress.total}
            {scanProgress.current && (
              <span style={{ color: '#6B6860' }}>
                {' '}— {scanProgress.current.crms_ref} · {scanProgress.current.event_name}
              </span>
            )}
          </div>
          <div style={{ height: '8px', background: '#F3F4F6', borderRadius: '999px', overflow: 'hidden' }}>
            <div style={{ width: `${scanPercent}%`, height: '100%', background: '#B8965A', transition: 'width 0.2s ease' }} />
          </div>
        </div>
      )}

      {phase === 'applying' && (
        <div style={{ marginBottom: '8px' }}>
          <div style={{ fontSize: '12px', color: '#1C1C1E', marginBottom: '6px' }}>
            Applying {applyProgress.done} / {applyProgress.total}
            {applyProgress.current && (
              <span style={{ color: '#6B6860' }}>
                {' '}— {applyProgress.current.crms_ref} · {applyProgress.current.event_name}
              </span>
            )}
          </div>
          <div style={{ height: '8px', background: '#F3F4F6', borderRadius: '999px', overflow: 'hidden' }}>
            <div style={{ width: `${applyPercent}%`, height: '100%', background: '#1C1C1E', transition: 'width 0.2s ease' }} />
          </div>
        </div>
      )}

      {hasResults && scanResults.length > 0 && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
              gap: '8px',
              marginBottom: '14px',
            }}
          >
            {[
              ['Checked', summary.totalChecked],
              ['Up to date', summary.upToDate],
              ['Needs refresh', summary.needsRefresh],
              ['Blocked', summary.blocked],
              ['Errors', summary.errors],
              ['Skipped', summary.skipped],
            ].map(([label, value]) => (
              <div key={label} style={{ background: '#F7F3EE', borderRadius: '6px', padding: '8px 10px' }}>
                <div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                <div style={{ fontSize: '18px', fontWeight: '600', color: '#1C1C1E', marginTop: '2px' }}>{value}</div>
              </div>
            ))}
          </div>

          <SegmentedBar summary={summary} />

          {allUpToDate && (
            <AlertBanner tone="green">All visible RMS orders are up to date.</AlertBanner>
          )}

          {summary.needsRefresh > 0 && (
            <AlertBanner tone="amber">
              {summary.needsRefresh} order{summary.needsRefresh !== 1 ? 's' : ''} need RMS refresh before printing paperwork.
            </AlertBanner>
          )}

          {(summary.blocked + summary.errors) > 0 && (
            <AlertBanner tone="red">
              {summary.blocked + summary.errors} order{(summary.blocked + summary.errors) !== 1 ? 's' : ''} need manual review.
            </AlertBanner>
          )}

          {phase === 'results' && safeToApply.length > 0 && (
            <div style={{ marginBottom: '14px' }}>
              <button type="button" onClick={runApplyAll} style={{ ...btnPrimary, padding: '10px 20px', fontSize: '13px' }}>
                Apply all safe refreshes ({safeToApply.length})
              </button>
            </div>
          )}

          {phase === 'done' && applyOutcome && (
            <AlertBanner tone="green">
              <strong>Refresh complete.</strong> Applied {applyOutcome.applied} · Failed {applyOutcome.failed}.
              {' '}Scan again to verify current visible orders.
              {applyOutcome.failures?.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontWeight: '400' }}>
                  {applyOutcome.failures.map((f, i) => (
                    <li key={i}>{f.crms_ref}: {f.message}</li>
                  ))}
                </ul>
              )}
            </AlertBanner>
          )}

          {detailRows.length > 0 && (
            <div style={{ border: '1px solid #EDE8E0', borderRadius: '6px', overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setDetailExpanded((v) => !v)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  background: '#F7F3EE',
                  border: 'none',
                  fontSize: '10px',
                  fontWeight: '600',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: '#6B6860',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                {detailExpanded ? '▼' : '▶'} Needs attention ({detailRows.length})
              </button>
              {detailExpanded && (
                <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
                  {detailRows.map((row) => (
                    <DetailRow key={row.job?.id || row.job?.crms_ref} row={row} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

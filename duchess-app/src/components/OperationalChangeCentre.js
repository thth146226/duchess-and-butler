import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  acknowledgeOperationalChanges,
  canAcknowledgeOperationalChanges,
} from '../lib/acknowledgeOperationalChanges'
import { supabase } from '../lib/supabase'
import {
  OPERATIONAL_FILTERS,
  buildWhatsAppUpdate,
  filterOperationalGroups,
  formatChangeTypeLabel,
  formatEventSummary,
  getQuantityDeltaPresentation,
  quantityDeltaBadgeStyle,
  formatSourceLabel,
  groupOperationalEvents,
  groupsMissingJobDateMetadata,
} from '../lib/operationalChangeCentre'

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts)
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function severityStyle(severity) {
  switch (severity) {
    case 'critical':
      return { bg: '#FCEBEB', color: '#A32D2D' }
    case 'high':
      return { bg: '#FEF3C7', color: '#854F0B' }
    case 'medium':
      return { bg: '#E6F1FB', color: '#0C447C' }
    default:
      return { bg: '#F1EFE8', color: '#5F5E5A' }
  }
}

export default function OperationalChangeCentre() {
  const { profile } = useAuth()
  const canAcknowledge = canAcknowledgeOperationalChanges(profile?.role)
  const [events, setEvents] = useState([])
  const [jobsById, setJobsById] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [copyState, setCopyState] = useState({})
  const [ackState, setAckState] = useState({})
  const [ackErrors, setAckErrors] = useState({})
  const [clipboardFallback, setClipboardFallback] = useState(null)

  const todayIso = useMemo(() => new Date().toISOString().split('T')[0], [])

  const fetchEvents = useCallback(async () => {
    setError(null)
    try {
      const { data, error: queryError } = await supabase
        .from('operational_change_events')
        .select('*')
        .order('detected_at', { ascending: false })
        .limit(200)

      if (queryError) throw queryError

      const rows = data || []
      setEvents(rows)

      const jobIds = [...new Set(rows.map((row) => row.job_id).filter(Boolean))]
      if (jobIds.length === 0) {
        setJobsById({})
        return
      }

      const { data: jobs, error: jobsError } = await supabase
        .from('crms_jobs')
        .select('id, client_name, venue, event_date, delivery_date, collection_date')
        .in('id', jobIds)

      if (jobsError) {
        setJobsById({})
        return
      }

      const map = {}
      for (const job of jobs || []) map[job.id] = job
      setJobsById(map)
    } catch (err) {
      setError(err?.message || 'Failed to load operational change events.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchEvents()
    const channel = supabase.channel('operational-change-centre')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operational_change_events' }, fetchEvents)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchEvents])

  const groups = useMemo(
    () => groupOperationalEvents(events, jobsById),
    [events, jobsById],
  )

  const filteredGroups = useMemo(
    () => filterOperationalGroups(groups, filter, { todayIso }),
    [groups, filter, todayIso],
  )

  const showNext7DaysNote = filter === 'next7days' && groupsMissingJobDateMetadata(groups)

  async function handleCopyWhatsApp(group) {
    const text = buildWhatsAppUpdate(group)
    setClipboardFallback(null)

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        setCopyState((prev) => ({ ...prev, [group.groupKey]: 'copied' }))
        setTimeout(() => {
          setCopyState((prev) => ({ ...prev, [group.groupKey]: 'idle' }))
        }, 2000)
        return
      }
      throw new Error('Clipboard unavailable')
    } catch {
      setCopyState((prev) => ({ ...prev, [group.groupKey]: 'error' }))
      setClipboardFallback({ groupKey: group.groupKey, text })
    }
  }

  async function handleAcknowledge(group) {
    if (!canAcknowledge || !group.hasUnacknowledged) return

    const eventIds = group.events
      .filter((event) => !event.acknowledged_at)
      .map((event) => event.id)
      .filter(Boolean)

    if (eventIds.length === 0) return

    setAckState((prev) => ({ ...prev, [group.groupKey]: 'loading' }))
    setAckErrors((prev) => ({ ...prev, [group.groupKey]: null }))

    try {
      await acknowledgeOperationalChanges({ eventIds })
      setAckState((prev) => ({ ...prev, [group.groupKey]: 'done' }))
      setTimeout(() => {
        setAckState((prev) => ({ ...prev, [group.groupKey]: 'idle' }))
      }, 2000)
      await fetchEvents()
    } catch (err) {
      setAckState((prev) => ({ ...prev, [group.groupKey]: 'error' }))
      setAckErrors((prev) => ({
        ...prev,
        [group.groupKey]: err?.message || 'Failed to acknowledge operational change events.',
      }))
    }
  }

  function acknowledgeButtonLabel(groupKey) {
    const state = ackState[groupKey] || 'idle'
    if (state === 'loading') return 'Acknowledging…'
    if (state === 'done') return 'Acknowledged'
    return 'Mark acknowledged'
  }

  return (
    <section style={{ marginBottom: '28px' }}>
      <div style={S.sectionHeader}>
        <div>
          <div style={S.sectionTitle}>Operational Change Centre</div>
          <div style={S.sectionSub}>
            Important order item changes from manual Refresh from RMS apply.
          </div>
        </div>
        <button type="button" style={S.refreshBtn} onClick={fetchEvents} disabled={loading}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      <div style={S.filterBar}>
        {OPERATIONAL_FILTERS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            style={{ ...S.chip, ...(filter === chip.id ? S.chipActive : {}) }}
            onClick={() => setFilter(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {filter === 'next7days' && showNext7DaysNote && (
        <div style={S.noteBox}>
          Next 7 days requires linked job date metadata. Some orders are shown without delivery/event dates.
        </div>
      )}

      {loading && (
        <div style={S.stateBox}>Loading operational changes…</div>
      )}

      {!loading && error && (
        <div style={S.errorBox}>
          {error}
          <button type="button" style={S.retryBtn} onClick={fetchEvents}>Try again</button>
        </div>
      )}

      {!loading && !error && filteredGroups.length === 0 && (
        <div style={S.stateBox}>
          <div style={{ fontWeight: '500', color: '#1C1C1E', marginBottom: '6px' }}>
            No operational item changes yet.
          </div>
          <div>
            Events appear after manual Refresh from RMS Apply detects item changes.
          </div>
        </div>
      )}

      {!loading && !error && filteredGroups.map((group) => (
        <div key={group.groupKey} style={S.groupCard}>
          <div style={S.groupHeader}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.groupTitle}>
                {group.jobRef || group.crmsId || 'Order'}
                <span style={{
                  ...S.statusPill,
                  background: group.hasUnacknowledged ? '#EFF6FF' : '#EAF3DE',
                  color: group.hasUnacknowledged ? '#1D4ED8' : '#3B6D11',
                }}>
                  {group.statusLabel}
                </span>
              </div>
              <div style={S.groupSub}>{group.eventName}</div>
              {group.job && (
                <div style={S.groupMeta}>
                  {[
                    group.job.client_name,
                    group.job.venue,
                    group.job.event_date && `Event ${group.job.event_date}`,
                    group.job.delivery_date && `Del ${group.job.delivery_date}`,
                    group.job.collection_date && `Col ${group.job.collection_date}`,
                  ].filter(Boolean).join(' · ')}
                </div>
              )}
              <div style={S.groupMeta}>
                {group.eventCount} change{group.eventCount === 1 ? '' : 's'} · Latest {timeAgo(group.latestDetectedAt)} · {group.sourceLabel}
              </div>
            </div>
            <div style={S.groupActions}>
              {canAcknowledge && group.hasUnacknowledged && (
                <button
                  type="button"
                  style={{
                    ...S.copyBtn,
                    ...(ackState[group.groupKey] === 'loading' ? S.actionBtnDisabled : {}),
                  }}
                  onClick={() => handleAcknowledge(group)}
                  disabled={ackState[group.groupKey] === 'loading'}
                >
                  {acknowledgeButtonLabel(group.groupKey)}
                </button>
              )}
              <button
                type="button"
                style={S.copyBtn}
                onClick={() => handleCopyWhatsApp(group)}
              >
                {copyState[group.groupKey] === 'copied' ? 'Copied' : 'Copy WhatsApp update'}
              </button>
            </div>
          </div>

          {ackErrors[group.groupKey] && (
            <div style={S.ackErrorBox}>
              {ackErrors[group.groupKey]}
            </div>
          )}

          {clipboardFallback?.groupKey === group.groupKey && (
            <div style={S.fallbackBox}>
              <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '6px' }}>
                Clipboard unavailable — copy manually:
              </div>
              <textarea
                readOnly
                value={clipboardFallback.text}
                style={S.fallbackTextarea}
                onFocus={(e) => e.target.select()}
              />
            </div>
          )}

          <div style={S.eventList}>
            {group.events.map((event) => {
              const sev = severityStyle(event.severity)
              return (
                <div key={event.id} style={S.eventRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ marginBottom: '4px' }}>
                      <span style={{
                        fontSize: '10px',
                        fontWeight: '600',
                        padding: '2px 7px',
                        borderRadius: '4px',
                        marginRight: '8px',
                        background: sev.bg,
                        color: sev.color,
                        textTransform: 'uppercase',
                      }}>
                        {event.severity || 'high'}
                      </span>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: '#1C1C1E' }}>
                        {formatChangeTypeLabel(event.change_type)}
                      </span>
                    </div>
                    <div style={{ fontSize: '13px', color: '#1C1C1E' }}>
                      {formatEventSummary(event)}
                    </div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '4px' }}>
                      {formatSourceLabel(event.source)} · {timeAgo(event.detected_at)}
                      {event.acknowledged_at ? ' · Acknowledged' : ''}
                      {event.whatsapp_posted_at ? ' · WhatsApp posted' : ''}
                    </div>
                    {event.change_type === 'item_quantity_changed' && (() => {
                      const delta = getQuantityDeltaPresentation(event.quantity_delta)
                      return (
                        <div style={S.quantityRow}>
                          <span style={S.quantityItemName}>{event.item_name}</span>
                          <span style={S.quantityValues}>
                            {event.old_quantity ?? '—'} → {event.new_quantity ?? '—'}
                          </span>
                          {delta.visible && (
                            <span style={{ ...S.quantityDeltaBadge, ...quantityDeltaBadgeStyle(delta.tone) }}>
                              {delta.label}
                            </span>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </section>
  )
}

const S = {
  sectionHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '12px',
  },
  sectionTitle: {
    fontSize: '16px',
    fontWeight: '600',
    color: '#1C1C1E',
    marginBottom: '4px',
  },
  sectionSub: {
    fontSize: '12px',
    color: '#6B6860',
    lineHeight: 1.45,
  },
  refreshBtn: {
    fontSize: '12px',
    padding: '6px 14px',
    borderRadius: '4px',
    border: '1px solid #DDD8CF',
    background: '#fff',
    color: '#1C1C1E',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    flexShrink: 0,
  },
  filterBar: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    marginBottom: '12px',
  },
  chip: {
    fontSize: '12px',
    padding: '6px 14px',
    borderRadius: '20px',
    border: '1px solid #DDD8CF',
    background: 'transparent',
    color: '#6B6860',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  },
  chipActive: {
    background: '#1C1C1E',
    color: '#fff',
    borderColor: '#1C1C1E',
  },
  noteBox: {
    fontSize: '12px',
    color: '#854F0B',
    background: '#FFFBEB',
    border: '1px solid #FDE68A',
    borderRadius: '6px',
    padding: '10px 12px',
    marginBottom: '12px',
  },
  stateBox: {
    background: '#fff',
    border: '1px solid #DDD8CF',
    borderRadius: '8px',
    padding: '28px 20px',
    textAlign: 'center',
    color: '#6B6860',
    fontSize: '13px',
    lineHeight: 1.5,
  },
  errorBox: {
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: '8px',
    padding: '16px',
    color: '#A32D2D',
    fontSize: '13px',
    marginBottom: '12px',
  },
  retryBtn: {
    marginLeft: '10px',
    fontSize: '12px',
    padding: '4px 10px',
    borderRadius: '4px',
    border: '1px solid #FECACA',
    background: '#fff',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
  },
  groupCard: {
    background: '#fff',
    border: '1px solid #DDD8CF',
    borderRadius: '8px',
    marginBottom: '12px',
    overflow: 'hidden',
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '14px 16px',
    borderBottom: '1px solid #EDE8E0',
    background: '#FAFAF8',
  },
  groupTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#1C1C1E',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  statusPill: {
    fontSize: '10px',
    fontWeight: '600',
    padding: '2px 8px',
    borderRadius: '10px',
  },
  groupSub: {
    fontSize: '13px',
    color: '#1C1C1E',
    marginTop: '4px',
  },
  groupMeta: {
    fontSize: '11px',
    color: '#6B6860',
    marginTop: '4px',
  },
  groupActions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '6px',
    flexShrink: 0,
  },
  copyBtn: {
    fontSize: '11px',
    padding: '6px 12px',
    borderRadius: '4px',
    border: '1px solid #DDD8CF',
    background: '#fff',
    color: '#1C1C1E',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    flexShrink: 0,
  },
  actionBtnDisabled: {
    opacity: 0.7,
    cursor: 'not-allowed',
  },
  ackErrorBox: {
    padding: '10px 16px',
    borderBottom: '1px solid #EDE8E0',
    background: '#FEF2F2',
    color: '#A32D2D',
    fontSize: '12px',
  },
  fallbackBox: {
    padding: '12px 16px',
    borderBottom: '1px solid #EDE8E0',
    background: '#FFFBEB',
  },
  fallbackTextarea: {
    width: '100%',
    minHeight: '120px',
    fontSize: '12px',
    fontFamily: "'DM Sans', sans-serif",
    border: '1px solid #DDD8CF',
    borderRadius: '6px',
    padding: '8px',
    resize: 'vertical',
  },
  eventList: {
    padding: '0 16px',
  },
  eventRow: {
    padding: '12px 0',
    borderBottom: '0.5px solid #EDE8E0',
    display: 'flex',
    gap: '10px',
  },
  quantityRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '10px',
    marginTop: '6px',
    fontSize: '12px',
    color: '#1C1C1E',
  },
  quantityItemName: {
    fontWeight: '500',
    color: '#1C1C1E',
  },
  quantityValues: {
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '0.01em',
  },
  quantityDeltaBadge: {
    fontSize: '11px',
    fontWeight: '600',
    padding: '2px 8px',
    borderRadius: '10px',
    lineHeight: 1.35,
    fontVariantNumeric: 'tabular-nums',
  },
}

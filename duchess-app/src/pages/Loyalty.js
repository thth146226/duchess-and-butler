import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

const C = {
  charcoal: '#1A1A1A',
  charcoalSoft: '#2A2A2A',
  champagne: '#C9A962',
  champagneMuted: '#A88845',
  ivory: '#F5F1E8',
  ivoryWarm: '#EFE9DA',
  graySoph: '#8B8680',
  grayFog: '#C8C4BD',
  border: '#E5E1D8',
  cardBg: '#FDFBF7',
}

function formatGBPFromPence(pence) {
  const n = Number(pence)
  if (!Number.isFinite(n)) return '£0'
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n / 100)
}

/** URL-safe opaque token — 256 bits from CSPRG; not suitable for secrecy if logged, safe for uniqueness and future portal binds. */
function generatePortalToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function displayTierFriendly(tier) {
  const t = (tier || '').trim().toLowerCase()
  if (t === 'standard') return 'Pearl'
  return tier || '—'
}

function getPointValuePence(settingsRow) {
  const pv = Number(settingsRow?.point_value_pence)
  return Number.isFinite(pv) && pv > 0 ? pv : 0.5
}

/** Mirrors programme setting: GBP value implied by available points (no extra ledger rounding rules). */
function estimateAvailableRewardPence(availablePoints, settingsRow) {
  const pts = Number(availablePoints) || 0
  return Math.round(pts * getPointValuePence(settingsRow))
}

function fmtActivityDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

function activityReasonSnippet(tx) {
  const bits = []
  if (tx.reason && String(tx.reason).trim()) bits.push(String(tx.reason).trim())
  if (tx.event_name && String(tx.event_name).trim()) bits.push(String(tx.event_name).trim())
  const s = bits.join(' · ')
  return s.length ? s.slice(0, 140) : '—'
}

function formatPointsUi(n) {
  const x = Number(n) || 0
  return x.toLocaleString('en-GB')
}

function aggregateTransactions(rows) {
  let available = 0
  let pending = 0
  let redeemedPence = 0
  let needsCount = 0
  if (!rows?.length) {
    return { available, pending, redeemedPence, needsCount }
  }
  for (const t of rows) {
    if (t.needs_attention === true) needsCount += 1
    const st = t.status
    const pts = Number(t.points) || 0
    const vp = Number(t.value_pence) || 0
    const typ = t.transaction_type
    if (st === 'available') available += pts
    if (st === 'suggested' || st === 'pending') pending += pts
    if (st === 'redeemed' && typ === 'redeem') redeemedPence += Math.abs(vp)
  }
  return { available, pending, redeemedPence, needsCount }
}

export default function Loyalty() {
  const [loading, setLoading] = useState(true)
  const [tablesActive, setTablesActive] = useState(false)
  const [activeSettings, setActiveSettings] = useState(null)
  const [metrics, setMetrics] = useState({
    enrolled: 0,
    available: 0,
    pending: 0,
    redeemedPence: 0,
    needsCount: 0,
  })
  const [needsRows, setNeedsRows] = useState([])
  const [clientsRows, setClientsRows] = useState([])
  const [allTxs, setAllTxs] = useState([])
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [enrollName, setEnrollName] = useState('')
  const [enrollEmail, setEnrollEmail] = useState('')
  const [enrollCrms, setEnrollCrms] = useState('')
  const [enrollSubmitting, setEnrollSubmitting] = useState(false)
  const [enrollFormError, setEnrollFormError] = useState('')
  const [enrollBanner, setEnrollBanner] = useState(null)
  const enrollBusyRef = useRef(false)

  const [profileClientId, setProfileClientId] = useState(null)
  const [profileTxRows, setProfileTxRows] = useState([])
  const [profileTxState, setProfileTxState] = useState('idle')

  const load = useCallback(async () => {
    setLoading(true)
    setActiveSettings(null)
    const fallback = {
      enrolled: 0,
      available: 0,
      pending: 0,
      redeemedPence: 0,
      needsCount: 0,
    }
    const { error: clientsErr } = await supabase
      .from('loyalty_clients')
      .select('id')
      .limit(1)

    if (clientsErr) {
      console.warn('[duchess-rewards] loyalty tables unavailable')
      setTablesActive(false)
      setActiveSettings(null)
      setMetrics(fallback)
      setNeedsRows([])
      setClientsRows([])
      setAllTxs([])
      setLoading(false)
      return
    }

    const { count: enrolled, error: countErr } = await supabase
      .from('loyalty_clients')
      .select('*', { count: 'exact', head: true })

    if (countErr) {
      console.warn('[duchess-rewards] loyalty tables unavailable')
      setTablesActive(false)
      setActiveSettings(null)
      setMetrics(fallback)
      setNeedsRows([])
      setClientsRows([])
      setAllTxs([])
      setLoading(false)
      return
    }

    setTablesActive(true)

    const { data: txs, error: txsErr } = await supabase
      .from('loyalty_transactions')
      .select('loyalty_client_id, points, value_pence, status, transaction_type, needs_attention')

    if (txsErr) {
      console.warn('[duchess-rewards] loyalty tables unavailable')
      setTablesActive(false)
      setActiveSettings(null)
      setMetrics({ ...fallback, enrolled: enrolled ?? 0 })
      setNeedsRows([])
      setClientsRows([])
      setAllTxs([])
      setLoading(false)
      return
    }

    const { data: setData, error: setErr } = await supabase
      .from('loyalty_settings')
      .select(
        'point_value_pence, base_reward_percent, linen_bonus_percent, chair_bonus_percent, furniture_bonus_percent, availability_delay_days',
      )
      .eq('active', true)
      .limit(1)

    if (!setErr && setData?.length) {
      setActiveSettings(setData[0])
    } else {
      setActiveSettings(null)
      if (setErr) console.warn('[duchess-rewards] loyalty settings read skipped')
    }

    const txRows = txs || []
    setAllTxs(txRows)
    const agg = aggregateTransactions(txRows)
    setMetrics({
      enrolled: enrolled ?? 0,
      ...agg,
    })

    const { data: cliData, error: cliErr } = await supabase
      .from('loyalty_clients')
      .select('id, client_name, client_email, crms_client_id, tier, status, created_at')
      .order('created_at', { ascending: false })
      .limit(50)

    let clients = cliData || []
    if (!cliErr && cliData) {
      setClientsRows(cliData)
    } else {
      clients = []
      setClientsRows([])
      if (cliErr) console.warn('[duchess-rewards] loyalty clients list skipped')
    }

    const nameByClientId = Object.fromEntries(clients.map((c) => [c.id, c.client_name]))

    const { data: naData, error: naErr } = await supabase
      .from('loyalty_transactions')
      .select('id, loyalty_client_id, points, status, needs_attention_reason, created_at, event_name, crms_ref')
      .eq('needs_attention', true)
      .order('created_at', { ascending: false })
      .limit(5)

    if (!naErr && naData?.length) {
      setNeedsRows(
        naData.map((row) => ({
          ...row,
          loyalty_clients: { client_name: nameByClientId[row.loyalty_client_id] || null },
        })),
      )
    } else {
      setNeedsRows([])
      if (naErr) console.warn('[duchess-rewards] loyalty needs_attention fetch skipped')
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const resetEnrollForm = useCallback(() => {
    setEnrollName('')
    setEnrollEmail('')
    setEnrollCrms('')
    setEnrollFormError('')
  }, [])

  const openEnrollModal = useCallback(() => {
    setProfileClientId(null)
    setEnrollBanner(null)
    resetEnrollForm()
    setEnrollOpen(true)
  }, [resetEnrollForm])

  const openClientProfile = useCallback((clientId) => {
    setEnrollOpen(false)
    setProfileClientId(clientId)
  }, [])

  const closeClientProfile = useCallback(() => {
    setProfileClientId(null)
    setProfileTxRows([])
    setProfileTxState('idle')
  }, [])

  const closeEnrollModal = useCallback(() => {
    if (enrollBusyRef.current) return
    setEnrollOpen(false)
    resetEnrollForm()
  }, [resetEnrollForm])

  function findDuplicatesInLoaded(emailNorm, crmsTrim) {
    if (emailNorm) {
      const hit = clientsRows.some(
        (c) =>
          typeof c.client_email === 'string' &&
          c.client_email.trim().toLowerCase() === emailNorm,
      )
      if (hit) return { field: 'email' }
    }
    if (crmsTrim && crmsTrim.length > 0) {
      const hit = clientsRows.some(
        (c) =>
          c.crms_client_id != null &&
          String(c.crms_client_id).trim() === crmsTrim,
      )
      if (hit) return { field: 'crms' }
    }
    return null
  }

  function enrollmentPermissionDenied(err) {
    const code = err?.code
    const msg = (err?.message || '').toLowerCase()
    if (code === '42501') return true
    if (code === 'PGRST301') return true
    if (msg.includes('permission') || msg.includes('rls')) return true
    return false
  }

  async function submitEnrollment(e) {
    e.preventDefault()
    setEnrollFormError('')
    setEnrollBanner(null)
    const nameTrim = enrollName.trim()
    const emailTrim = enrollEmail.trim()
    const crmsTrim = enrollCrms.trim()
    const emailNorm = emailTrim.length ? emailTrim.toLowerCase() : ''

    if (!nameTrim.length) {
      setEnrollFormError('Client name is required.')
      return
    }

    const dup = findDuplicatesInLoaded(emailNorm, crmsTrim)
    if (dup?.field === 'email') {
      setEnrollFormError('Another rewards client already uses this email address.')
      return
    }
    if (dup?.field === 'crms') {
      setEnrollFormError('Another rewards client already uses this CRMS client ID.')
      return
    }

    enrollBusyRef.current = true
    setEnrollSubmitting(true)

    let insertError = null
    try {
      insertLoop: for (let attempt = 0; attempt < 2; attempt++) {
        const portal_token = generatePortalToken()
        const { error } = await supabase.from('loyalty_clients').insert({
          client_name: nameTrim,
          client_email: emailTrim.length ? emailTrim : null,
          crms_client_id: crmsTrim.length ? crmsTrim : null,
          portal_token,
          status: 'active',
          tier: 'standard',
        })
        if (!error) {
          insertError = null
          break insertLoop
        }
        insertError = error
        if (String(error.code) === '23505' && attempt === 0) continue
        break insertLoop
      }
    } finally {
      enrollBusyRef.current = false
      setEnrollSubmitting(false)
    }

    if (insertError) {
      console.warn('[duchess-rewards] client enrolment failed')
      if (enrollmentPermissionDenied(insertError)) {
        setEnrollFormError('You do not have permission to enrol rewards clients.')
      } else {
        setEnrollFormError('Could not enrol this client. Please try again.')
      }
      return
    }

    setEnrollOpen(false)
    resetEnrollForm()
    setEnrollBanner({ kind: 'ok', message: 'Client enrolled in Duchess Rewards.' })
    try {
      await load()
    } catch {
      console.warn('[duchess-rewards] loyalty clients refresh failed')
    }
  }

  useEffect(() => {
    if (!enrollBanner || enrollBanner.kind !== 'ok') return
    const t = window.setTimeout(() => setEnrollBanner(null), 6000)
    return () => clearTimeout(t)
  }, [enrollBanner])

  useEffect(() => {
    if (!enrollOpen && !profileClientId) return
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return
      if (enrollBusyRef.current) return
      if (profileClientId) {
        closeClientProfile()
        return
      }
      if (enrollOpen) {
        setEnrollOpen(false)
        resetEnrollForm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enrollOpen, profileClientId, resetEnrollForm, closeClientProfile])

  useEffect(() => {
    if (!profileClientId) {
      setProfileTxRows([])
      setProfileTxState('idle')
      return
    }
    let cancelled = false
    setProfileTxState('loading')
    setProfileTxRows([])
    async function fetchActivity() {
      const { data, error } = await supabase
        .from('loyalty_transactions')
        .select('id, created_at, transaction_type, status, points, value_pence, reason, event_name, needs_attention')
        .eq('loyalty_client_id', profileClientId)
        .order('created_at', { ascending: false })
        .limit(25)
      if (cancelled) return
      if (error) {
        console.warn('[duchess-rewards] client activity load failed')
        setProfileTxState('error')
        setProfileTxRows([])
        return
      }
      setProfileTxRows(data || [])
      setProfileTxState('ok')
    }
    fetchActivity()
    return () => {
      cancelled = true
    }
  }, [profileClientId])

  const badgeLabel = useMemo(() => {
    if (tablesActive) return 'Database active'
    return 'Admin preview'
  }, [tablesActive])

  const clientRollups = useMemo(() => {
    const m = {}
    for (const t of allTxs) {
      const cid = t.loyalty_client_id
      if (!cid) continue
      if (!m[cid]) m[cid] = { av: 0, pe: 0, reP: 0 }
      const st = t.status
      const pts = Number(t.points) || 0
      const vp = Number(t.value_pence) || 0
      if (st === 'available') m[cid].av += pts
      if (st === 'suggested' || st === 'pending') m[cid].pe += pts
      if (st === 'redeemed' && t.transaction_type === 'redeem') m[cid].reP += Math.abs(vp)
    }
    return m
  }, [allTxs])

  const profileClient = useMemo(() => {
    if (!profileClientId) return null
    return clientsRows.find((c) => c.id === profileClientId) ?? null
  }, [clientsRows, profileClientId])

  const profileRollup =
    profileClientId && clientRollups[profileClientId]
      ? clientRollups[profileClientId]
      : { av: 0, pe: 0, reP: 0 }

  const profileNeedsReview =
    profileTxState === 'ok' && profileTxRows.some((t) => t.needs_attention === true)

  const subtitle =
    'Manage loyalty points, pending approvals and client reward balances.'

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", color: C.charcoal, maxWidth: '1200px' }}>
      {/* Header */}
      <div style={{ marginBottom: '28px', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <h1
              style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: '32px',
                fontWeight: 600,
                margin: 0,
                letterSpacing: '0.02em',
                color: C.charcoal,
              }}
            >
              Duchess Rewards
            </h1>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: tablesActive ? C.champagneMuted : C.graySoph,
                border: `1px solid ${C.grayFog}`,
                background: tablesActive ? C.ivoryWarm : C.ivory,
                padding: '5px 10px',
                borderRadius: '4px',
              }}
            >
              {badgeLabel}
            </span>
          </div>
          <p style={{ margin: '10px 0 0', fontSize: '15px', color: C.graySoph, maxWidth: '560px', lineHeight: 1.5 }}>
            {subtitle}
          </p>
        </div>
      </div>

      {/* Metric cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '14px',
          marginBottom: '24px',
        }}
      >
        {[
          { label: 'Enrolled Clients', value: loading ? '…' : String(metrics.enrolled) },
          { label: 'Available Points', value: loading ? '…' : metrics.available.toLocaleString('en-GB') },
          { label: 'Pending Points', value: loading ? '…' : metrics.pending.toLocaleString('en-GB') },
          { label: 'Redeemed Value', value: loading ? '…' : formatGBPFromPence(metrics.redeemedPence) },
          { label: 'Needs Attention', value: loading ? '…' : String(metrics.needsCount) },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              background: C.cardBg,
              border: `1px solid ${C.border}`,
              borderRadius: '10px',
              padding: '18px 20px',
              boxShadow: '0 1px 0 rgba(26,26,26,0.04)',
            }}
          >
            <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.graySoph, marginBottom: '10px', fontWeight: 600 }}>
              {card.label}
            </div>
            <div style={{ fontSize: '24px', fontWeight: 600, color: C.charcoalSoft, fontFamily: "'Cormorant Garamond', serif" }}>{card.value}</div>
          </div>
        ))}
      </div>

      {/* Foundation / database status */}
      {!loading && tablesActive && (
        <div
          style={{
            background: `linear-gradient(135deg, #F8F9F7 0%, ${C.ivoryWarm} 100%)`,
            border: `1px solid ${C.border}`,
            borderLeft: `4px solid ${C.champagneMuted}`,
            borderRadius: '10px',
            padding: '20px 22px',
            marginBottom: '20px',
          }}
        >
          <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: 600, color: C.charcoal, marginBottom: '10px' }}>
            Duchess Rewards database active
          </div>
          <p style={{ margin: 0, fontSize: '14px', color: C.graySoph, lineHeight: 1.6, maxWidth: '720px' }}>
            The loyalty foundation is active. You can now begin enrolling clients and reviewing reward activity once the next workflow steps are enabled.
          </p>
          <ul style={{ margin: '16px 0 0', paddingLeft: '20px', fontSize: '13px', color: C.charcoalSoft, lineHeight: 1.85, listStyle: 'disc' }}>
            <li style={{ marginBottom: '4px' }}><strong style={{ fontWeight: 600, color: C.charcoal }}>Foundation SQL:</strong> Applied</li>
            <li style={{ marginBottom: '4px' }}><strong style={{ fontWeight: 600, color: C.charcoal }}>RLS:</strong> Active</li>
            <li style={{ marginBottom: '4px' }}><strong style={{ fontWeight: 600, color: C.charcoal }}>Access:</strong> Admin only</li>
            <li><strong style={{ fontWeight: 600, color: C.charcoal }}>Client portal:</strong> Not enabled yet</li>
          </ul>
        </div>
      )}

      {!loading && !tablesActive && (
        <div
          style={{
            background: `linear-gradient(135deg, ${C.ivory} 0%, ${C.ivoryWarm} 100%)`,
            border: `1px solid ${C.border}`,
            borderLeft: `4px solid ${C.champagne}`,
            borderRadius: '10px',
            padding: '20px 22px',
            marginBottom: '28px',
          }}
        >
          <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '20px', fontWeight: 600, color: C.charcoal, marginBottom: '10px' }}>
            Duchess Rewards foundation
          </div>
          <p style={{ margin: 0, fontSize: '14px', color: C.graySoph, lineHeight: 1.6 }}>
            The database scripts are prepared in the repo for manual Supabase setup. Apply the reviewed SQL{' '}
            <strong style={{ fontWeight: 600, color: C.charcoalSoft }}>in this order</strong> when ready to activate loyalty data:
          </p>
          <ul style={{ margin: '14px 0 0', paddingLeft: '20px', fontSize: '13px', color: C.graySoph, lineHeight: 1.75 }}>
            <li style={{ marginBottom: '6px' }}>
              <code style={{ background: 'rgba(26,26,26,0.06)', padding: '2px 6px', borderRadius: '4px', fontSize: '13px' }}>src/database/duchess_rewards_foundation.sql</code>{' '}
              — tables, indexes and seed settings
            </li>
            <li>
              <code style={{ background: 'rgba(26,26,26,0.06)', padding: '2px 6px', borderRadius: '4px', fontSize: '13px' }}>src/database/duchess_rewards_rls.sql</code>{' '}
              — row level security before production reads/writes from the admin app
            </li>
          </ul>
          <p style={{ margin: '14px 0 0', fontSize: '14px', color: C.charcoalSoft, fontWeight: 500 }}>
            Loyalty tables are not active from this workspace yet. Metrics above show zeros until connectivity and migration are confirmed.
          </p>
        </div>
      )}

      {/* Active settings preview (read-only) */}
      {loading ? null : tablesActive && activeSettings ? (
        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: '10px',
            padding: '16px 20px',
            marginBottom: '28px',
            background: '#fff',
          }}
        >
          <div style={{ fontSize: '11px', letterSpacing: '0.1em', textTransform: 'uppercase', color: C.graySoph, fontWeight: 600, marginBottom: '12px' }}>
            Active programme settings · read-only
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '10px 20px',
              fontSize: '13px',
              color: C.charcoalSoft,
            }}
          >
            <div>
              <strong style={{ color: C.charcoal, fontWeight: 600 }}>Point value</strong>
              <div>
                {(() => {
                  const pv = Number(activeSettings.point_value_pence)
                  const v = Number.isFinite(pv) ? pv : 0.5
                  const display = Number.isInteger(v) ? String(v) : String(v).replace(/\.?0+$/, '')
                  return <>1 point = {display}p</>
                })()}
              </div>
            </div>
            <div>
              <strong style={{ color: C.charcoal, fontWeight: 600 }}>Base reward</strong>
              <div>{Number(activeSettings.base_reward_percent) || 3}%</div>
            </div>
            <div>
              <strong style={{ color: C.charcoal, fontWeight: 600 }}>Linen bonus</strong>
              <div>{Number(activeSettings.linen_bonus_percent) || 20}%</div>
            </div>
            <div>
              <strong style={{ color: C.charcoal, fontWeight: 600 }}>Chair bonus</strong>
              <div>{Number(activeSettings.chair_bonus_percent) || 15}%</div>
            </div>
            <div>
              <strong style={{ color: C.charcoal, fontWeight: 600 }}>Furniture bonus</strong>
              <div>{Number(activeSettings.furniture_bonus_percent) || 15}%</div>
            </div>
            <div>
              <strong style={{ color: C.charcoal, fontWeight: 600 }}>Availability delay</strong>
              <div>{Number(activeSettings.availability_delay_days) || 3} days</div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Needs Attention */}
      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ ...sectionTitle }}>Needs Attention</h2>
        <p style={sectionMuted}>
          Orders with unclear client matches, missing eligible value or uncertain category bonuses will appear here for admin review.
        </p>
        {needsRows.length === 0 ? (
          <div style={emptyBox}>No loyalty records need review yet.</div>
        ) : (
          <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '10px', background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: C.ivoryWarm, textAlign: 'left', color: C.graySoph, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '10px', fontWeight: 600 }}>
                  <th style={th}>Client</th>
                  <th style={th}>Event / ref</th>
                  <th style={th}>Status</th>
                  <th style={th}>Points</th>
                  <th style={th}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {needsRows.map((row) => {
                  const rel = row.loyalty_clients
                  const name = rel?.client_name || '—'
                  return (
                    <tr key={row.id} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={td}>{name}</td>
                      <td style={td}>
                        {(row.event_name || row.crms_ref || '—').toString().slice(0, 80)}
                      </td>
                      <td style={td}>{row.status}</td>
                      <td style={td}>{row.points}</td>
                      <td style={td}>{row.needs_attention_reason || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Clients */}
      <section style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
          <h2 style={{ ...sectionTitle, marginBottom: 0 }}>Clients</h2>
          <button
            type="button"
            disabled={!tablesActive || loading}
            onClick={openEnrollModal}
            style={{
              opacity: tablesActive && !loading ? 1 : 0.45,
              cursor: tablesActive && !loading ? 'pointer' : 'not-allowed',
              background: tablesActive ? C.champagneMuted : C.charcoalSoft,
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '8px 16px',
              fontSize: '12px',
              fontWeight: 600,
              letterSpacing: '0.04em',
            }}
          >
            Add client
          </button>
        </div>
        {enrollBanner?.kind === 'ok' && (
          <div
            role="status"
            style={{
              marginBottom: '14px',
              padding: '12px 16px',
              borderRadius: '8px',
              border: `1px solid ${C.champagneMuted}`,
              background: C.ivoryWarm,
              fontSize: '14px',
              color: C.charcoalSoft,
            }}
          >
            {enrollBanner.message}
          </div>
        )}
        {clientsRows.length === 0 ? (
          <div style={emptyBox}>
            {tablesActive
              ? 'No rewards clients enrolled yet.'
              : 'Rewards clients will appear here once the loyalty tables are active and clients are enrolled.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '10px', background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: C.ivoryWarm, textAlign: 'left', color: C.graySoph, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '10px', fontWeight: 600 }}>
                  <th style={th}>Client</th>
                  <th style={th}>Email</th>
                  <th style={th}>Tier</th>
                  <th style={th}>Available</th>
                  <th style={th}>Pending</th>
                  <th style={th}>Redeemed</th>
                  <th style={th}>Status</th>
                  <th style={th}>Portal</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {clientsRows.map((c) => {
                  const r = clientRollups[c.id] || { av: 0, pe: 0, reP: 0 }
                  return (
                    <tr key={c.id} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={td}>{c.client_name}</td>
                      <td style={td}>{c.client_email || '—'}</td>
                      <td style={td}>{displayTierFriendly(c.tier)}</td>
                      <td style={td}>{formatPointsUi(r.av)}</td>
                      <td style={td}>{formatPointsUi(r.pe)}</td>
                      <td style={td}>{formatGBPFromPence(r.reP)}</td>
                      <td style={td}>{c.status}</td>
                      <td style={{ ...td, color: C.graySoph }}>Not enabled yet</td>
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => openClientProfile(c.id)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: C.champagneMuted,
                            fontWeight: 600,
                            fontSize: '13px',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            textUnderlineOffset: '3px',
                            padding: '0',
                            fontFamily: "'DM Sans', sans-serif",
                          }}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {enrollOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="enroll-modal-title"
          data-enroll-modal
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            background: 'rgba(26, 26, 26, 0.45)',
          }}
          onClick={(ev) => {
            if (ev.target === ev.currentTarget && !enrollBusyRef.current) closeEnrollModal()
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '480px',
              background: '#FDFBF7',
              borderRadius: '12px',
              border: `1px solid ${C.border}`,
              boxShadow: '0 16px 48px rgba(26,26,26,0.12)',
              maxHeight: '90vh',
              overflow: 'auto',
            }}
          >
            <div style={{ padding: '20px 22px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
              <h3 id="enroll-modal-title" style={{ margin: 0, fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', fontWeight: 600, color: C.charcoal }}>
                Enrol rewards client
              </h3>
              <button
                type="button"
                aria-label="Close"
                disabled={enrollSubmitting}
                onClick={closeEnrollModal}
                style={{
                  flexShrink: 0,
                  width: '32px',
                  height: '32px',
                  borderRadius: '6px',
                  border: `1px solid ${C.grayFog}`,
                  background: '#fff',
                  cursor: enrollSubmitting ? 'not-allowed' : 'pointer',
                  fontSize: '16px',
                  lineHeight: 1,
                  color: C.graySoph,
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={submitEnrollment} style={{ padding: '20px 22px 22px' }}>
              <p style={{ margin: '0 0 18px', fontSize: '13px', color: C.graySoph, lineHeight: 1.55 }}>
                Create a Duchess Rewards loyalty record. No points or portal access are granted yet.
              </p>

              <label style={labelStyles}>
                <span style={labelSpan}>Client name <span style={{ color: '#7D2B2E' }}>*</span></span>
                <input
                  autoFocus
                  value={enrollName}
                  onChange={(e) => setEnrollName(e.target.value)}
                  disabled={enrollSubmitting}
                  placeholder="e.g. Acme Weddings Ltd"
                  style={inputStyles}
                />
              </label>

              <label style={{ ...labelStyles, marginTop: '14px' }}>
                <span style={labelSpan}>Email</span>
                <input
                  type="email"
                  value={enrollEmail}
                  onChange={(e) => setEnrollEmail(e.target.value)}
                  disabled={enrollSubmitting}
                  placeholder="Optional — recommended for receipts"
                  style={inputStyles}
                />
              </label>

              <label style={{ ...labelStyles, marginTop: '14px' }}>
                <span style={labelSpan}>CRMS client ID</span>
                <input
                  value={enrollCrms}
                  onChange={(e) => setEnrollCrms(e.target.value)}
                  disabled={enrollSubmitting}
                  placeholder="Optional"
                  style={inputStyles}
                />
              </label>

              <div style={{ marginTop: '14px', padding: '12px 14px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: C.graySoph, marginBottom: '6px', fontWeight: 600 }}>Tier</div>
                <div style={{ fontSize: '14px', color: C.charcoalSoft }}>Pearl <span style={{ color: C.graySoph }}>(standard entry tier · stored as standard)</span></div>
                <div style={{ fontSize: '12px', color: C.graySoph, marginTop: '10px', fontWeight: 600 }}>Status</div>
                <div style={{ fontSize: '14px', color: C.charcoalSoft }}>Active</div>
              </div>

              {enrollFormError ? (
                <div role="alert" style={{ marginTop: '16px', fontSize: '13px', color: '#7D2B2E' }}>
                  {enrollFormError}
                </div>
              ) : null}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '22px' }}>
                <button
                  type="button"
                  disabled={enrollSubmitting}
                  onClick={closeEnrollModal}
                  style={{
                    ...btnSecondary,
                    opacity: enrollSubmitting ? 0.5 : 1,
                    cursor: enrollSubmitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button type="submit" disabled={enrollSubmitting} style={{ ...btnPrimary, opacity: enrollSubmitting ? 0.7 : 1, cursor: enrollSubmitting ? 'wait' : 'pointer' }}>
                  {enrollSubmitting ? 'Enrolling…' : 'Enrol client'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {profileClientId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="loyalty-profile-title"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 210,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            background: 'rgba(26, 26, 26, 0.45)',
          }}
          onClick={(ev) => {
            if (ev.target === ev.currentTarget && !enrollBusyRef.current) closeClientProfile()
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '640px',
              background: '#FDFBF7',
              borderRadius: '12px',
              border: `1px solid ${C.border}`,
              boxShadow: '0 16px 48px rgba(26,26,26,0.12)',
              maxHeight: '92vh',
              overflow: 'auto',
            }}
          >
            <div style={{ padding: '20px 22px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
              <h3 id="loyalty-profile-title" style={{ margin: 0, fontFamily: "'Cormorant Garamond', serif", fontSize: '24px', fontWeight: 600, color: C.charcoal }}>
                Client profile
              </h3>
              <button
                type="button"
                aria-label="Close client profile"
                onClick={closeClientProfile}
                style={{
                  flexShrink: 0,
                  width: '34px',
                  height: '34px',
                  borderRadius: '6px',
                  border: `1px solid ${C.grayFog}`,
                  background: '#fff',
                  cursor: 'pointer',
                  fontSize: '18px',
                  lineHeight: 1,
                  color: C.graySoph,
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '20px 22px 22px' }}>
              {!profileClient ? (
                <p style={{ margin: 0, fontSize: '14px', color: '#7D2B2E' }}>
                  This enrolment could not be found in the loaded client list (for example pagination). Close this panel and reload the Duchess Rewards page to refresh data.
                </p>
              ) : (
                <>
                  <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '14px 20px', fontSize: '14px', color: C.charcoalSoft, paddingBottom: '18px', borderBottom: `1px solid ${C.border}` }}>
                    <div>
                      <dt style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Client name</dt>
                      <dd style={{ margin: 0 }}>{profileClient.client_name}</dd>
                    </div>
                    <div>
                      <dt style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Email</dt>
                      <dd style={{ margin: 0 }}>{profileClient.client_email?.trim() || '—'}</dd>
                    </div>
                    <div>
                      <dt style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>CRMS client ID</dt>
                      <dd style={{ margin: 0 }}>{profileClient.crms_client_id?.toString()?.trim() || '—'}</dd>
                    </div>
                    <div>
                      <dt style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Tier</dt>
                      <dd style={{ margin: 0 }}>{displayTierFriendly(profileClient.tier)} <span style={{ color: C.graySoph }}>({profileClient.tier || 'standard'})</span></dd>
                    </div>
                    <div>
                      <dt style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Status</dt>
                      <dd style={{ margin: 0 }}>{profileClient.status}</dd>
                    </div>
                    <div>
                      <dt style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Enrolled</dt>
                      <dd style={{ margin: 0 }}>{fmtActivityDate(profileClient.created_at)}</dd>
                    </div>
                  </dl>

                  <div style={{ marginTop: '20px', marginBottom: '16px' }}>
                    <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '18px', fontWeight: 600, color: C.charcoal, marginBottom: '12px' }}>Reward balance</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', fontSize: '14px', color: C.charcoalSoft }}>
                      <div style={{ padding: '12px 14px', background: '#fff', borderRadius: '8px', border: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: '11px', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Available points</div>
                        <div style={{ fontWeight: 600, color: C.charcoal }}>{formatPointsUi(profileRollup.av)}</div>
                      </div>
                      <div style={{ padding: '12px 14px', background: '#fff', borderRadius: '8px', border: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: '11px', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Available reward value</div>
                        <div style={{ fontWeight: 600, color: C.charcoal }}>
                          {formatGBPFromPence(estimateAvailableRewardPence(profileRollup.av, activeSettings))}
                        </div>
                      </div>
                      <div style={{ padding: '12px 14px', background: '#fff', borderRadius: '8px', border: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: '11px', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Pending points</div>
                        <div style={{ fontWeight: 600, color: C.charcoal }}>{formatPointsUi(profileRollup.pe)}</div>
                      </div>
                      <div style={{ padding: '12px 14px', background: '#fff', borderRadius: '8px', border: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: '11px', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Redeemed value</div>
                        <div style={{ fontWeight: 600, color: C.charcoal }}>{formatGBPFromPence(profileRollup.reP)}</div>
                      </div>
                      <div style={{ padding: '12px 14px', background: '#fff', borderRadius: '8px', border: `1px solid ${C.border}`, gridColumn: '1 / -1' }}>
                        <div style={{ fontSize: '11px', color: C.graySoph, fontWeight: 600, marginBottom: '6px' }}>Portal access</div>
                        <div style={{ fontWeight: 600, color: C.charcoal }}>Not enabled yet</div>
                        <div style={{ fontSize: '12px', marginTop: '8px', color: C.graySoph }}>Manual points workflow coming next.</div>
                      </div>
                    </div>
                  </div>

                  {profileNeedsReview ? (
                    <div
                      role="status"
                      style={{
                        marginBottom: '16px',
                        padding: '12px 14px',
                        borderRadius: '8px',
                        borderLeft: `4px solid #B45309`,
                        background: '#FFFBEB',
                        fontSize: '13px',
                        color: '#78350F',
                      }}
                    >
                      This client has reward activity needing review.
                    </div>
                  ) : null}

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '22px', opacity: 0.7 }}>
                    <button type="button" disabled style={{ ...btnSecondary, opacity: 0.55, cursor: 'not-allowed', fontSize: '12px' }}>Add points — coming soon</button>
                    <button type="button" disabled style={{ ...btnSecondary, opacity: 0.55, cursor: 'not-allowed', fontSize: '12px' }}>Redeem — coming soon</button>
                    <button type="button" disabled style={{ ...btnSecondary, opacity: 0.55, cursor: 'not-allowed', fontSize: '12px' }}>Enable portal — coming soon</button>
                  </div>

                  <div>
                    <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '18px', fontWeight: 600, color: C.charcoal, marginBottom: '12px' }}>Reward activity</div>

                    {profileTxState === 'loading' ? (
                      <div style={{ ...emptyBox, borderStyle: 'solid' }}>Loading reward activity…</div>
                    ) : null}
                    {profileTxState === 'error' ? (
                      <div style={{ ...emptyBox, borderStyle: 'solid', color: '#7D2B2E' }}>Reward activity could not be loaded.</div>
                    ) : null}
                    {profileTxState === 'ok' && profileTxRows.length === 0 ? (
                      <div style={{ ...emptyBox, borderStyle: 'solid' }}>No reward activity yet.</div>
                    ) : null}

                    {profileTxState === 'ok' && profileTxRows.length > 0 ? (
                      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '10px', background: '#fff' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                          <thead>
                            <tr style={{ background: C.ivoryWarm, textAlign: 'left', color: C.graySoph, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '10px', fontWeight: 600 }}>
                              <th style={th}>Date</th>
                              <th style={th}>Type</th>
                              <th style={th}>Status</th>
                              <th style={th}>Points</th>
                              <th style={th}>Value</th>
                              <th style={th}>Reason / event</th>
                            </tr>
                          </thead>
                          <tbody>
                            {profileTxRows.map((row) => (
                              <tr key={row.id} style={{ borderTop: `1px solid ${C.border}` }}>
                                <td style={td}>{fmtActivityDate(row.created_at)}</td>
                                <td style={td}>{row.transaction_type}</td>
                                <td style={td}>{row.status}</td>
                                <td style={td}>{formatPointsUi(row.points)}</td>
                                <td style={td}>{formatGBPFromPence(row.value_pence)}</td>
                                <td style={td}>{activityReasonSnippet(row)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Workflow */}
      <section style={{ marginBottom: '24px' }}>
        <h2 style={sectionTitle}>Suggested points workflow</h2>
        <ol style={{ margin: '12px 0 0', paddingLeft: '22px', color: C.graySoph, fontSize: '14px', lineHeight: 1.85 }}>
          <li>System suggests points from eligible orders.</li>
          <li>Admin reviews calculation and Needs Attention flags.</li>
          <li>Admin approves points as pending or available.</li>
          <li>Client can later request redemption.</li>
        </ol>
        <p style={{ ...sectionMuted, marginTop: '14px', fontStyle: 'italic' }}>
          Admins may manually enrol loyalty clients — no orders are scanned and no reward points are created automatically. Approval, redemption, and portal access are not wired yet.
        </p>
      </section>
    </div>
  )
}

const sectionTitle = {
  fontFamily: "'Cormorant Garamond', serif",
  fontSize: '22px',
  fontWeight: 600,
  margin: '0 0 8px',
  color: C.charcoal,
}

const sectionMuted = {
  margin: '0 0 16px',
  fontSize: '13px',
  color: C.graySoph,
  maxWidth: '720px',
  lineHeight: 1.55,
}

const emptyBox = {
  border: `1px dashed ${C.grayFog}`,
  borderRadius: '10px',
  padding: '22px',
  fontSize: '14px',
  color: C.graySoph,
  background: '#fff',
}

const th = { padding: '12px 14px' }
const td = { padding: '12px 14px', color: C.charcoalSoft }

const labelStyles = { display: 'block' }
const labelSpan = { display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: C.charcoalSoft }
const inputStyles = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: '8px',
  border: `1px solid ${C.grayFog}`,
  fontSize: '14px',
  fontFamily: "'DM Sans', sans-serif",
  background: '#fff',
}

const btnPrimary = {
  background: C.champagneMuted,
  color: '#fff',
  border: 'none',
  borderRadius: '8px',
  padding: '10px 20px',
  fontWeight: 600,
  fontSize: '13px',
  fontFamily: "'DM Sans', sans-serif",
}

const btnSecondary = {
  background: 'transparent',
  color: C.charcoalSoft,
  border: `1px solid ${C.border}`,
  borderRadius: '8px',
  padding: '10px 18px',
  fontWeight: 600,
  fontSize: '13px',
  fontFamily: "'DM Sans', sans-serif",
}

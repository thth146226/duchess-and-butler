import { useCallback, useEffect, useMemo, useState } from 'react'
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

  const load = useCallback(async () => {
    setLoading(true)
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
      setMetrics({ ...fallback, enrolled: enrolled ?? 0 })
      setNeedsRows([])
      setClientsRows([])
      setAllTxs([])
      setLoading(false)
      return
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
      .select('id, client_name, tier, status, created_at')
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

  const badgeLabel = useMemo(
    () => (tablesActive ? 'Foundation ready' : 'Admin preview'),
    [tablesActive],
  )

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

      {/* Foundation / setup */}
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
          The database foundation has been prepared in the repo. Apply the reviewed SQL file when ready to activate live loyalty data:{' '}
          <code style={{ background: 'rgba(26,26,26,0.06)', padding: '2px 6px', borderRadius: '4px', fontSize: '13px' }}>src/database/duchess_rewards_foundation.sql</code>
        </p>
        {!tablesActive && !loading && (
          <p style={{ margin: '14px 0 0', fontSize: '14px', color: C.charcoalSoft, fontWeight: 500 }}>
            Loyalty tables are not active yet. Apply the Duchess Rewards foundation SQL to enable live data.
          </p>
        )}
      </div>

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
            disabled
            style={{
              opacity: 0.45,
              cursor: 'not-allowed',
              background: C.charcoalSoft,
              color: C.ivory,
              border: 'none',
              borderRadius: '6px',
              padding: '8px 16px',
              fontSize: '12px',
              fontWeight: 600,
              letterSpacing: '0.04em',
            }}
          >
            Add client — coming soon
          </button>
        </div>
        {clientsRows.length === 0 ? (
          <div style={emptyBox}>
            Rewards clients will appear here once the loyalty tables are active and clients are enrolled.
          </div>
        ) : (
          <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '10px', background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: C.ivoryWarm, textAlign: 'left', color: C.graySoph, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '10px', fontWeight: 600 }}>
                  <th style={th}>Client</th>
                  <th style={th}>Tier</th>
                  <th style={th}>Available</th>
                  <th style={th}>Pending</th>
                  <th style={th}>Redeemed</th>
                  <th style={th}>Status</th>
                  <th style={th}>Portal</th>
                </tr>
              </thead>
              <tbody>
                {clientsRows.map((c) => {
                  const r = clientRollups[c.id] || { av: 0, pe: 0, reP: 0 }
                  return (
                    <tr key={c.id} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={td}>{c.client_name}</td>
                      <td style={td}>{c.tier || '—'}</td>
                      <td style={td}>{r.av.toLocaleString('en-GB')}</td>
                      <td style={td}>{r.pe.toLocaleString('en-GB')}</td>
                      <td style={td}>{formatGBPFromPence(r.reP)}</td>
                      <td style={td}>{c.status}</td>
                      <td style={{ ...td, color: C.graySoph }}>—</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
          This admin shell does not scan jobs, calculate suggestions, approve, or redeem — Phase 1C is read-only and placeholder-first.
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

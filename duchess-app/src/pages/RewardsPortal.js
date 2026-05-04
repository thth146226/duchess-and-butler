// Duchess Rewards — Client Portal
// Public route: /rewards/<token>
// No auth required. Calls get_rewards_by_token RPC via anon key.
// Layout: standalone, no sidebar, no admin navigation.

import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const TIER_CONFIG = {
  Pearl:          { next: 'Gold',          color: '#c9a84c', threshold: 2000 },
  Gold:           { next: 'Crown',         color: '#c9a84c', threshold: 5000 },
  Crown:          { next: 'Duchess Black', color: '#c9a84c', threshold: 10000 },
  'Duchess Black':{ next: null,            color: '#c9a84c', threshold: null },
}

const TIER_THRESHOLDS = { Pearl: 0, Gold: 2000, Crown: 5000, 'Duchess Black': 10000 }

function formatGBP(pence) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100)
}

function formatPoints(n) {
  return new Intl.NumberFormat('en-GB').format(n)
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function activityLabel(type, status) {
  if (type === 'redeem')  return 'Reward redeemed'
  if (status === 'pending')   return 'Pending release'
  if (status === 'available') return 'Points earned'
  return 'Adjustment'
}

function ProgressBar({ tier, availablePoints }) {
  const current  = TIER_THRESHOLDS[tier] ?? 0
  const config   = TIER_CONFIG[tier]
  if (!config || !config.next) {
    return (
      <div style={styles.progressWrap}>
        <div style={styles.progressMeta}>
          <span style={styles.progressLabel}>Tier status</span>
          <span style={styles.progressTarget}>Highest tier achieved</span>
        </div>
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: '100%' }} />
        </div>
      </div>
    )
  }
  const next      = config.threshold
  const earned    = Math.max(0, availablePoints - current)
  const needed    = next - current
  const pct       = Math.min(100, Math.round((earned / needed) * 100))
  const remaining = Math.max(0, next - availablePoints)

  return (
    <div style={styles.progressWrap}>
      <div style={styles.progressMeta}>
        <span style={styles.progressLabel}>Tier progress</span>
        <span style={styles.progressTarget}>{formatPoints(remaining)} pts to {config.next}</span>
      </div>
      <div style={styles.progressTrack}>
        <div style={{ ...styles.progressFill, width: `${pct}%` }} />
      </div>
      <div style={styles.tierSteps}>
        {Object.keys(TIER_THRESHOLDS).map(t => {
          const isPassed  = TIER_THRESHOLDS[t] < TIER_THRESHOLDS[tier]
          const isActive  = t === tier
          return (
            <span key={t} style={{
              ...styles.tierStep,
              color: isActive ? '#c9a84c' : isPassed ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.18)',
              fontStyle: isActive ? 'italic' : 'normal',
            }}>{t}</span>
          )
        })}
      </div>
    </div>
  )
}

function ActivityItem({ tx }) {
  const isEarn   = tx.type !== 'redeem' && tx.status === 'available'
  const isPending= tx.status === 'pending'
  const isRedeem = tx.type === 'redeem'

  const dotColor = isEarn ? '#c9a84c' : isPending ? 'transparent' : '#8a7e72'
  const dotBorder= isPending ? '1px solid #8a7e72' : 'none'
  const ptsColor = isEarn ? '#a8893a' : '#8a7e72'
  const ptsSign  = tx.points > 0 ? '+' : ''

  return (
    <div style={styles.activityItem}>
      <div style={{ ...styles.activityDot, background: dotColor, border: dotBorder }} />
      <div style={styles.activityBody}>
        <div style={styles.activityReason}>{tx.reason || activityLabel(tx.type, tx.status)}</div>
        <div style={styles.activityDate}>
          {formatDate(tx.created_at)}
          {isPending && ' · Pending release'}
          {isRedeem  && ` · ${formatGBP(Math.abs(tx.value_pence))} redeemed`}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ ...styles.activityPoints, color: ptsColor }}>
          {ptsSign}{formatPoints(tx.points)} pts
        </div>
        <div style={styles.activityStatus}>
          {isEarn ? 'Earned' : isPending ? 'Pending' : 'Redeemed'}
        </div>
      </div>
    </div>
  )
}

export default function RewardsPortal() {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [invalid, setInvalid] = useState(false)

  // Extract token from pathname: /rewards/<token>
  const token = window.location.pathname.split('/rewards/')[1]?.trim()

  useEffect(() => {
    if (!token) { setInvalid(true); setLoading(false); return }

    supabase.rpc('get_rewards_by_token', { p_token: token })
      .then(({ data: result, error }) => {
        if (error || !result) { setInvalid(true) }
        else                  { setData(result)  }
        setLoading(false)
      })
  }, [token])

  if (loading) return (
    <div style={styles.loadingWrap}>
      <div style={styles.loadingText}>Duchess & Butler</div>
    </div>
  )

  if (invalid || !data) return (
    <div style={styles.loadingWrap}>
      <div style={styles.brandWordmark}>Duchess <span style={{ color: '#c9a84c' }}>&</span> Butler</div>
      <div style={{ marginTop: 24, color: '#8a7e72', fontFamily: "'DM Sans', sans-serif", fontSize: 14 }}>
        This rewards link is not valid or has expired.
      </div>
    </div>
  )

  const { client_name, tier, available_points, pending_points, redeemed_value_pence, transactions } = data
  const firstName = client_name?.split(' ')[0] ?? client_name

  return (
    <div style={styles.portal}>

      {/* ── Header ── */}
      <div style={styles.headerBar}>
        <div style={styles.brandWordmark}>
          Duchess <span style={{ color: '#c9a84c' }}>&</span> Butler
        </div>
        <div style={styles.headerTag}>Private Client Rewards</div>
      </div>

      {/* ── Hero ── */}
      <div style={styles.hero}>
        <div style={styles.heroGreeting}>Welcome back</div>
        <div style={styles.heroName}>{client_name}</div>
        <div style={styles.tierBadge}>
          <div style={styles.tierDot} />
          <div style={styles.tierLabel}>{tier} Member</div>
        </div>
      </div>

      {/* ── Balance ── */}
      <div style={styles.balanceSection}>
        <div style={styles.balanceGrid}>
          <div style={styles.balanceStat}>
            <div style={styles.balanceLabel}>Available</div>
            <div style={{ ...styles.balanceValue, color: '#c9a84c' }}>{formatPoints(available_points)}</div>
            <div style={styles.balanceSub}>pts · {formatGBP(available_points * 0.5)}</div>
          </div>
          <div style={{ ...styles.balanceStat, borderLeft: '0.5px solid rgba(255,255,255,0.1)', paddingLeft: 20 }}>
            <div style={styles.balanceLabel}>Pending</div>
            <div style={styles.balanceValue}>{formatPoints(pending_points)}</div>
            <div style={styles.balanceSub}>pts · awaiting release</div>
          </div>
          <div style={{ ...styles.balanceStat, borderLeft: '0.5px solid rgba(255,255,255,0.1)', paddingLeft: 20 }}>
            <div style={styles.balanceLabel}>Lifetime redeemed</div>
            <div style={styles.balanceValue}>{formatGBP(redeemed_value_pence)}</div>
            <div style={styles.balanceSub}>in rewards used</div>
          </div>
        </div>
      </div>

      {/* ── Progress ── */}
      <div style={styles.progressSection}>
        <ProgressBar tier={tier} availablePoints={available_points} />
      </div>

      {/* ── Activity ── */}
      {transactions?.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            <span>Reward activity</span>
            <div style={styles.sectionLine} />
          </div>
          <div>
            {transactions.map((tx, i) => <ActivityItem key={i} tx={tx} />)}
          </div>
        </div>
      )}

      {/* ── CTA ── */}
      {available_points > 0 && (
        <div style={styles.ctaBox}>
          <div>
            <div style={styles.ctaHeadline}>Ready to use your rewards?</div>
            <div style={styles.ctaSub}>
              {formatPoints(available_points)} points available · {formatGBP(available_points * 0.5)} value · Contact your event team to redeem
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <div style={styles.footer}>
        <div style={styles.footerBrand}>
          Duchess <span style={{ color: '#a8893a' }}>&</span> Butler · Private Client Rewards
        </div>
        <div style={styles.footerNote}>Your account is secure</div>
      </div>

    </div>
  )
}

// ── Styles ──────────────────────────────────────────────────────
const styles = {
  portal: {
    maxWidth: 680,
    margin: '0 auto',
    minHeight: '100vh',
    background: '#fafaf8',
    fontFamily: "'DM Sans', sans-serif",
  },
  loadingWrap: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#fafaf8',
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 24,
    color: '#1a1a1a',
  },
  loadingText: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 24,
    color: '#1a1a1a',
    letterSpacing: '0.08em',
  },
  headerBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '20px 28px 16px',
    borderBottom: '0.5px solid #d4cec6',
  },
  brandWordmark: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 400,
    fontSize: 15,
    letterSpacing: '0.12em',
    color: '#1a1a1a',
    textTransform: 'uppercase',
  },
  headerTag: {
    fontSize: 10,
    letterSpacing: '0.2em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    fontWeight: 300,
  },
  hero: {
    padding: '40px 28px 32px',
    background: '#1a1a1a',
  },
  heroGreeting: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 11,
    letterSpacing: '0.25em',
    textTransform: 'uppercase',
    color: '#c9a84c',
    fontWeight: 300,
    marginBottom: 10,
  },
  heroName: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 38,
    fontWeight: 300,
    color: '#f0ece4',
    lineHeight: 1.1,
    marginBottom: 18,
    letterSpacing: '-0.01em',
  },
  tierBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 16px 7px 12px',
    border: '1px solid #a8893a',
    borderRadius: 2,
    background: 'rgba(201,168,76,0.08)',
  },
  tierDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#c9a84c',
    flexShrink: 0,
  },
  tierLabel: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 11,
    fontWeight: 400,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: '#e8d5a3',
  },
  balanceSection: {
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    padding: '0 28px',
  },
  balanceGrid: {
    display: 'flex',
    padding: '28px 0 32px',
    gap: 0,
  },
  balanceStat: {
    flex: 1,
  },
  balanceLabel: {
    fontSize: 10,
    letterSpacing: '0.2em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    fontWeight: 300,
    marginBottom: 8,
  },
  balanceValue: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 30,
    fontWeight: 300,
    color: '#f0ece4',
    letterSpacing: '-0.02em',
    lineHeight: 1,
  },
  balanceSub: {
    fontSize: 11,
    color: '#8a7e72',
    marginTop: 4,
    fontWeight: 300,
  },
  progressSection: {
    background: '#1a1a1a',
    padding: '0 28px 32px',
  },
  progressWrap: {
    paddingTop: 4,
  },
  progressMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 12,
  },
  progressLabel: {
    fontSize: 10,
    letterSpacing: '0.2em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    fontWeight: 300,
  },
  progressTarget: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 13,
    color: '#e8d5a3',
    fontWeight: 300,
  },
  progressTrack: {
    height: 2,
    background: 'rgba(255,255,255,0.1)',
    borderRadius: 1,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: '#c9a84c',
    borderRadius: 1,
    transition: 'width 1.2s cubic-bezier(0.4,0,0.2,1)',
  },
  tierSteps: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  tierStep: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '0.06em',
  },
  section: {
    padding: '32px 28px 0',
  },
  sectionTitle: {
    fontSize: 10,
    letterSpacing: '0.25em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    fontWeight: 400,
    marginBottom: 18,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  sectionLine: {
    flex: 1,
    height: 0.5,
    background: '#d4cec6',
  },
  activityItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '14px 0',
    borderBottom: '0.5px solid #d4cec6',
  },
  activityDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  activityBody: {
    flex: 1,
    minWidth: 0,
  },
  activityReason: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 15,
    fontWeight: 400,
    color: '#1a1a1a',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  activityDate: {
    fontSize: 11,
    color: '#8a7e72',
    fontWeight: 300,
    marginTop: 2,
  },
  activityPoints: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 17,
    fontWeight: 400,
  },
  activityStatus: {
    fontSize: 10,
    fontWeight: 300,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    marginTop: 2,
  },
  ctaBox: {
    margin: '32px 28px 0',
    border: '1px solid #d4cec6',
    borderRadius: 2,
    padding: '24px',
    background: '#f8f5ef',
  },
  ctaHeadline: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 22,
    fontWeight: 300,
    color: '#1a1a1a',
    fontStyle: 'italic',
    marginBottom: 4,
  },
  ctaSub: {
    fontSize: 12,
    color: '#8a7e72',
    fontWeight: 300,
  },
  footer: {
    margin: '48px 28px 0',
    paddingTop: 20,
    paddingBottom: 40,
    borderTop: '0.5px solid #d4cec6',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  footerBrand: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 13,
    fontWeight: 300,
    letterSpacing: '0.1em',
    color: '#8a7e72',
  },
  footerNote: {
    fontSize: 10,
    color: '#d4cec6',
    fontWeight: 300,
  },
}

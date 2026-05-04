// Duchess Client Portal — Authenticated Dashboard (Phase 3 minimal)
// Route: /portal/
// Requires active Supabase session.
// Shows: name, tier, points, pending, logout.

import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const TIER_DISPLAY = {
  standard: 'Pearl',
  gold: 'Gold',
  crown: 'Crown',
  black: 'Duchess Black',
}

function formatGBP(pence) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format((Number(pence) || 0) / 100)
}

function formatPoints(n) {
  return new Intl.NumberFormat('en-GB').format(Number(n) || 0)
}

const S = {
  portal: {
    maxWidth: 680,
    margin: '0 auto',
    minHeight: '100vh',
    background: '#fafaf8',
    fontFamily: "'DM Sans', sans-serif",
  },
  header: {
    padding: '20px 28px 16px',
    borderBottom: '0.5px solid #d4cec6',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 400,
    fontSize: 15,
    letterSpacing: '0.12em',
    color: '#1a1a1a',
    textTransform: 'uppercase',
  },
  signOut: {
    fontSize: 11,
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: 400,
    padding: '6px 0',
  },
  hero: {
    padding: '40px 28px 32px',
    background: '#1a1a1a',
  },
  heroGreeting: {
    fontSize: 11,
    letterSpacing: '0.25em',
    textTransform: 'uppercase',
    color: '#c9a84c',
    fontWeight: 300,
    marginBottom: 10,
    fontFamily: "'DM Sans', sans-serif",
  },
  heroName: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 36,
    fontWeight: 300,
    color: '#f0ece4',
    lineHeight: 1.1,
    marginBottom: 16,
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
  },
  tierLabel: {
    fontSize: 11,
    fontWeight: 400,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: '#e8d5a3',
    fontFamily: "'DM Sans', sans-serif",
  },
  balanceSection: {
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    padding: '0 28px',
  },
  balanceGrid: {
    display: 'flex',
    padding: '24px 0 28px',
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
    marginBottom: 6,
  },
  balanceValue: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 28,
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
  section: {
    padding: '32px 28px',
  },
  sectionTitle: {
    fontSize: 10,
    letterSpacing: '0.25em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    fontWeight: 400,
    marginBottom: 16,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  sectionLine: {
    flex: 1,
    height: 0.5,
    background: '#d4cec6',
  },
  infoCard: {
    border: '0.5px solid #d4cec6',
    borderRadius: 2,
    padding: '20px 20px',
    background: '#f8f5ef',
  },
  infoHeadline: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 20,
    fontWeight: 300,
    color: '#1a1a1a',
    fontStyle: 'italic',
    marginBottom: 6,
  },
  infoText: {
    fontSize: 13,
    color: '#8a7e72',
    fontWeight: 300,
    lineHeight: 1.6,
  },
  accountGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
  },
  accountItem: {
    padding: '14px 16px',
    background: '#fff',
    border: '0.5px solid #d4cec6',
    borderRadius: 2,
  },
  accountItemLabel: {
    fontSize: 10,
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    fontWeight: 400,
    marginBottom: 6,
  },
  accountItemValue: {
    fontSize: 14,
    color: '#1a1a1a',
    fontWeight: 400,
  },
  footer: {
    margin: '0 28px',
    paddingTop: 20,
    paddingBottom: 40,
    borderTop: '0.5px solid #d4cec6',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  footerBrand: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 12,
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

export default function ClientPortal() {
  const [stage, setStage] = useState('loading')
  const [profile, setProfile] = useState(null)
  const [rewards, setRewards] = useState(null)

  useEffect(() => {
    async function init() {
      const { data: { session }, error: sessionError } =
        await supabase.auth.getSession()

      if (sessionError || !session) {
        setStage('unauthenticated')
        return
      }

      const userId = session.user.id

      const { data: cp, error: cpError } = await supabase
        .from('client_profiles')
        .select('display_name, email, loyalty_client_id')
        .eq('id', userId)
        .single()

      if (cpError || !cp?.loyalty_client_id) {
        setStage('no_profile')
        return
      }

      setProfile({
        displayName: cp.display_name,
        email: session.user.email,
      })

      const { data: lc } = await supabase
        .from('loyalty_clients')
        .select('client_name, tier')
        .eq('id', cp.loyalty_client_id)
        .single()

      const { data: txs } = await supabase
        .from('loyalty_transactions')
        .select('points, value_pence, status, transaction_type')
        .eq('loyalty_client_id', cp.loyalty_client_id)

      let available = 0
      let pending = 0
      let redeemedPence = 0

      for (const tx of txs || []) {
        const points = Number(tx.points) || 0
        const valuePence = Number(tx.value_pence) || 0
        if (tx.status === 'available') available += points
        if (tx.status === 'pending') pending += points
        if (tx.status === 'redeemed' && tx.transaction_type === 'redeem') {
          available += points
          redeemedPence += Math.abs(valuePence)
        }
      }

      setRewards({
        clientName: lc?.client_name ?? cp.display_name,
        tier: TIER_DISPLAY[lc?.tier] ?? 'Pearl',
        available,
        pending,
        redeemedPence,
      })

      setStage('ready')
    }

    init()
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    window.location.href = '/'
  }

  if (stage === 'loading') {
    return (
      <div style={{ ...S.portal, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 22, color: '#1a1a1a', letterSpacing: '0.08em' }}>
          Duchess &amp; Butler…
        </div>
      </div>
    )
  }

  if (stage === 'unauthenticated') {
    return (
      <div style={{ ...S.portal, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 32 }}>
        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 22, color: '#1a1a1a' }}>
          Duchess <span style={{ color: '#c9a84c' }}>&</span> Butler
        </div>
        <div style={{ fontSize: 14, color: '#8a7e72', fontWeight: 300, textAlign: 'center' }}>
          Your session has expired. Please use your invitation link or contact your event team.
        </div>
      </div>
    )
  }

  if (stage === 'no_profile') {
    return (
      <div style={{ ...S.portal, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 32 }}>
        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 22, color: '#1a1a1a' }}>
          Duchess <span style={{ color: '#c9a84c' }}>&</span> Butler
        </div>
        <div style={{ fontSize: 14, color: '#8a7e72', fontWeight: 300, textAlign: 'center' }}>
          Your account is not yet linked to a rewards profile. Please contact your event team.
        </div>
      </div>
    )
  }

  const firstName = rewards?.clientName?.split(' ')[0] ?? profile?.displayName ?? ''

  return (
    <div style={S.portal}>
      <div style={S.header}>
        <div style={S.brand}>
          Duchess <span style={{ color: '#c9a84c' }}>&</span> Butler
        </div>
        <button style={S.signOut} onClick={handleSignOut}>Sign out</button>
      </div>

      <div style={S.hero}>
        <div style={S.heroGreeting}>Welcome back</div>
        <div style={S.heroName}>{rewards?.clientName ?? firstName}</div>
        <div style={S.tierBadge}>
          <div style={S.tierDot} />
          <div style={S.tierLabel}>{rewards?.tier ?? 'Pearl'} Member</div>
        </div>
      </div>

      <div style={S.balanceSection}>
        <div style={S.balanceGrid}>
          <div style={S.balanceStat}>
            <div style={S.balanceLabel}>Available</div>
            <div style={{ ...S.balanceValue, color: '#c9a84c' }}>
              {formatPoints(rewards?.available ?? 0)}
            </div>
            <div style={S.balanceSub}>
              pts · {formatGBP((rewards?.available ?? 0) * 0.5)}
            </div>
          </div>
          <div style={{ ...S.balanceStat, borderLeft: '0.5px solid rgba(255,255,255,0.1)', paddingLeft: 20 }}>
            <div style={S.balanceLabel}>Pending</div>
            <div style={S.balanceValue}>
              {formatPoints(rewards?.pending ?? 0)}
            </div>
            <div style={S.balanceSub}>pts · awaiting release</div>
          </div>
          <div style={{ ...S.balanceStat, borderLeft: '0.5px solid rgba(255,255,255,0.1)', paddingLeft: 20 }}>
            <div style={S.balanceLabel}>Lifetime redeemed</div>
            <div style={S.balanceValue}>
              {formatGBP(rewards?.redeemedPence ?? 0)}
            </div>
            <div style={S.balanceSub}>in rewards used</div>
          </div>
        </div>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>
          <span>Coming soon</span>
          <div style={S.sectionLine} />
        </div>
        <div style={S.infoCard}>
          <div style={S.infoHeadline}>Your portal is being built.</div>
          <div style={S.infoText}>
            Rewards, digital catalogue, table designer and event tools are being prepared for your account.
            Your event team will notify you when each feature becomes available.
          </div>
        </div>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>
          <span>Your account</span>
          <div style={S.sectionLine} />
        </div>
        <div style={S.accountGrid}>
          <div style={S.accountItem}>
            <div style={S.accountItemLabel}>Name</div>
            <div style={S.accountItemValue}>{rewards?.clientName ?? '—'}</div>
          </div>
          <div style={S.accountItem}>
            <div style={S.accountItemLabel}>Email</div>
            <div style={S.accountItemValue}>{profile?.email ?? '—'}</div>
          </div>
          <div style={S.accountItem}>
            <div style={S.accountItemLabel}>Tier</div>
            <div style={S.accountItemValue}>{rewards?.tier ?? 'Pearl'}</div>
          </div>
          <div style={S.accountItem}>
            <div style={S.accountItemLabel}>Status</div>
            <div style={S.accountItemValue}>Active</div>
          </div>
        </div>
      </div>

      <div style={S.footer}>
        <div style={S.footerBrand}>
          Duchess <span style={{ color: '#a8893a' }}>&</span> Butler · Private Client Portal
        </div>
        <div style={S.footerNote}>Your account is secure</div>
      </div>
    </div>
  )
}

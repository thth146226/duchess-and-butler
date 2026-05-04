// Duchess Client Portal — Invite Onboarding
// Route: /portal/invite
// Public route — no auth required to land here.
// Reads access_token + refresh_token from URL hash.
// Sets session, shows password form, calls updateUser, marks invite_accepted_at, redirects to /portal/

import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const S = {
  portal: {
    maxWidth: 480,
    margin: '0 auto',
    minHeight: '100vh',
    background: '#fafaf8',
    fontFamily: "'DM Sans', sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    padding: '24px 32px 20px',
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
  tag: {
    fontSize: 10,
    letterSpacing: '0.2em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    fontWeight: 300,
  },
  body: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '48px 32px',
  },
  greeting: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 32,
    fontWeight: 300,
    color: '#1a1a1a',
    lineHeight: 1.2,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#8a7e72',
    fontWeight: 300,
    lineHeight: 1.6,
    marginBottom: 32,
  },
  label: {
    display: 'block',
    fontSize: 11,
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
    color: '#8a7e72',
    fontWeight: 400,
    marginBottom: 8,
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    fontSize: 14,
    fontFamily: "'DM Sans', sans-serif",
    color: '#1a1a1a',
    background: '#fff',
    border: '1px solid #d4cec6',
    borderRadius: 2,
    outline: 'none',
    boxSizing: 'border-box',
    marginBottom: 20,
  },
  btn: {
    width: '100%',
    padding: '14px',
    background: '#1a1a1a',
    color: '#e8d5a3',
    border: 'none',
    borderRadius: 2,
    fontSize: 11,
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: 400,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    marginTop: 8,
  },
  btnDisabled: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
  error: {
    fontSize: 13,
    color: '#7D2B2E',
    marginBottom: 16,
    lineHeight: 1.5,
  },
  muted: {
    fontSize: 12,
    color: '#8a7e72',
    fontWeight: 300,
    lineHeight: 1.6,
    marginTop: 16,
  },
  footer: {
    padding: '24px 32px',
    borderTop: '0.5px solid #d4cec6',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footerBrand: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 12,
    color: '#8a7e72',
    fontWeight: 300,
    letterSpacing: '0.08em',
  },
  footerNote: {
    fontSize: 10,
    color: '#d4cec6',
    fontWeight: 300,
  },
}

function parseHashTokens() {
  const hash = window.location.hash.slice(1)
  const params = new URLSearchParams(hash)
  return {
    accessToken: params.get('access_token'),
    refreshToken: params.get('refresh_token'),
    type: params.get('type'),
  }
}

export default function PortalInvite() {
  const [stage, setStage] = useState('loading')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    async function init() {
      const { accessToken, refreshToken, type } = parseHashTokens()

      if (window.history?.replaceState) {
        window.history.replaceState(null, '', window.location.pathname)
      }

      if (!accessToken || !refreshToken || type !== 'invite') {
        setStage('invalid')
        return
      }

      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })

      if (error || !data?.session) {
        setStage('invalid')
        return
      }

      const { data: profile } = await supabase
        .from('client_profiles')
        .select('display_name')
        .eq('id', data.session.user.id)
        .single()

      if (profile?.display_name) {
        setDisplayName(profile.display_name.split(' ')[0])
      }

      setStage('set_password')
    }

    init()
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError('')

    if (password.length < 8) {
      setFormError('Password must be at least 8 characters.')
      return
    }

    if (password !== confirm) {
      setFormError('Passwords do not match.')
      return
    }

    setSubmitting(true)

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })

      if (updateError) {
        setFormError(updateError.message || 'Could not set password. Please try again.')
        return
      }

      await supabase.rpc('accept_client_invite')

      window.location.href = '/portal/'
    } catch {
      setFormError('Unexpected error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={S.portal}>
      <div style={S.header}>
        <div style={S.brand}>
          Duchess <span style={{ color: '#c9a84c' }}>&</span> Butler
        </div>
        <div style={S.tag}>Private Client Portal</div>
      </div>

      <div style={S.body}>
        {stage === 'loading' && (
          <div style={{ ...S.subtitle, textAlign: 'center' }}>
            Setting up your account…
          </div>
        )}

        {stage === 'invalid' && (
          <>
            <div style={{ ...S.greeting, fontSize: 24 }}>This link is not valid.</div>
            <div style={S.subtitle}>
              Your invitation link may have expired or already been used.
              Please contact your Duchess &amp; Butler event team to request a new invitation.
            </div>
          </>
        )}

        {stage === 'set_password' && (
          <>
            <div style={S.greeting}>
              {displayName ? `Welcome, ${displayName}.` : 'Welcome.'}
            </div>
            <div style={S.subtitle}>
              Choose a password to activate your private portal access.
            </div>

            <form onSubmit={handleSubmit} noValidate>
              <label style={S.label}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                autoFocus
                autoComplete="new-password"
                placeholder="Minimum 8 characters"
                style={S.input}
              />

              <label style={S.label}>Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={submitting}
                autoComplete="new-password"
                placeholder="Repeat your password"
                style={S.input}
              />

              {formError ? <div style={S.error}>{formError}</div> : null}

              <button
                type="submit"
                disabled={submitting}
                style={{ ...S.btn, ...(submitting ? S.btnDisabled : {}) }}
              >
                {submitting ? 'Activating…' : 'Activate my account'}
              </button>
            </form>

            <div style={S.muted}>
              Your account is personal and secure. You can change your password at any time from your account settings.
            </div>
          </>
        )}
      </div>

      <div style={S.footer}>
        <div style={S.footerBrand}>
          Duchess <span style={{ color: '#a8893a' }}>&</span> Butler · Private Client Services
        </div>
        <div style={S.footerNote}>London</div>
      </div>
    </div>
  )
}

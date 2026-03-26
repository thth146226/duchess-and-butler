import { useState } from 'react'
import { supabase } from '../lib/supabase'
import * as OTPAuth from 'otpauth'

export default function TOTPVerify({ userId, onComplete, onSignOut }) {
  const [code, setCode]         = useState('')
  const [error, setError]       = useState('')
  const [verifying, setVerifying] = useState(false)

  async function verify() {
    if (code.length !== 6) return
    setVerifying(true)
    setError('')

    try {
      const { data, error: fetchError } = await supabase
        .from('users')
        .select('totp_secret')
        .eq('id', userId)
        .single()

      if (fetchError || !data?.totp_secret) {
        throw new Error('Could not load authenticator settings.')
      }

      const totp = new OTPAuth.TOTP({
        issuer: 'Duchess & Butler',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(data.totp_secret),
      })

      const delta = totp.validate({ token: code.trim(), window: 1 })

      if (delta === null) {
        setError('Invalid code. Please try again.')
        setCode('')
        setVerifying(false)
        return
      }

      onComplete()

    } catch (err) {
      setError(err.message || 'Verification failed.')
      setVerifying(false)
    }
  }

  return (
    <div style={S.wrapper}>
      <div style={S.card}>
        <div style={S.logo}>Duchess & Butler</div>
        <div style={S.sub}>TWO-FACTOR AUTHENTICATION</div>

        <div style={{ fontSize: '13px', color: '#6B6860', marginBottom: '24px', lineHeight: 1.6 }}>
          Open Google Authenticator and enter the 6-digit code for Duchess & Butler.
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={S.label}>VERIFICATION CODE</label>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            style={{ ...S.input, textAlign: 'center', fontSize: '28px', letterSpacing: '0.4em', fontFamily: 'monospace' }}
            onKeyDown={e => e.key === 'Enter' && verify()}
            autoFocus
          />
        </div>

        {error && <div style={S.error}>{error}</div>}

        <button
          onClick={verify}
          disabled={verifying || code.length !== 6}
          style={{ ...S.btn, opacity: code.length !== 6 ? 0.5 : 1, marginBottom: '10px' }}
        >{verifying ? 'Verifying…' : 'Verify'}</button>

        <button
          onClick={onSignOut}
          style={{ width: '100%', padding: '10px', background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}
        >Sign out</button>
      </div>
    </div>
  )
}

const S = {
  wrapper: { minHeight: '100vh', background: '#F7F3EE', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: "'DM Sans', sans-serif" },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '48px 40px', width: '100%', maxWidth: '380px', boxShadow: '0 12px 48px rgba(28,28,30,0.10)', textAlign: 'center' },
  logo: { fontFamily: "'Cormorant Garamond', serif", fontSize: '26px', fontWeight: '600', color: '#1C1C1E', marginBottom: '4px' },
  sub: { fontSize: '10px', letterSpacing: '0.18em', color: '#B8965A', fontWeight: '600', marginBottom: '24px' },
  label: { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.08em', color: '#1C1C1E', marginBottom: '8px', textAlign: 'left' },
  input: { width: '100%', padding: '14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '14px', fontFamily: "'DM Sans', sans-serif", color: '#1C1C1E', background: '#fff', boxSizing: 'border-box', outline: 'none' },
  error: { background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA', borderRadius: '4px', padding: '10px 14px', fontSize: '13px', marginBottom: '16px' },
  btn: { width: '100%', padding: '12px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '14px', fontWeight: '500', fontFamily: "'DM Sans', sans-serif", cursor: 'pointer' },
}


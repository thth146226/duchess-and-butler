import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function MFAVerify({ onComplete, onSignOut }) {
  const [code, setCode]         = useState('')
  const [error, setError]       = useState('')
  const [verifying, setVerifying] = useState(false)

  async function verify() {
    if (code.length !== 6) return
    setVerifying(true)
    setError('')

    try {
      const { data: factorsData } = await supabase.auth.mfa.listFactors()
      const totpFactor = factorsData?.totp?.[0]
      if (!totpFactor) throw new Error('No 2FA factor found')

      const { data: challengeData, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId: totpFactor.id })
      if (challengeError) throw challengeError

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: totpFactor.id,
        challengeId: challengeData.id,
        code: code.trim(),
      })
      if (verifyError) throw verifyError

      onComplete()

    } catch (err) {
      console.error('MFA error:', err)
      setError(err.message || 'Invalid code. Please try again.')
      setCode('')
      setVerifying(false)
    }
  }

  return (
    <div style={S.wrapper}>
      <div style={S.card}>
        <div style={S.logo}>Duchess & Butler</div>
        <div style={S.sub}>TWO-FACTOR AUTHENTICATION</div>

        <div style={{ fontSize: '14px', color: '#6B6860', marginBottom: '24px', lineHeight: 1.6 }}>
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
          style={{ ...S.btn, opacity: code.length !== 6 ? 0.5 : 1 }}
        >
          {verifying ? 'Verifying…' : 'Verify'}
        </button>

        <button
          onClick={onSignOut}
          style={{ width: '100%', padding: '10px', background: 'transparent', color: '#6B6860', border: 'none', borderRadius: '4px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", cursor: 'pointer', marginTop: '8px' }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

const S = {
  wrapper: { minHeight: '100vh', background: '#F7F3EE', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: "'DM Sans', sans-serif" },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '48px 40px', width: '100%', maxWidth: '380px', boxShadow: '0 12px 48px rgba(28,28,30,0.10)', textAlign: 'center' },
  logo: { fontFamily: "'Cormorant Garamond', serif", fontSize: '26px', fontWeight: '600', color: '#1C1C1E', marginBottom: '4px' },
  sub: { fontSize: '10px', letterSpacing: '0.18em', color: '#B8965A', fontWeight: '600', marginBottom: '28px' },
  label: { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.08em', color: '#1C1C1E', marginBottom: '8px' },
  input: { width: '100%', padding: '14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '14px', fontFamily: "'DM Sans', sans-serif", color: '#1C1C1E', background: '#fff', boxSizing: 'border-box', outline: 'none' },
  error: { background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA', borderRadius: '4px', padding: '10px 14px', fontSize: '13px', marginBottom: '16px' },
  btn: { width: '100%', padding: '12px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '14px', fontWeight: '500', fontFamily: "'DM Sans', sans-serif", cursor: 'pointer' },
}

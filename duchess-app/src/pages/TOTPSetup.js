import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import * as OTPAuth from 'otpauth'

export default function TOTPSetup({ onComplete, onSkip }) {
  const { profile } = useAuth()
  const [secret, setSecret]   = useState(null)
  const [qrUrl, setQrUrl]     = useState(null)
  const [code, setCode]       = useState('')
  const [error, setError]     = useState('')
  const [saving, setSaving]   = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { generateSecret() }, [])

  function generateSecret() {
    const totp = new OTPAuth.TOTP({
      issuer: 'Duchess & Butler',
      label: profile?.email || profile?.name || 'user',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromRandom(20),
    })
    setSecret(totp.secret.base32)
    setQrUrl(totp.toString())
    setLoading(false)
  }

  async function verify() {
    if (code.length !== 6) return
    setSaving(true)
    setError('')

    const totp = new OTPAuth.TOTP({
      issuer: 'Duchess & Butler',
      label: profile?.email || profile?.name || 'user',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    })

    const delta = totp.validate({ token: code, window: 1 })

    if (delta === null) {
      setError('Invalid code. Please try again.')
      setCode('')
      setSaving(false)
      return
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({ totp_secret: secret, totp_enabled: true })
      .eq('id', profile.id)

    if (updateError) {
      setError('Error saving. Please try again.')
      setSaving(false)
      return
    }

    setSaving(false)
    onComplete()
  }

  if (loading) return (
    <div style={S.wrapper}>
      <div style={S.card}>
        <div style={S.logo}>Duchess & Butler</div>
        <div style={{ color: '#6B6860' }}>Setting up authenticator…</div>
      </div>
    </div>
  )

  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrUrl)}`

  return (
    <div style={S.wrapper}>
      <div style={S.card}>
        <div style={S.logo}>Duchess & Butler</div>
        <div style={S.sub}>SET UP AUTHENTICATOR</div>

        <div style={{ textAlign: 'left', marginBottom: '20px' }}>
          {[
            'Download Google Authenticator on your phone',
            'Tap + and scan the QR code below',
            'Enter the 6-digit code to confirm',
          ].map((step, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: '#1C1C1E', color: '#fff', fontSize: '11px', fontWeight: '600', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</div>
              <div style={{ fontSize: '13px', color: '#1C1C1E', lineHeight: 1.5 }}>{step}</div>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <img src={qrImageUrl} alt="QR Code" style={{ width: '180px', height: '180px', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '8px' }} />
          <div style={{ marginTop: '10px', fontSize: '11px', color: '#6B6860' }}>
            Can't scan? Enter this code manually:
            <div style={{ fontFamily: 'monospace', fontSize: '12px', color: '#1C1C1E', marginTop: '4px', background: '#F7F3EE', padding: '6px 10px', borderRadius: '4px', letterSpacing: '0.1em', wordBreak: 'break-all' }}>
              {secret}
            </div>
          </div>
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
            style={{ ...S.input, textAlign: 'center', fontSize: '24px', letterSpacing: '0.3em', fontFamily: 'monospace' }}
            onKeyDown={e => e.key === 'Enter' && verify()}
            autoFocus
          />
        </div>

        {error && <div style={S.error}>{error}</div>}

        <button
          onClick={verify}
          disabled={saving || code.length !== 6}
          style={{ ...S.btn, opacity: code.length !== 6 ? 0.5 : 1, marginBottom: '10px' }}
        >{saving ? 'Verifying…' : 'Enable Authenticator'}</button>

        <button
          onClick={onSkip}
          style={{ width: '100%', padding: '10px', background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}
        >Skip for now</button>
      </div>
    </div>
  )
}

const S = {
  wrapper: { minHeight: '100vh', background: '#F7F3EE', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: "'DM Sans', sans-serif" },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '40px 36px', width: '100%', maxWidth: '420px', boxShadow: '0 12px 48px rgba(28,28,30,0.10)', textAlign: 'center' },
  logo: { fontFamily: "'Cormorant Garamond', serif", fontSize: '26px', fontWeight: '600', color: '#1C1C1E', marginBottom: '4px' },
  sub: { fontSize: '10px', letterSpacing: '0.18em', color: '#B8965A', fontWeight: '600', marginBottom: '24px' },
  label: { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.08em', color: '#1C1C1E', marginBottom: '6px', textAlign: 'left' },
  input: { width: '100%', padding: '12px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '14px', fontFamily: "'DM Sans', sans-serif", color: '#1C1C1E', background: '#fff', boxSizing: 'border-box', outline: 'none' },
  error: { background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA', borderRadius: '4px', padding: '10px 14px', fontSize: '13px', marginBottom: '16px' },
  btn: { width: '100%', padding: '12px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '14px', fontWeight: '500', fontFamily: "'DM Sans', sans-serif", cursor: 'pointer' },
}


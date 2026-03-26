import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function MFASetup({ onComplete }) {
  const [qrCode, setQrCode]     = useState(null)
  const [secret, setSecret]     = useState(null)
  const [factorId, setFactorId] = useState(null)
  const [code, setCode]         = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(true)
  const [verifying, setVerifying] = useState(false)

  useEffect(() => { enrollMFA() }, [])

  async function enrollMFA() {
    try {
      // Check if factor already exists
      const { data: existing } = await supabase.auth.mfa.listFactors()
      const existingFactor = existing?.totp?.[0]
      
      if (existingFactor && existingFactor.status === 'verified') {
        // Already verified — go straight to app
        onComplete()
        return
      }

      if (existingFactor && existingFactor.status === 'unverified') {
        // Factor exists but not verified — unenroll and re-enroll
        await supabase.auth.mfa.unenroll({ factorId: existingFactor.id })
      }

      // Enroll new factor
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Duchess & Butler',
      })
      if (error) throw error
      
      setQrCode(data.totp.qr_code)
      setSecret(data.totp.secret)
      setFactorId(data.id)
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  async function verifyCode() {
    if (code.length !== 6) return
    setVerifying(true)
    setError('')
    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
    if (challengeError) { setError(challengeError.message); setVerifying(false); return }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code,
    })
    if (verifyError) { setError('Invalid code. Please try again.'); setVerifying(false); return }
    setVerifying(false)
    onComplete()
  }

  if (loading) return (
    <div style={S.wrapper}>
      <div style={S.card}>
        <div style={S.logo}>Duchess & Butler</div>
        <div style={{ color: '#6B6860', fontSize: '14px' }}>Setting up 2FA...</div>
      </div>
    </div>
  )

  return (
    <div style={S.wrapper}>
      <div style={S.card}>
        <div style={S.logo}>Duchess & Butler</div>
        <div style={S.sub}>TWO-FACTOR AUTHENTICATION SETUP</div>

        <div style={{ textAlign: 'left', marginBottom: '20px' }}>
          <div style={S.step}>
            <div style={S.stepNum}>1</div>
            <div style={S.stepText}>Download <strong>Google Authenticator</strong> on your phone</div>
          </div>
          <div style={S.step}>
            <div style={S.stepNum}>2</div>
            <div style={S.stepText}>Scan the QR code below</div>
          </div>
          <div style={S.step}>
            <div style={S.stepNum}>3</div>
            <div style={S.stepText}>Enter the 6-digit code to confirm</div>
          </div>
        </div>

        {qrCode && (
          <div style={{ textAlign: 'center', marginBottom: '20px' }}>
            <img src={qrCode} alt="QR Code" style={{ width: '180px', height: '180px', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '8px' }} />
            <div style={{ marginTop: '10px', fontSize: '11px', color: '#6B6860' }}>
              Can't scan? Enter manually:
              <div style={{ fontFamily: 'monospace', fontSize: '12px', color: '#1C1C1E', marginTop: '4px', background: '#F7F3EE', padding: '6px 10px', borderRadius: '4px', letterSpacing: '0.1em' }}>
                {secret}
              </div>
            </div>
          </div>
        )}

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
            onKeyDown={e => e.key === 'Enter' && verifyCode()}
            autoFocus
          />
        </div>

        {error && <div style={S.error}>{error}</div>}

        <button
          onClick={verifyCode}
          disabled={verifying || code.length !== 6}
          style={{ ...S.btn, opacity: code.length !== 6 ? 0.5 : 1 }}
        >
          {verifying ? 'Verifying...' : 'Enable 2FA'}
        </button>
      </div>
    </div>
  )
}

const S = {
  wrapper: { minHeight: '100vh', background: '#F7F3EE', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: "'DM Sans', sans-serif" },
  card: { background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '40px 36px', width: '100%', maxWidth: '420px', boxShadow: '0 12px 48px rgba(28,28,30,0.10)', textAlign: 'center' },
  logo: { fontFamily: "'Cormorant Garamond', serif", fontSize: '26px', fontWeight: '600', color: '#1C1C1E', marginBottom: '4px' },
  sub: { fontSize: '10px', letterSpacing: '0.18em', color: '#B8965A', fontWeight: '600', marginBottom: '28px' },
  step: { display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '10px' },
  stepNum: { width: '22px', height: '22px', borderRadius: '50%', background: '#1C1C1E', color: '#fff', fontSize: '11px', fontWeight: '600', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '1px' },
  stepText: { fontSize: '13px', color: '#1C1C1E', lineHeight: 1.5, textAlign: 'left' },
  label: { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.08em', color: '#1C1C1E', marginBottom: '6px' },
  input: { width: '100%', padding: '12px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '14px', fontFamily: "'DM Sans', sans-serif", color: '#1C1C1E', background: '#fff', boxSizing: 'border-box', outline: 'none' },
  error: { background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA', borderRadius: '4px', padding: '10px 14px', fontSize: '13px', marginBottom: '16px' },
  btn: { width: '100%', padding: '12px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '14px', fontWeight: '500', fontFamily: "'DM Sans', sans-serif", cursor: 'pointer', marginTop: '8px' },
}

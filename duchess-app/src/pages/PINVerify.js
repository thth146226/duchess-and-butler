import { useState } from 'react'
import { supabase } from '../lib/supabase'

function hashPIN(pin) {
  let hash = 0
  for (let i = 0; i < pin.length; i++) {
    hash = ((hash << 5) - hash) + pin.charCodeAt(i)
    hash |= 0
  }
  return String(Math.abs(hash))
}

export default function PINVerify({ userId, onComplete, onSignOut }) {
  const [pin, setPin]             = useState('')
  const [error, setError]       = useState('')
  const [verifying, setVerifying] = useState(false)

  async function verifyPin() {
    if (pin.length !== 4) return
    setVerifying(true)
    setError('')

    try {
      const { data, error } = await supabase
        .from('users')
        .select('pin_hash, pin_enabled')
        .eq('id', userId)
        .single()
      if (error) throw error

      if (!data?.pin_enabled || !data?.pin_hash) {
        throw new Error('PIN is not enabled for this account.')
      }

      const hashed = hashPIN(pin)
      if (hashed !== data.pin_hash) {
        throw new Error('Invalid PIN. Please try again.')
      }

      setVerifying(false)
      onComplete()
    } catch (err) {
      console.error('PIN verify error:', err)
      setError(err.message || 'Invalid PIN. Please try again.')
      setPin('')
      setVerifying(false)
    }
  }

  return (
    <div style={S.wrapper}>
      <div style={S.card}>
        <div style={S.logo}>Duchess & Butler</div>
        <div style={S.sub}>ENTER PIN</div>

        <div style={{ fontSize: '14px', color: '#6B6860', marginBottom: '20px', lineHeight: 1.6 }}>
          Enter your 4-digit PIN to continue.
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={S.label}>VERIFICATION CODE</label>
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\\D/g, ''))}
            placeholder="0000"
            style={{ ...S.input, textAlign: 'center', fontSize: '24px', letterSpacing: '0.4em', fontFamily: 'monospace' }}
            onKeyDown={e => e.key === 'Enter' && verifyPin()}
            autoFocus
          />
        </div>

        {error && <div style={S.error}>{error}</div>}

        <button
          onClick={verifyPin}
          disabled={verifying || pin.length !== 4}
          style={{ ...S.btn, opacity: pin.length !== 4 ? 0.5 : 1 }}
        >
          {verifying ? 'Verifying…' : 'Verify'}
        </button>

        <button
          onClick={onSignOut}
          style={{ width: '100%', padding: '10px', background: 'transparent', color: '#6B6860', border: 'none', borderRadius: '4px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", cursor: 'pointer', marginTop: '10px' }}
        >
          Sign out
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
  label: { display: 'block', fontSize: '11px', fontWeight: '500', letterSpacing: '0.08em', color: '#1C1C1E', marginBottom: '8px' },
  input: { width: '100%', padding: '14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '14px', fontFamily: "'DM Sans', sans-serif", color: '#1C1C1E', background: '#fff', boxSizing: 'border-box', outline: 'none' },
  error: { background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA', borderRadius: '4px', padding: '10px 14px', fontSize: '13px', marginBottom: '16px' },
  btn: { width: '100%', padding: '12px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '14px', fontWeight: '500', fontFamily: "'DM Sans', sans-serif", cursor: 'pointer', marginTop: '10px' },
}


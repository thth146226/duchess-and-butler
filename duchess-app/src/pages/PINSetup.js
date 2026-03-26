import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

function hashPIN(pin) {
  let hash = 0
  for (let i = 0; i < pin.length; i++) {
    hash = ((hash << 5) - hash) + pin.charCodeAt(i)
    hash |= 0
  }
  return String(Math.abs(hash))
}

export default function PINSetup() {
  const { profile } = useAuth()
  const [step, setStep]       = useState('enter')
  const [pin, setPin]         = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving]   = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError]     = useState('')

  async function savePin() {
    if (pin !== confirm) { setError('PINs do not match'); return }
    if (pin.length !== 4) { setError('PIN must be 4 digits'); return }
    setSaving(true)
    const { error } = await supabase
      .from('users')
      .update({ pin_hash: hashPIN(pin), pin_enabled: true })
      .eq('id', profile.id)
    if (error) { setError(error.message); setSaving(false); return }
    setSuccess(true)
    setSaving(false)
  }

  async function disablePin() {
    setSaving(true)
    await supabase
      .from('users')
      .update({ pin_hash: null, pin_enabled: false })
      .eq('id', profile.id)
    setSaving(false)
    setSuccess(false)
    setPin('')
    setConfirm('')
    setStep('enter')
  }

  function PinInput({ value, onChange, label }) {
    return (
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontSize: '11px', fontWeight: '500', letterSpacing: '0.08em', color: '#6B6860', marginBottom: '8px', textTransform: 'uppercase' }}>{label}</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginBottom: '16px' }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{ width: '14px', height: '14px', borderRadius: '50%', background: i < value.length ? '#1C1C1E' : '#DDD8CF' }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', maxWidth: '200px', margin: '0 auto' }}>
          {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((d, i) => (
            <button key={i} onClick={() => {
              if (d === '⌫') onChange(v => v.slice(0,-1))
              else if (d && value.length < 4) onChange(v => v + d)
            }} style={{ padding: '12px', borderRadius: '6px', border: '1px solid #DDD8CF', background: d === '' ? 'transparent' : '#fff', fontSize: d === '⌫' ? '16px' : '18px', fontWeight: '500', cursor: d === '' ? 'default' : 'pointer', fontFamily: "'DM Sans', sans-serif", visibility: d === '' ? 'hidden' : 'visible' }}>{d}</button>
          ))}
        </div>
      </div>
    )
  }

  if (success) return (
    <div style={{ background: '#EAF3DE', border: '1px solid #86EFAC', borderRadius: '8px', padding: '20px', textAlign: 'center' }}>
      <div style={{ fontSize: '14px', fontWeight: '500', color: '#3B6D11', marginBottom: '8px' }}>PIN enabled successfully</div>
      <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '16px' }}>You will be asked for your PIN on every login.</div>
      <button onClick={disablePin} disabled={saving} style={{ fontSize: '12px', padding: '7px 16px', borderRadius: '6px', border: '1px solid #EF4444', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
        {saving ? 'Disabling…' : 'Disable PIN'}
      </button>
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ fontSize: '13px', color: '#6B6860', marginBottom: '20px' }}>
        Set a 4-digit PIN for extra security. You will be asked for it every time you log in.
      </div>
      {step === 'enter' ? (
        <>
          <PinInput value={pin} onChange={setPin} label="Enter new PIN" />
          <button
            onClick={() => { if (pin.length === 4) { setStep('confirm'); } }}
            disabled={pin.length !== 4}
            style={{ width: '100%', padding: '10px', background: pin.length !== 4 ? '#DDD8CF' : '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: pin.length !== 4 ? 'default' : 'pointer', fontFamily: "'DM Sans', sans-serif" }}
          >Continue</button>
        </>
      ) : (
        <>
          <PinInput value={confirm} onChange={setConfirm} label="Confirm PIN" />
          {error && <div style={{ color: '#DC2626', fontSize: '12px', marginBottom: '12px' }}>{error}</div>}
          <button
            onClick={savePin}
            disabled={saving || confirm.length !== 4}
            style={{ width: '100%', padding: '10px', background: confirm.length !== 4 ? '#DDD8CF' : '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: confirm.length !== 4 ? 'default' : 'pointer', fontFamily: "'DM Sans', sans-serif" }}
          >{saving ? 'Saving…' : 'Enable PIN'}</button>
          <button onClick={() => { setStep('enter'); setConfirm(''); setError('') }} style={{ width: '100%', marginTop: '8px', padding: '10px', background: 'transparent', border: 'none', color: '#6B6860', cursor: 'pointer', fontSize: '12px', fontFamily: "'DM Sans', sans-serif" }}>Back</button>
        </>
      )}
    </div>
  )
}


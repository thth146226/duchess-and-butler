import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function DriverLinks() {
  const [drivers, setDrivers] = useState([])
  const [copied, setCopied]   = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchDrivers() }, [])

  async function fetchDrivers() {
    const { data } = await supabase
      .from('drivers')
      .select('*')
      .eq('active', true)
      .order('name')
    if (data) setDrivers(data)
    setLoading(false)
  }

  function getLink(token) {
    return `${window.location.origin}?token=${token}`
  }

  async function copyLink(driver) {
    await navigator.clipboard.writeText(getLink(driver.access_token))
    setCopied(driver.id)
    setTimeout(() => setCopied(null), 2000)
  }

  function openWhatsApp(driver) {
    const link = getLink(driver.access_token)
    const msg = encodeURIComponent(`Hi ${driver.name}! Here is your Duchess & Butler driver portal link: ${link}`)
    window.open(`https://wa.me/?text=${msg}`, '_blank')
  }

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>Loading…</div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px', padding: '14px 16px', marginBottom: '24px' }}>
        <div style={{ fontSize: '13px', fontWeight: '500', marginBottom: '4px' }}>Driver access links</div>
        <div style={{ fontSize: '12px', color: '#6B6860' }}>Each driver has a unique link — no password needed. Share via WhatsApp or SMS. Drivers can only see their own assigned jobs.</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {drivers.map(d => (
          <div key={d.id} style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '10px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: d.colour || '#B8965A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', fontWeight: '600', color: '#fff', flexShrink: 0 }}>
              {d.name?.[0]}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '4px' }}>{d.name}</div>
              <div style={{ fontSize: '11px', color: '#9CA3AF', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {getLink(d.access_token)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              <button
                onClick={() => copyLink(d)}
                style={{ fontSize: '12px', fontWeight: '500', padding: '7px 16px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: copied === d.id ? '#EAF3DE' : '#F7F3EE', color: copied === d.id ? '#3B6D11' : '#1C1C1E', border: `1px solid ${copied === d.id ? '#86EFAC' : '#DDD8CF'}` }}
              >{copied === d.id ? '✓ Copied!' : 'Copy link'}</button>
              <button
                onClick={() => openWhatsApp(d)}
                style={{ fontSize: '12px', fontWeight: '500', padding: '7px 16px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: '#DCFCE7', color: '#166534', border: '1px solid #86EFAC' }}
              >WhatsApp</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

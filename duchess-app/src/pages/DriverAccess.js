import { useEffect, useState } from 'react'
import DriverPortal from './DriverPortal'

export default function DriverAccess() {
  const [token, setToken] = useState(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('token')
    setToken(t)
  }, [])

  if (!token) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F3EE', fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ textAlign: 'center', color: '#6B6860' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>🔗</div>
        <div style={{ fontSize: '15px', fontWeight: '500' }}>No access token</div>
        <div style={{ fontSize: '13px', marginTop: '6px' }}>Please use your unique driver link.</div>
      </div>
    </div>
  )

  return <DriverPortal token={token} />
}

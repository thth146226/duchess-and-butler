// Schedule, Inventory, Reports, Team — Phase 3 & 4 will complete these (Paperwork is in pages/Paperwork.js)

export function Schedule() {
  return (
    <div style={placeholderStyle}>
      <div style={icon}>📅</div>
      <div style={title}>Schedule</div>
      <div style={sub}>Coming in Phase 3 — will show weekly delivery & collection calendar pulled live from orders.</div>
    </div>
  )
}

export function Inventory() {
  return (
    <div style={placeholderStyle}>
      <div style={icon}>📦</div>
      <div style={title}>Inventory</div>
      <div style={sub}>Coming in Phase 3 — live stock levels with low-stock alerts.</div>
    </div>
  )
}

export function Reports() {
  return (
    <div style={placeholderStyle}>
      <div style={icon}>📊</div>
      <div style={title}>Reports</div>
      <div style={sub}>Coming in Phase 4 — live revenue, orders and item return rate dashboard.</div>
    </div>
  )
}

export function Team() {
  return (
    <div style={placeholderStyle}>
      <div style={icon}>👥</div>
      <div style={title}>Team Access</div>
      <div style={sub}>Coming in Phase 3 — invite team members by email and assign roles.</div>
    </div>
  )
}

const placeholderStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', fontFamily: "'DM Sans', sans-serif", textAlign: 'center', padding: '48px' }
const icon = { fontSize: '48px', marginBottom: '16px', opacity: 0.4 }
const title = { fontFamily: "'Cormorant Garamond', serif", fontSize: '28px', fontWeight: '600', color: '#1C1C1E', marginBottom: '12px' }
const sub = { fontSize: '14px', color: '#6B6860', maxWidth: '400px', lineHeight: 1.6 }

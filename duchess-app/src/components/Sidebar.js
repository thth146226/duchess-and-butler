import { useAuth } from '../contexts/AuthContext'

const navItems = [
  { section: 'Overview', items: [
    { id: 'dashboard', icon: '◈', label: 'Dashboard', roles: ['admin','operations','driver'] },
  ]},
  { section: 'Live Operations', items: [
    { id: 'livejobs', icon: '⚡', label: 'Live Jobs', roles: ['admin','operations','driver'], highlight: true },
    { id: 'schedule', icon: '📅', label: 'Schedule', roles: ['admin','operations','driver'] },
  ]},
  { section: 'Management', items: [
    { id: 'orders', icon: '📋', label: 'Orders', roles: ['admin','operations'] },
    { id: 'inventory', icon: '📦', label: 'Inventory', roles: ['admin','operations'] },
  ]},
  { section: 'Documents', items: [
    { id: 'paperwork', icon: '📄', label: 'Paperwork', roles: ['admin','operations'] },
    { id: 'reports', icon: '📊', label: 'Reports', roles: ['admin'] },
  ]},
  { section: 'Settings', items: [
    { id: 'team', icon: '👥', label: 'Team Access', roles: ['admin'] },
  ]},
]

export default function Sidebar({ active, onNavigate, isOpen, onClose, pendingCount = 0 }) {
  const { profile, signOut } = useAuth()
  const role = profile?.role || 'driver'
  const initials = profile?.name?.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase() || 'DB'

  function handleNav(id) { onNavigate(id); onClose() }

  return (
    <>
      {isOpen && (
        <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 99, display: 'none' }} className="mobile-overlay" />
      )}

      <aside style={{ ...styles.sidebar, transform: isOpen ? 'translateX(0)' : undefined }}>
        <button onClick={onClose} style={styles.closeBtn} className="mobile-close">✕</button>

        <div style={styles.logo}>
          <div style={styles.logoMark}>Duchess & Butler</div>
          <div style={styles.logoSub}>Event Supply Management</div>
        </div>

        <nav style={styles.nav}>
          {navItems.map(group => {
            const visibleItems = group.items.filter(item => item.roles.includes(role))
            if (!visibleItems.length) return null
            return (
              <div key={group.section}>
                <div style={styles.sectionLabel}>{group.section}</div>
                {visibleItems.map(item => (
                  <div
                    key={item.id}
                    style={{
                      ...styles.navItem,
                      ...(active === item.id ? styles.navItemActive : {}),
                      ...(item.highlight && active !== item.id ? styles.navItemHighlight : {}),
                    }}
                    onClick={() => handleNav(item.id)}
                  >
                    <span style={styles.navIcon}>{item.icon}</span>
                    {item.label}
                    {item.id === 'livejobs' && (
                      <span style={{ marginLeft: 'auto', width: '7px', height: '7px', borderRadius: '50%', background: '#22C55E', animation: 'pulse 2s infinite' }} />
                    )}
                    {item.id === 'orders' && pendingCount > 0 && (
                      <span style={styles.badge}>{pendingCount}</span>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </nav>

        <div style={styles.footer}>
          <div style={styles.userPill}>
            <div style={styles.avatar}>{initials}</div>
            <div style={styles.userInfo}>
              <div style={styles.userName}>{profile?.name || 'User'}</div>
              <div style={styles.userRole}>{role}</div>
            </div>
            <button onClick={signOut} style={styles.signOut} title="Sign out">↩</button>
          </div>
        </div>
      </aside>

      <style>{`
        @media (max-width: 768px) {
          .mobile-overlay { display: block !important; }
          .mobile-close { display: flex !important; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </>
  )
}

const styles = {
  sidebar: { position: 'fixed', top: 0, left: 0, width: '260px', height: '100vh', background: '#1C1C1E', display: 'flex', flexDirection: 'column', zIndex: 100, borderRight: '1px solid rgba(184,150,90,0.2)', fontFamily: "'DM Sans', sans-serif", transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)' },
  closeBtn: { display: 'none', position: 'absolute', top: '16px', right: '16px', background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', alignItems: 'center', justifyContent: 'center', fontSize: '14px', zIndex: 1 },
  logo: { padding: '32px 28px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)' },
  logoMark: { fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', fontWeight: '600', color: '#D4AF7A', letterSpacing: '0.04em' },
  logoSub: { fontSize: '10px', letterSpacing: '0.18em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginTop: '4px' },
  nav: { flex: 1, padding: '20px 0', overflowY: 'auto' },
  sectionLabel: { fontSize: '10px', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)', padding: '16px 28px 8px' },
  navItem: { display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 28px', color: 'rgba(255,255,255,0.55)', cursor: 'pointer', fontSize: '13.5px', borderLeft: '2px solid transparent', transition: 'all 0.2s' },
  navItemActive: { color: '#D4AF7A', background: 'rgba(184,150,90,0.1)', borderLeftColor: '#B8965A' },
  navItemHighlight: { color: 'rgba(255,255,255,0.8)' },
  navIcon: { fontSize: '16px', width: '20px', textAlign: 'center' },
  badge: { marginLeft: 'auto', background: '#6B2D3E', color: 'white', fontSize: '10px', fontWeight: '600', padding: '2px 7px', borderRadius: '10px' },
  footer: { padding: '20px 28px', borderTop: '1px solid rgba(255,255,255,0.08)' },
  userPill: { display: 'flex', alignItems: 'center', gap: '10px' },
  avatar: { width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #B8965A, #D4AF7A)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '600', color: '#1C1C1E', flexShrink: 0 },
  userInfo: { flex: 1 },
  userName: { fontSize: '12.5px', color: 'rgba(255,255,255,0.8)', fontWeight: '500' },
  userRole: { fontSize: '10.5px', color: 'rgba(255,255,255,0.35)', textTransform: 'capitalize' },
  signOut: { background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '16px', padding: '4px' },
}

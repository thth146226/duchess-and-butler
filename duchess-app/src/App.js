// v2.1 fleet
import { useState } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import DriverAccess from './pages/DriverAccess'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import Notifications from './pages/Notifications'
import Orders from './pages/Orders'
import Schedule from './pages/Schedule'
import LiveJobs from './pages/LiveJobs'
import Notes from './pages/Notes'
import DeliveryPhotos from './pages/Evidences'
import Paperwork from './pages/Paperwork'
import DriverLinks from './pages/DriverLinks'
import TOTPSetup from './pages/TOTPSetup'
import TOTPVerify from './pages/TOTPVerify'
import { Team } from './pages/Placeholders'
import Inventory from './pages/Inventory'
import Reports from './pages/Reports'
import Fleet from './pages/Fleet'
import ATACarnet from './pages/ATACarnet'
import LabelGenerator from './pages/LabelGenerator'
import Loyalty from './pages/Loyalty'
import RewardsPortal from './pages/RewardsPortal'
import PortalInvite from './pages/PortalInvite'
import ClientPortal from './pages/ClientPortal'

const pageTitles = {
  dashboard: 'Dashboard',
  notifications: 'Notifications',
  notes: 'Notes',
  evidences: 'Delivery Photos',
  livejobs: 'Live Jobs — Current RMS',
  orders: 'Orders',
  schedule: 'Schedule',
  inventory: 'Inventory',
  paperwork: 'Paperwork',
  fleet: 'Fleet Management',
  atacarnet: 'ATA Carnet',
  labelGenerator: 'Label Generator',
  reports: 'Reports',
  loyalty: 'Duchess Rewards',
  driverlinks: 'Driver Links',
  team: 'Team Access',
}

function AppInner() {
  const { user, profile, loading } = useAuth()
  const [page, setPage] = useState('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [scheduleRefreshKey, setScheduleRefreshKey] = useState(0)
  const [totpVerified, setTotpVerified] = useState(() => {
    try {
      const saved = sessionStorage.getItem('totp_verified')
      if (!saved) return false
      const { verified, timestamp } = JSON.parse(saved)
      const threeHours = 3 * 60 * 60 * 1000
      if (verified && Date.now() - timestamp < threeHours) return true
      sessionStorage.removeItem('totp_verified')
      return false
    } catch {
      return false
    }
  })

  // Public driver portal — no auth required
  const params = new URLSearchParams(window.location.search)
  if (params.get('token')) return <DriverAccess />

  // Public portal invite — no auth required
  if (window.location.pathname.startsWith('/portal/invite')) return <PortalInvite />

  // Authenticated client portal
  if (window.location.pathname.startsWith('/portal/')) return <ClientPortal />

  // Legacy rewards portal — token-based, no auth
  if (window.location.pathname.startsWith('/rewards/')) return <RewardsPortal />

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F3EE', fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', color: '#1C1C1E' }}>
      Duchess & Butler…
    </div>
  )

  if (!user) return <Login />

  if (user && profile) {
    if (profile.totp_enabled && !totpVerified) {
      return (
        <TOTPVerify
          userId={user.id}
          onComplete={() => {
            sessionStorage.setItem('totp_verified', JSON.stringify({
              verified: true,
              timestamp: Date.now()
            }))
            setTotpVerified(true)
          }}
          onSignOut={async () => {
            setTotpVerified(false)
            sessionStorage.removeItem('totp_verified')
            await supabase.auth.signOut()
          }}
        />
      )
    }
    if (!profile.totp_enabled) {
      return (
        <TOTPSetup
          onComplete={() => {
            sessionStorage.setItem('totp_verified', JSON.stringify({
              verified: true,
              timestamp: Date.now()
            }))
            setTotpVerified(true)
          }}
          onSkip={() => {
            sessionStorage.setItem('totp_verified', JSON.stringify({
              verified: true,
              timestamp: Date.now()
            }))
            setTotpVerified(true)
          }}
        />
      )
    }
  }

  const pages = { dashboard: Dashboard, notifications: Notifications, notes: Notes, evidences: DeliveryPhotos, livejobs: LiveJobs, orders: Orders, schedule: Schedule, inventory: Inventory, paperwork: Paperwork, fleet: Fleet, atacarnet: ATACarnet, labelGenerator: LabelGenerator, reports: Reports, loyalty: Loyalty, driverlinks: DriverLinks, team: Team }
  const PageComponent = pages[page] || Dashboard

  return (
    <>
      <style>{`
        @media (max-width: 768px) {
          .sidebar-desktop { transform: translateX(-260px) !important; }
          .sidebar-desktop.open { transform: translateX(0) !important; }
          .main-content { margin-left: 0 !important; }
          .hamburger { display: flex !important; }
        }
      `}</style>

      <div style={{ display: 'flex', minHeight: '100vh', background: '#F7F3EE', fontFamily: "'DM Sans', sans-serif" }}>
        <div className={`sidebar-desktop ${sidebarOpen ? 'open' : ''}`}>
          <Sidebar
            active={page}
            onNavigate={setPage}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />
        </div>

        <main className="main-content" style={{ marginLeft: '260px', flex: 1, display: 'flex', flexDirection: 'column' }}>
          <header style={styles.topbar}>
            <button className="hamburger" onClick={() => setSidebarOpen(true)} style={styles.hamburger}>
              <span style={styles.hamburgerLine} />
              <span style={styles.hamburgerLine} />
              <span style={styles.hamburgerLine} />
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
              <div style={styles.pageTitle}>{pageTitles[page] || page}</div>
              {page === 'livejobs' && (
                <span style={{ background: '#ECFDF5', color: '#065F46', fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '10px', border: '1px solid #BBF7D0' }}>
                  ⚡ Live sync
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {page === 'dashboard' && (
                <button style={styles.btnGold} onClick={() => setPage('orders')}>＋ New Order</button>
              )}
            </div>
          </header>

          <div style={{ padding: '24px 28px', flex: 1 }}>
            <PageComponent
              onNavigate={setPage}
              refreshKey={page === 'schedule' ? scheduleRefreshKey : undefined}
              onForceScheduleRefresh={() => setScheduleRefreshKey(k => k + 1)}
            />
          </div>
        </main>
      </div>
    </>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  )
}

const styles = {
  topbar: {
    background: '#fff', borderBottom: '1px solid #DDD8CF',
    padding: '0 28px', height: '64px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    position: 'sticky', top: 0, zIndex: 50,
    boxShadow: '0 1px 0 #DDD8CF', gap: '16px',
  },
  pageTitle: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: '26px', fontWeight: '600', color: '#1C1C1E',
  },
  hamburger: {
    display: 'none', flexDirection: 'column', justifyContent: 'center',
    gap: '5px', background: 'transparent', border: 'none',
    cursor: 'pointer', padding: '8px', borderRadius: '6px', flexShrink: 0,
  },
  hamburgerLine: {
    display: 'block', width: '22px', height: '2px',
    background: '#1C1C1E', borderRadius: '2px',
  },
  btnGold: {
    background: '#B8965A', color: '#fff', border: 'none',
    borderRadius: '4px', padding: '9px 20px', fontSize: '13px',
    fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
    whiteSpace: 'nowrap',
  },
}

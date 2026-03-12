import { useState } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Login from './pages/Login'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import Orders from './pages/Orders'
import Schedule from './pages/Schedule'
import { Inventory, Paperwork, Reports, Team } from './pages/Placeholders'

const pageTitles = {
  dashboard: 'Dashboard',
  orders: 'Orders',
  schedule: 'Schedule',
  inventory: 'Inventory',
  paperwork: 'Paperwork',
  reports: 'Reports',
  team: 'Team Access',
}

function AppInner() {
  const { user, profile, loading } = useAuth()
  const [page, setPage] = useState('dashboard')

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F3EE', fontFamily: "'Cormorant Garamond', serif", fontSize: '22px', color: '#1C1C1E' }}>
      Duchess & Butler…
    </div>
  )

  if (!user) return <Login />

  const pages = { dashboard: Dashboard, orders: Orders, schedule: Schedule, inventory: Inventory, paperwork: Paperwork, reports: Reports, team: Team }
  const PageComponent = pages[page] || Dashboard

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#F7F3EE', fontFamily: "'DM Sans', sans-serif" }}>
      <Sidebar active={page} onNavigate={setPage} />

      <main style={{ marginLeft: '260px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Topbar */}
        <header style={styles.topbar}>
          <div style={styles.pageTitle}>{pageTitles[page] || page}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {page === 'dashboard' && (
              <button style={styles.btnGold} onClick={() => setPage('orders')}>＋ New Order</button>
            )}
            {page === 'orders' && (
              <span style={{ fontSize: '12px', color: '#6B6860' }}>
                {profile?.role === 'admin' ? 'Full access' : 'Standard access'}
              </span>
            )}
          </div>
        </header>

        {/* Page content */}
        <div style={{ padding: '32px 36px', flex: 1 }}>
          <PageComponent onNavigate={setPage} />
        </div>
      </main>
    </div>
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
    background: '#fff',
    borderBottom: '1px solid #DDD8CF',
    padding: '0 36px',
    height: '64px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    position: 'sticky', top: 0, zIndex: 50,
    boxShadow: '0 1px 0 #DDD8CF',
  },
  pageTitle: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: '26px', fontWeight: '600', color: '#1C1C1E',
  },
  btnGold: {
    background: '#B8965A', color: '#fff', border: 'none',
    borderRadius: '4px', padding: '9px 20px', fontSize: '13px',
    fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
  },
}

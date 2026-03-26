import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleGoogleLogin() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      }
    })
    if (error) setError('Google sign in failed. Please try again.')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await signIn(email, password)
    if (error) setError('Invalid email or password. Please try again.')
    setLoading(false)
  }

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        <div style={styles.logo}>Duchess & Butler</div>
        <div style={styles.sub}>EVENT SUPPLY MANAGEMENT</div>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.group}>
            <label style={styles.label}>EMAIL ADDRESS</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={styles.input}
              placeholder="you@duchessandbutler.co.uk"
              required
            />
          </div>
          <div style={styles.group}>
            <label style={styles.label}>PASSWORD</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={styles.input}
              placeholder="••••••••"
              required
            />
          </div>
          {error && <div style={styles.error}>{error}</div>}
          <button 
            type="button" 
            onClick={handleGoogleLogin}
            style={{
              width: '100%',
              padding: '11px',
              background: '#fff',
              color: '#1C1C1E',
              border: '1.5px solid #DDD8CF',
              borderRadius: '4px',
              fontSize: '14px',
              fontWeight: '500',
              cursor: 'pointer',
              fontFamily: "'DM Sans', sans-serif",
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              marginBottom: '12px',
            }}
          >
            <img src="https://www.google.com/favicon.ico" alt="Google" style={{ width: '18px', height: '18px' }} />
            Sign in with Google
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <div style={{ flex: 1, height: '1px', background: '#DDD8CF' }} />
            <span style={{ fontSize: '12px', color: '#9CA3AF' }}>or</span>
            <div style={{ flex: 1, height: '1px', background: '#DDD8CF' }} />
          </div>

          <button type="submit" style={styles.btn} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}

const styles = {
  wrapper: {
    minHeight: '100vh',
    background: '#F7F3EE',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    fontFamily: "'DM Sans', sans-serif",
  },
  card: {
    background: '#fff',
    border: '1px solid #DDD8CF',
    borderRadius: '8px',
    padding: '48px 40px',
    width: '100%',
    maxWidth: '400px',
    boxShadow: '0 12px 48px rgba(28,28,30,0.10)',
    textAlign: 'center',
  },
  logo: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: '28px',
    fontWeight: '600',
    color: '#1C1C1E',
    letterSpacing: '0.02em',
    marginBottom: '6px',
  },
  sub: {
    fontSize: '10px',
    letterSpacing: '0.18em',
    color: '#B8965A',
    fontWeight: '600',
    marginBottom: '36px',
  },
  form: { textAlign: 'left' },
  group: { marginBottom: '16px' },
  label: {
    display: 'block',
    fontSize: '11px',
    fontWeight: '500',
    letterSpacing: '0.08em',
    color: '#1C1C1E',
    marginBottom: '6px',
  },
  input: {
    width: '100%',
    padding: '10px 14px',
    border: '1.5px solid #DDD8CF',
    borderRadius: '4px',
    fontSize: '14px',
    fontFamily: "'DM Sans', sans-serif",
    color: '#1C1C1E',
    background: '#fff',
    boxSizing: 'border-box',
    outline: 'none',
  },
  error: {
    background: '#FEF2F2',
    color: '#DC2626',
    border: '1px solid #FECACA',
    borderRadius: '4px',
    padding: '10px 14px',
    fontSize: '13px',
    marginBottom: '16px',
  },
  btn: {
    width: '100%',
    padding: '12px',
    background: '#1C1C1E',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    fontSize: '14px',
    fontWeight: '500',
    fontFamily: "'DM Sans', sans-serif",
    cursor: 'pointer',
    marginTop: '8px',
  },
}

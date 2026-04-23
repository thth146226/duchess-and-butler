import { useAuth } from '../contexts/AuthContext'

export default function LabelGenerator() {
  const { profile } = useAuth()
  
  // Defense in depth — only admin role
  if (profile?.role !== 'admin') {
    return (
      <div style={{ 
        padding: '40px', 
        fontFamily: "'DM Sans', sans-serif",
        textAlign: 'center'
      }}>
        <div style={{ fontSize: '14px', color: '#6B6860' }}>
          Access restricted to administrators.
        </div>
      </div>
    )
  }
  
  return (
    <div style={{ 
      padding: '40px',
      fontFamily: "'DM Sans', sans-serif",
      maxWidth: '1200px',
      margin: '0 auto'
    }}>
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ 
          fontSize: '24px', 
          fontWeight: '600', 
          color: '#1C1C1E', 
          margin: 0,
          letterSpacing: '-0.01em'
        }}>
          Label Generator
        </h1>
        <div style={{ 
          fontSize: '13px', 
          color: '#6B6860', 
          marginTop: '6px' 
        }}>
          Generate printable labels for order packaging.
        </div>
      </div>
      
      <div style={{
        background: '#FDFCFA',
        border: '1px dashed #DDD8CF',
        borderRadius: '8px',
        padding: '60px 40px',
        textAlign: 'center'
      }}>
        <div style={{ 
          fontSize: '11px', 
          fontWeight: '600', 
          textTransform: 'uppercase', 
          letterSpacing: '0.1em', 
          color: '#B8965A',
          marginBottom: '8px'
        }}>
          Phase 1 · Isolated shell
        </div>
        <div style={{ fontSize: '13px', color: '#6B6860' }}>
          Label Generator module is being built. 
          Next phases will add order selection, 
          rule engine, preview, and print.
        </div>
      </div>
    </div>
  )
}

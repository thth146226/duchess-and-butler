import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const CATEGORIES = [
  { value: 'equipment', label: 'Equipment', icon: '📦', sub: 'Itens a não esquecer', bg: '#FEF3C7', border: '#BA7517', badgeBg: '#FDE68A', badgeColor: '#633806' },
  { value: 'access',    label: 'Access',    icon: '🔑', sub: 'Códigos, entradas',   bg: '#E6F1FB', border: '#185FA5', badgeBg: '#BFDBFE', badgeColor: '#1E3A5F' },
  { value: 'contact',   label: 'Contact',   icon: '📞', sub: 'Tel. cliente, contacto', bg: '#EAF3DE', border: '#3B6D11', badgeBg: '#BBF7D0', badgeColor: '#14532D' },
  { value: 'urgent',    label: 'Urgent',    icon: '⚠',  sub: 'Atenção imediata',   bg: '#FCEBEB', border: '#A32D2D', badgeBg: '#FCA5A5', badgeColor: '#7F1D1D' },
]

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts)
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function JobNotes({ jobId, jobTable = 'crms_jobs', crmsRef }) {
  const { profile } = useAuth()
  const [notes, setNotes]       = useState([])
  const [category, setCategory] = useState('equipment')
  const [text, setText]         = useState('')
  const [saving, setSaving]     = useState(false)
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    if (jobId) fetchNotes()
  }, [jobId])

  async function fetchNotes() {
    const { data } = await supabase
      .from('job_notes')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
    if (data) setNotes(data)
    setLoading(false)
  }

  async function saveNote() {
    if (!text.trim()) return
    setSaving(true)
    await supabase.from('job_notes').insert({
      job_id:          jobId,
      job_table:       jobTable,
      crms_ref:        crmsRef || null,
      category,
      note_text:       text.trim(),
      created_by:      profile?.id || null,
      created_by_name: profile?.name || 'Team',
    })
    setText('')
    setSaving(false)
    fetchNotes()
  }

  async function deleteNote(id) {
    await supabase.from('job_notes').delete().eq('id', id)
    fetchNotes()
  }

  const cat = (val) => CATEGORIES.find(c => c.value === val) || CATEGORIES[0]

  if (loading) return <div style={{ padding: '16px', fontSize: '13px', color: '#9CA3AF' }}>Loading notes…</div>

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Existing notes */}
      {notes.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={S.sectionLabel}>Notes do job</div>
          {notes.map(n => {
            const c = cat(n.category)
            return (
              <div key={n.id} style={{
                background: c.bg,
                borderLeft: `3px solid ${c.border}`,
                borderRadius: '8px',
                padding: '12px 14px',
                marginBottom: '8px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '4px', background: c.badgeBg, color: c.badgeColor }}>
                    {c.label.toUpperCase()}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '10px', color: '#6B6860' }}>{timeAgo(n.created_at)}</span>
                    <button
                      onClick={() => deleteNote(n.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: '#9CA3AF', padding: '0 2px' }}
                    >✕</button>
                  </div>
                </div>
                <div style={{ fontSize: '13px', color: '#1C1C1E', lineHeight: '1.5', marginBottom: '4px' }}>{n.note_text}</div>
                <div style={{ fontSize: '11px', color: '#6B6860' }}>por {n.created_by_name}</div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add note */}
      <div style={S.sectionLabel}>Adicionar note</div>

      {/* Category selector */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
        {CATEGORIES.map(c => (
          <button
            key={c.value}
            onClick={() => setCategory(c.value)}
            style={{
              padding: '10px 12px', borderRadius: '8px', cursor: 'pointer',
              fontFamily: "'DM Sans', sans-serif", textAlign: 'left',
              background: category === c.value ? c.bg : 'transparent',
              border: `1px solid ${category === c.value ? c.border : '#DDD8CF'}`,
            }}
          >
            <div style={{ fontSize: '16px', marginBottom: '3px' }}>{c.icon}</div>
            <div style={{ fontSize: '12px', fontWeight: '500', color: '#1C1C1E' }}>{c.label}</div>
            <div style={{ fontSize: '10px', color: '#6B6860' }}>{c.sub}</div>
          </button>
        ))}
      </div>

      {/* Text input */}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Escreve a note aqui…"
        style={{
          width: '100%', padding: '10px 12px',
          border: '1.5px solid #DDD8CF', borderRadius: '8px',
          fontSize: '13px', fontFamily: "'DM Sans', sans-serif",
          color: '#1C1C1E', resize: 'vertical', minHeight: '80px',
          outline: 'none', boxSizing: 'border-box', marginBottom: '10px',
        }}
      />

      <button
        onClick={saveNote}
        disabled={saving || !text.trim()}
        style={{
          width: '100%', padding: '11px',
          background: text.trim() ? '#1C1C1E' : '#DDD8CF',
          color: '#fff', border: 'none', borderRadius: '6px',
          fontSize: '13px', fontWeight: '500', cursor: text.trim() ? 'pointer' : 'default',
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        {saving ? 'A guardar…' : 'Guardar note'}
      </button>
    </div>
  )
}

const S = {
  sectionLabel: { fontSize: '11px', fontWeight: '500', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B6860', marginBottom: '10px' },
}

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const CATEGORIES = [
  { value: 'all',       label: 'All',       bg: '#F7F3EE', color: '#1C1C1E' },
  { value: 'urgent',    label: 'Urgent',    bg: '#FCEBEB', color: '#A32D2D' },
  { value: 'equipment', label: 'Equipment', bg: '#FEF3C7', color: '#633806' },
  { value: 'access',    label: 'Access',    bg: '#E6F1FB', color: '#0C447C' },
  { value: 'contact',   label: 'Contact',   bg: '#EAF3DE', color: '#3B6D11' },
]

const CAT_STYLE = {
  urgent:    { bg: '#FCEBEB', border: '#A32D2D', badgeBg: '#FCA5A5', badgeColor: '#7F1D1D' },
  equipment: { bg: '#FEF3C7', border: '#BA7517', badgeBg: '#FDE68A', badgeColor: '#633806' },
  access:    { bg: '#E6F1FB', border: '#185FA5', badgeBg: '#BFDBFE', badgeColor: '#1E3A5F' },
  contact:   { bg: '#EAF3DE', border: '#3B6D11', badgeBg: '#BBF7D0', badgeColor: '#14532D' },
  general:   { bg: '#F7F3EE', border: '#B8965A', badgeBg: '#DDD8CF', badgeColor: '#5F5E5A' },
}

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts)
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function Notes({ onNavigate }) {
  const [notes, setNotes]       = useState([])
  const [filter, setFilter]     = useState('all')
  const [search, setSearch]     = useState('')
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    fetchNotes()
    const channel = supabase.channel('notes-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_notes' }, fetchNotes)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function fetchNotes() {
    const { data } = await supabase
      .from('job_notes')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setNotes(data)
    setLoading(false)
  }

  async function deleteNote(id) {
    await supabase.from('job_notes').delete().eq('id', id)
    fetchNotes()
  }

  const filtered = notes.filter(n => {
    const matchCat    = filter === 'all' || n.category === filter
    const matchSearch = !search ||
      n.note_text?.toLowerCase().includes(search.toLowerCase()) ||
      n.crms_ref?.toLowerCase().includes(search.toLowerCase()) ||
      n.created_by_name?.toLowerCase().includes(search.toLowerCase())
    return matchCat && matchSearch
  })

  const urgentCount    = notes.filter(n => n.category === 'urgent').length
  const equipmentCount = notes.filter(n => n.category === 'equipment').length
  const accessCount    = notes.filter(n => n.category === 'access').length
  const contactCount   = notes.filter(n => n.category === 'contact').length

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading notes…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Stats */}
      <div style={S.statsGrid}>
        {[
          { label: 'Urgent',    value: urgentCount,    color: '#A32D2D', bg: '#FCEBEB' },
          { label: 'Equipment', value: equipmentCount, color: '#633806', bg: '#FEF3C7' },
          { label: 'Access',    value: accessCount,    color: '#0C447C', bg: '#E6F1FB' },
          { label: 'Contact',   value: contactCount,   color: '#3B6D11', bg: '#EAF3DE' },
        ].map(s => (
          <div key={s.label} style={{ ...S.statCard, background: s.bg }}>
            <div style={{ fontSize: '11px', color: s.color, fontWeight: '500', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            <div style={{ fontSize: '28px', fontWeight: '500', color: s.color, lineHeight: 1 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filter + Search */}
      <div style={S.filterBar}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search notes, job ref, author…"
          style={S.searchInput}
        />
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {CATEGORIES.map(c => (
            <button
              key={c.value}
              onClick={() => setFilter(c.value)}
              style={{
                fontSize: '12px', padding: '6px 14px', borderRadius: '20px',
                cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500',
                background: filter === c.value ? c.bg : 'transparent',
                color: filter === c.value ? c.color : '#6B6860',
                border: `1px solid ${filter === c.value ? c.color : '#DDD8CF'}`,
              }}
            >{c.label}{c.value !== 'all' ? ` (${notes.filter(n => n.category === c.value).length})` : ` (${notes.length})`}</button>
          ))}
        </div>
      </div>

      {/* Notes list */}
      {filtered.length === 0 ? (
        <div style={S.empty}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📋</div>
          <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '6px' }}>No notes found</div>
          <div style={{ fontSize: '13px', color: '#9CA3AF' }}>Notes added to jobs in the Schedule will appear here</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '12px' }}>
          {filtered.map(n => {
            const c = CAT_STYLE[n.category] || CAT_STYLE.general
            return (
              <div key={n.id} style={{
                background: c.bg,
                borderRadius: '8px',
                padding: '14px 16px',
                border: `1px solid ${c.border}`,
                borderLeft: `3px solid ${c.border}`,
              }}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '4px', background: c.badgeBg, color: c.badgeColor }}>
                      {n.category.toUpperCase()}
                    </span>
                    {n.crms_ref && (
                      <span
                        style={{ fontSize: '11px', color: c.border, fontWeight: '500', cursor: 'pointer', textDecoration: 'underline' }}
                        onClick={() => onNavigate && onNavigate('schedule')}
                      >{n.crms_ref}</span>
                    )}
                  </div>
                  <button
                    onClick={() => deleteNote(n.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: '#9CA3AF', padding: '2px 4px' }}
                  >✕</button>
                </div>

                {/* Note text */}
                <div style={{ fontSize: '13px', color: '#1C1C1E', lineHeight: '1.6', marginBottom: '10px' }}>
                  {n.note_text}
                </div>

                {/* Footer */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '11px', color: '#6B6860' }}>by {n.created_by_name}</span>
                  <span style={{ fontSize: '11px', color: '#9CA3AF' }}>{timeAgo(n.created_at)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const S = {
  statsGrid:   { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px', marginBottom: '20px' },
  statCard:    { borderRadius: '8px', padding: '16px' },
  filterBar:   { display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' },
  searchInput: { padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', width: '100%', boxSizing: 'border-box' },
  empty:       { textAlign: 'center', padding: '64px 24px', color: '#6B6860' },
}

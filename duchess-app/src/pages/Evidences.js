import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const RUN_TYPES = {
  after_del: { label: 'After DEL', bg: '#FCEBEB', color: '#A32D2D', border: '#FCA5A5' },
  pre_col:   { label: 'Pre-COL',   bg: '#FEF3C7', color: '#B8965A', border: '#DDD8CF' },
  after_col: { label: 'After COL', bg: '#EAF3DE', color: '#3B6D11', border: '#86EFAC' },
}

export default function Evidences() {
  const [photos, setPhotos]         = useState([])
  const [filter, setFilter]         = useState('all')
  const [driverFilter, setDriver]   = useState('all')
  const [dateFilter, setDate]       = useState('all')
  const [search, setSearch]         = useState('')
  const [lightbox, setLightbox]     = useState(null)
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    fetchPhotos()
    const channel = supabase.channel('evidence-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'evidence_photos' }, fetchPhotos)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  async function fetchPhotos() {
    const { data } = await supabase
      .from('evidence_photos')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setPhotos(data)
    setLoading(false)
  }

  async function deletePhoto(id, filePath) {
    if (filePath) await supabase.storage.from('evidence-photos').remove([filePath])
    await supabase.from('evidence_photos').delete().eq('id', id)
    setLightbox(null)
    fetchPhotos()
  }

  const today = new Date().toISOString().split('T')[0]
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString()

  const drivers = [...new Set(photos.map(p => p.uploaded_by_name).filter(Boolean))]

  const filtered = photos.filter(p => {
    const matchType   = filter === 'all' || p.run_type === filter
    const matchDriver = driverFilter === 'all' || p.uploaded_by_name === driverFilter
    const matchDate   = dateFilter === 'all' ? true
                      : dateFilter === 'today' ? p.created_at?.startsWith(today)
                      : dateFilter === 'week'  ? p.created_at >= weekAgo
                      : dateFilter === 'month' ? p.created_at >= monthAgo
                      : true
    const matchSearch = !search ||
      p.event_name?.toLowerCase().includes(search.toLowerCase()) ||
      p.crms_ref?.toLowerCase().includes(search.toLowerCase()) ||
      p.uploaded_by_name?.toLowerCase().includes(search.toLowerCase())
    return matchType && matchDriver && matchDate && matchSearch
  })

  // Group by job
  const grouped = {}
  for (const p of filtered) {
    const key = p.order_id
    if (!grouped[key]) grouped[key] = { event_name: p.event_name, crms_ref: p.crms_ref, photos: [] }
    grouped[key].photos.push(p)
  }

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading evidence…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total photos', value: photos.length, color: '#1C1C1E' },
          { label: 'After DEL', value: photos.filter(p => p.run_type === 'after_del').length, color: '#A32D2D' },
          { label: 'Pre-COL', value: photos.filter(p => p.run_type === 'pre_col').length, color: '#B8965A' },
          { label: 'After COL', value: photos.filter(p => p.run_type === 'after_col').length, color: '#3B6D11' },
        ].map(s => (
          <div key={s.label} style={{ background: '#F7F3EE', borderRadius: '8px', padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: s.color, fontWeight: '500', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            <div style={{ fontSize: '28px', fontWeight: '500', color: s.color, lineHeight: 1 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search event name, job ref, driver…"
          style={{ padding: '9px 14px', border: '1.5px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#6B6860', fontWeight: '500' }}>Type:</span>
          {[['all','All'], ['after_del','After DEL'], ['pre_col','Pre-COL'], ['after_col','After COL']].map(([val, lbl]) => (
            <button key={val} onClick={() => setFilter(val)} style={{
              fontSize: '12px', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer',
              fontFamily: "'DM Sans', sans-serif", fontWeight: '500',
              background: filter === val ? '#1C1C1E' : 'transparent',
              color: filter === val ? '#fff' : '#6B6860',
              border: `1px solid ${filter === val ? '#1C1C1E' : '#DDD8CF'}`,
            }}>{lbl}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#6B6860', fontWeight: '500' }}>Date:</span>
          {[['all','All time'], ['today','Today'], ['week','This week'], ['month','This month']].map(([val, lbl]) => (
            <button key={val} onClick={() => setDate(val)} style={{
              fontSize: '12px', padding: '5px 12px', borderRadius: '20px', cursor: 'pointer',
              fontFamily: "'DM Sans', sans-serif", fontWeight: '500',
              background: dateFilter === val ? '#1C1C1E' : 'transparent',
              color: dateFilter === val ? '#fff' : '#6B6860',
              border: `1px solid ${dateFilter === val ? '#1C1C1E' : '#DDD8CF'}`,
            }}>{lbl}</button>
          ))}
          <span style={{ fontSize: '11px', color: '#6B6860', fontWeight: '500', marginLeft: '8px' }}>Driver:</span>
          <select
            value={driverFilter}
            onChange={e => setDriver(e.target.value)}
            style={{ fontSize: '12px', padding: '5px 12px', borderRadius: '20px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
          >
            <option value="all">All drivers</option>
            {drivers.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>

      {/* Grouped photos */}
      {Object.keys(grouped).length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 24px', color: '#6B6860' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📷</div>
          <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '6px' }}>No evidence photos yet</div>
          <div style={{ fontSize: '13px', color: '#9CA3AF' }}>Upload photos from a job in the Schedule or Live Jobs</div>
        </div>
      ) : Object.entries(grouped).map(([jobId, group]) => (
        <div key={jobId} style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '14px', fontWeight: '500' }}>{group.event_name || 'Unknown event'}</div>
              {group.crms_ref && <div style={{ fontSize: '11px', color: '#6B6860' }}>{group.crms_ref}</div>}
            </div>
            <span style={{ fontSize: '12px', color: '#9CA3AF' }}>{group.photos.length} photo{group.photos.length !== 1 ? 's' : ''}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '10px' }}>
            {group.photos.map(p => {
              const rt = RUN_TYPES[p.run_type] || RUN_TYPES.after_del
              return (
                <div key={p.id} style={{ borderRadius: '8px', overflow: 'hidden', border: `1.5px solid ${rt.border}`, background: rt.bg, cursor: 'pointer' }}
                  onClick={() => setLightbox(p)}>
                  <img src={p.photo_url} alt="Evidence" style={{ width: '100%', height: '120px', objectFit: 'cover', display: 'block' }} />
                  <div style={{ padding: '8px 10px' }}>
                    <div style={{ fontSize: '10px', fontWeight: '600', color: rt.color, marginBottom: '2px' }}>{rt.label}</div>
                    <div style={{ fontSize: '10px', color: '#6B6860' }}>{p.uploaded_by_name}</div>
                    <div style={{ fontSize: '10px', color: '#9CA3AF' }}>{new Date(p.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Lightbox */}
      {lightbox && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={() => setLightbox(null)}>
          <div style={{ background: '#fff', borderRadius: '10px', maxWidth: '600px', width: '100%', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}>
            <img src={lightbox.photo_url} alt="Evidence" style={{ width: '100%', maxHeight: '65vh', objectFit: 'contain', display: 'block' }} />
            <div style={{ padding: '16px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '2px' }}>{lightbox.event_name || 'Evidence photo'}</div>
                <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '2px' }}>{RUN_TYPES[lightbox.run_type]?.label} · by {lightbox.uploaded_by_name}</div>
                <div style={{ fontSize: '11px', color: '#9CA3AF' }}>{new Date(lightbox.created_at).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <button onClick={() => deletePhoto(lightbox.id, lightbox.file_path)}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px', border: '1px solid #EF4444', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
                  Delete
                </button>
                <button onClick={() => setLightbox(null)}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px', border: '1px solid #DDD8CF', background: '#F7F3EE', color: '#1C1C1E', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

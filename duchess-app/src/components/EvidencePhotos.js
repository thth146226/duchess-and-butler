import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

export default function EvidencePhotos({ orderId, orderName }) {
  const { profile } = useAuth()
  const [photos, setPhotos] = useState([])
  const [uploading, setUploading] = useState(false)
  const [selectedType, setSelectedType] = useState('DEL')
  const [notes, setNotes] = useState('')
  const [lightbox, setLightbox] = useState(null)
  const fileRef = useRef()

  useEffect(() => {
    if (orderId) fetchPhotos()
  }, [orderId])

  async function fetchPhotos() {
    const { data } = await supabase
      .from('evidence_photos')
      .select('*, users(name)')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
    if (data) setPhotos(data)
  }

  async function handleUpload(e) {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setUploading(true)

    for (const file of files) {
      const ext = file.name.split('.').pop()
      const fileName = `${orderId}/${selectedType}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('evidence-photos')
        .upload(fileName, file, { contentType: file.type })

      if (uploadError) { console.error(uploadError); continue }

      const { data: { publicUrl } } = supabase.storage
        .from('evidence-photos')
        .getPublicUrl(fileName)

      await supabase.from('evidence_photos').insert({
        order_id: orderId,
        user_id: profile?.id,
        run_type: selectedType,
        photo_url: publicUrl,
        notes: notes || null
      })

      // Log activity
      await supabase.from('activity_log').insert({
        user_id: profile?.id,
        action: `${selectedType === 'DEL' ? 'Delivery' : 'Collection'} photo uploaded for ${orderName}`,
        entity_type: 'order',
        entity_id: orderId
      })
    }

    setUploading(false)
    setNotes('')
    fetchPhotos()
  }

  const delPhotos = photos.filter(p => p.run_type === 'DEL')
  const colPhotos = photos.filter(p => p.run_type === 'COL')

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Upload Section */}
      <div style={styles.uploadBox}>
        <div style={styles.sectionLabel}>📸 Add Evidence Photos</div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          {['DEL', 'COL'].map(type => (
            <button
              key={type}
              style={{
                ...styles.typeBtn,
                background: selectedType === type
                  ? (type === 'DEL' ? '#EF4444' : '#22C55E')
                  : '#F7F3EE',
                color: selectedType === type ? 'white' : '#6B6860',
                border: `2px solid ${selectedType === type ? (type === 'DEL' ? '#EF4444' : '#22C55E') : '#DDD8CF'}`
              }}
              onClick={() => setSelectedType(type)}
            >
              {type === 'DEL' ? '🚚 Delivery' : '📦 Collection'}
            </button>
          ))}
        </div>

        <input
          placeholder="Notes (optional) — e.g. All items in good condition"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          style={{ ...styles.input, marginBottom: '12px' }}
        />

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleUpload}
        />

        <button
          style={{
            ...styles.uploadBtn,
            background: selectedType === 'DEL' ? '#EF4444' : '#22C55E',
            opacity: uploading ? 0.7 : 1
          }}
          onClick={() => fileRef.current.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading…' : `📷 Upload ${selectedType === 'DEL' ? 'Delivery' : 'Collection'} Photos`}
        </button>

        <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '8px' }}>
          Photos will be marked with your name and timestamp automatically
        </div>
      </div>

      {/* DEL Photos */}
      {delPhotos.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={styles.runHeader('DEL')}>
            <span style={styles.badge('DEL')}>DEL</span>
            Delivery Evidence — {delPhotos.length} photo{delPhotos.length !== 1 ? 's' : ''}
          </div>
          <div style={styles.photoGrid}>
            {delPhotos.map(photo => (
              <PhotoCard key={photo.id} photo={photo} onClick={() => setLightbox(photo)} />
            ))}
          </div>
        </div>
      )}

      {/* COL Photos */}
      {colPhotos.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={styles.runHeader('COL')}>
            <span style={styles.badge('COL')}>COL</span>
            Collection Evidence — {colPhotos.length} photo{colPhotos.length !== 1 ? 's' : ''}
          </div>
          <div style={styles.photoGrid}>
            {colPhotos.map(photo => (
              <PhotoCard key={photo.id} photo={photo} onClick={() => setLightbox(photo)} />
            ))}
          </div>
        </div>
      )}

      {photos.length === 0 && (
        <div style={styles.empty}>No evidence photos yet — upload the first one above</div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div style={styles.overlay} onClick={() => setLightbox(null)}>
          <div style={styles.lightboxCard} onClick={e => e.stopPropagation()}>
            <img src={lightbox.photo_url} alt="Evidence" style={{ width: '100%', borderRadius: '8px', maxHeight: '70vh', objectFit: 'contain' }} />
            <div style={{ padding: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <span style={styles.badge(lightbox.run_type)}>{lightbox.run_type}</span>
                <span style={{ fontWeight: '600', fontSize: '14px' }}>
                  {lightbox.run_type === 'DEL' ? 'Delivered' : 'Collected'} by {lightbox.users?.name || 'Team member'}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#6B6860' }}>
                {new Date(lightbox.created_at).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}
              </div>
              {lightbox.notes && <div style={{ fontSize: '13px', marginTop: '8px', fontStyle: 'italic', color: '#1C1C1E' }}>{lightbox.notes}</div>}
            </div>
            <button style={styles.closeBtn} onClick={() => setLightbox(null)}>✕ Close</button>
          </div>
        </div>
      )}
    </div>
  )
}

function PhotoCard({ photo, onClick }) {
  const colors = photo.run_type === 'DEL'
    ? { border: '#EF4444', bg: '#FEF2F2' }
    : { border: '#22C55E', bg: '#F0FDF4' }

  return (
    <div style={{ ...styles.photoCard, border: `2px solid ${colors.border}`, background: colors.bg }} onClick={onClick}>
      <img src={photo.photo_url} alt="Evidence" style={{ width: '100%', height: '120px', objectFit: 'cover', borderRadius: '4px', marginBottom: '8px' }} />
      <div style={{ fontSize: '11px', fontWeight: '600', color: '#1C1C1E', marginBottom: '2px' }}>
        {photo.run_type === 'DEL' ? '🚚 Delivered' : '📦 Collected'} by {photo.users?.name || 'Team'}
      </div>
      <div style={{ fontSize: '10px', color: '#6B6860' }}>
        {new Date(photo.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </div>
      {photo.notes && <div style={{ fontSize: '10px', color: '#6B6860', marginTop: '4px', fontStyle: 'italic' }}>{photo.notes}</div>}
    </div>
  )
}

const styles = {
  uploadBox: { background: '#F7F3EE', border: '1.5px dashed #DDD8CF', borderRadius: '8px', padding: '20px', marginBottom: '20px' },
  sectionLabel: { fontSize: '12px', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#B8965A', marginBottom: '12px' },
  typeBtn: { padding: '8px 16px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontWeight: '600', fontFamily: "'DM Sans', sans-serif", transition: 'all 0.15s' },
  input: { width: '100%', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '4px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box', background: '#fff' },
  uploadBtn: { color: 'white', border: 'none', borderRadius: '4px', padding: '12px 24px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", width: '100%' },
  runHeader: (type) => ({ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: '600', marginBottom: '10px', color: type === 'DEL' ? '#991B1B' : '#166534' }),
  badge: (type) => ({ background: type === 'DEL' ? '#EF4444' : '#22C55E', color: 'white', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '3px' }),
  photoGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' },
  photoCard: { borderRadius: '6px', padding: '10px', cursor: 'pointer', transition: 'transform 0.15s', },
  empty: { textAlign: 'center', color: '#9CA3AF', fontSize: '13px', padding: '24px' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
  lightboxCard: { background: '#fff', borderRadius: '8px', maxWidth: '600px', width: '100%', overflow: 'hidden' },
  closeBtn: { width: '100%', padding: '12px', background: '#F7F3EE', border: 'none', borderTop: '1px solid #DDD8CF', cursor: 'pointer', fontSize: '13px', fontFamily: "'DM Sans', sans-serif', color: '#1C1C1E'" }
}

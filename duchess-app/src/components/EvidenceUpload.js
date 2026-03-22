import { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const RUN_TYPES = [
  { value: 'after_del', label: 'After DEL', bg: '#FCEBEB', color: '#A32D2D', border: '#FCA5A5' },
  { value: 'pre_col',   label: 'Pre-COL',   bg: '#FEF3C7', color: '#B8965A', border: '#DDD8CF' },
  { value: 'after_col', label: 'After COL', bg: '#EAF3DE', color: '#3B6D11', border: '#86EFAC' },
]

export default function EvidenceUpload({ jobId, jobTable = 'crms_jobs', crmsRef, eventName }) {
  const { profile } = useAuth()
  const [photos, setPhotos]       = useState([])
  const [runType, setRunType]     = useState('after_del')
  const [uploading, setUploading] = useState(false)
  const [lightbox, setLightbox]   = useState(null)
  const fileRef = useRef()
  const galleryRef = useRef()

  useEffect(() => { if (jobId) fetchPhotos() }, [jobId])

  async function fetchPhotos() {
    const { data } = await supabase
      .from('evidence_photos')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
    if (data) setPhotos(data)
  }

  async function handleUpload(e) {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setUploading(true)
    for (const file of files) {
      const ext = file.name.split('.').pop()
      const fileName = `${jobId}/${runType}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('evidence-photos')
        .upload(fileName, file, { contentType: file.type })

      if (uploadError) {
        console.error('Storage upload error:', uploadError)
        alert('Upload error: ' + uploadError.message)
        continue
      }

      console.log('Upload success:', uploadData)

      const { data: { publicUrl } } = supabase.storage
        .from('evidence-photos')
        .getPublicUrl(fileName)

      console.log('Public URL:', publicUrl)

      const { error: dbError } = await supabase.from('evidence_photos').insert({
        job_id:           jobId,
        job_table:        jobTable,
        crms_ref:         crmsRef || null,
        event_name:       eventName || null,
        run_type:         runType,
        photo_url:        publicUrl,
        file_path:        fileName,
        uploaded_by:      profile?.id || null,
        uploaded_by_name: profile?.name || 'Team',
        driver_name:      profile?.name || null,
      })

      if (dbError) {
        console.error('Database insert error:', dbError)
        alert('Database error: ' + dbError.message)
      }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
    if (galleryRef.current) galleryRef.current.value = ''
    fetchPhotos()
  }

  async function deletePhoto(id, filePath) {
    if (filePath) await supabase.storage.from('evidence-photos').remove([filePath])
    await supabase.from('evidence_photos').delete().eq('id', id)
    fetchPhotos()
  }

  const grouped = RUN_TYPES.map(rt => ({
    ...rt,
    photos: photos.filter(p => p.run_type === rt.value),
  })).filter(g => g.photos.length > 0)

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Upload zone */}
      <div style={{ border: '1.5px dashed #DDD8CF', borderRadius: '8px', padding: '20px', background: '#F7F3EE', marginBottom: '16px', textAlign: 'center' }}>
        <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '4px' }}>Upload evidence photos</div>
        <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '14px' }}>Select type, then choose photos from camera or gallery</div>

        {/* Type selector */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginBottom: '14px', flexWrap: 'wrap' }}>
          {RUN_TYPES.map(rt => (
            <button
              key={rt.value}
              onClick={() => setRunType(rt.value)}
              style={{
                fontSize: '12px', fontWeight: '600', padding: '7px 18px',
                borderRadius: '20px', cursor: 'pointer',
                fontFamily: "'DM Sans', sans-serif",
                background: runType === rt.value ? rt.bg : 'transparent',
                color: runType === rt.value ? rt.color : '#6B6860',
                border: `1.5px solid ${runType === rt.value ? rt.border : '#DDD8CF'}`,
              }}
            >{rt.label}</button>
          ))}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          capture="environment"
          style={{ display: 'none' }}
          onChange={handleUpload}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleUpload}
        />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => fileRef.current.click()}
            disabled={uploading}
            style={{
              fontSize: '13px', fontWeight: '500', padding: '10px 20px',
              borderRadius: '6px', border: 'none',
              background: uploading ? '#DDD8CF' : '#1C1C1E',
              color: '#fff', cursor: uploading ? 'default' : 'pointer',
              fontFamily: "'DM Sans', sans-serif",
            }}
          >{uploading ? 'Uploading…' : '📷 Take photo'}</button>

          <button
            onClick={() => galleryRef.current.click()}
            disabled={uploading}
            style={{
              fontSize: '13px', fontWeight: '500', padding: '10px 20px',
              borderRadius: '6px', border: '1.5px solid #DDD8CF',
              background: 'transparent',
              color: '#1C1C1E', cursor: uploading ? 'default' : 'pointer',
              fontFamily: "'DM Sans', sans-serif",
            }}
          >🖼 Choose from gallery</button>
        </div>
      </div>

      {/* Uploaded photos grouped by type */}
      {grouped.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '24px', color: '#9CA3AF', fontSize: '13px' }}>
          No evidence photos yet
        </div>
      ) : grouped.map(g => (
        <div key={g.value} style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', color: g.color, marginBottom: '8px' }}>
            {g.label} — {g.photos.length} photo{g.photos.length !== 1 ? 's' : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' }}>
            {g.photos.map(p => (
              <div key={p.id} style={{ borderRadius: '6px', overflow: 'hidden', border: `1.5px solid ${g.border}`, background: g.bg, cursor: 'pointer' }}
                onClick={() => setLightbox(p)}>
                <img src={p.photo_url} alt="Evidence" style={{ width: '100%', height: '100px', objectFit: 'cover', display: 'block' }} />
                <div style={{ padding: '6px 8px' }}>
                  <div style={{ fontSize: '10px', fontWeight: '600', color: g.color }}>{g.label}</div>
                  <div style={{ fontSize: '10px', color: '#6B6860' }}>{p.uploaded_by_name}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Lightbox */}
      {lightbox && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={() => setLightbox(null)}>
          <div style={{ background: '#fff', borderRadius: '10px', maxWidth: '560px', width: '100%', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}>
            <img src={lightbox.photo_url} alt="Evidence" style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', display: 'block' }} />
            <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: '500' }}>{RUN_TYPES.find(r => r.value === lightbox.run_type)?.label}</div>
                <div style={{ fontSize: '11px', color: '#6B6860' }}>by {lightbox.uploaded_by_name} · {new Date(lightbox.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => { deletePhoto(lightbox.id, lightbox.file_path); setLightbox(null) }}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px', border: '1px solid #EF4444', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
                >Delete</button>
                <button
                  onClick={() => setLightbox(null)}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px', border: '1px solid #DDD8CF', background: '#F7F3EE', color: '#1C1C1E', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
                >Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

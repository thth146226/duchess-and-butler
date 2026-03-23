import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Paperwork() {
  const [jobs, setJobs]     = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchJobs() }, [])

  async function fetchJobs() {
    const { data } = await supabase
      .from('crms_jobs')
      .select('*, crms_job_items(*)')
      .not('status', 'eq', 'cancelled')
      .order('delivery_date', { ascending: true, nullsLast: true })
    if (data) setJobs(data)
    setLoading(false)
  }

  async function fetchNotes(jobId) {
    const { data } = await supabase
      .from('job_notes')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
    return data || []
  }

  function fmtDate(d, t) {
    if (!d) return '—'
    const date = new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    return t ? `${date}, ${t}` : date
  }

  function groupItems(items) {
    const CATEGORY_MAP = {
      'crockery': 'DINNERWARE',
      'glassware': 'GLASSWARE',
      'cutlery': 'CUTLERY',
      'linens': 'LINENS',
      'furniture': 'FURNITURE',
      'other': 'OTHER',
    }
    const groups = {}
    for (const item of (items || [])) {
      // Skip items with quantity 0 — these are category headers from Current RMS
      if (!item.quantity || parseInt(item.quantity) === 0) continue
      const rawCat = (item.category || 'other').toLowerCase()
      const cat = CATEGORY_MAP[rawCat] || rawCat.toUpperCase()
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(item)
    }
    return groups
  }

  async function getLogoBase64() {
    try {
      const response = await fetch(
        'https://duchessandbutler.com/wp-content/uploads/2025/02/duchess-butler-logo.png'
      )
      const blob = await response.blob()
      return new Promise((resolve) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result)
        reader.readAsDataURL(blob)
      })
    } catch {
      return null
    }
  }

  async function printDocument(job, type) {
    // Open window IMMEDIATELY on click (before any async work)
    // This is required for mobile browsers to allow popup
    const win = window.open('', '_blank')
    if (!win) {
      alert('Please allow popups for this site to open documents.')
      return
    }
    win.document.write('<html><body><p style="font-family:sans-serif;padding:40px;color:#666">Loading document…</p></body></html>')

    const logoBase64 = await getLogoBase64()
    const logoHTML = logoBase64
      ? `<img src="${logoBase64}" alt="Duchess & Butler" style="height:80px" />`
      : `<div style="font-family:Georgia,serif;font-size:22px;font-weight:600;letter-spacing:0.04em;color:#1a1a1a">
        Duchess & Butler
        <div style="font-size:10px;letter-spacing:0.2em;color:#B8965A;font-weight:400;margin-top:4px">LUXURY TABLESCAPES & EVENT DECOR</div>
       </div>`

    const notes = await fetchNotes(job.id)
    const groups = groupItems(job.crms_job_items)
    const isDelivery = type === 'DEL'
    const typeLabel = isDelivery ? 'DELIVERY NOTE' : 'COLLECTION NOTE'
    const cleanTime = (t) => t ? String(t).substring(0, 5) : null
    const deliveryTimeStr = cleanTime(job.delivery_time)
    const collectionTimeStr = cleanTime(job.collection_time)
    const dateValue = isDelivery
      ? fmtDate(job.delivery_date, deliveryTimeStr ? `${deliveryTimeStr} - 17:00` : null)
      : fmtDate(job.collection_date, collectionTimeStr ? `${collectionTimeStr} - 17:00` : null)

    const specialNotes = notes.map(n => n.note_text).join(' | ')
    const drivers = [job.assigned_driver_name, job.assigned_driver_name_2].filter(Boolean).join(' + ')

    const itemsHTML = Object.entries(groups).map(([cat, items]) => `
      <tr><td colspan="3" style="background:#f5ede0;color:#8B6914;font-size:11px;font-weight:700;letter-spacing:0.1em;padding:8px 12px;border-bottom:1px solid #ddd">${cat}</td></tr>
      ${items.map(i => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0ebe3;font-size:12px">${i.item_name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0ebe3;font-size:12px;color:#666">Rental</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0ebe3;font-size:12px;text-align:right">${i.quantity}</td>
        </tr>
      `).join('')}
    `).join('')

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${typeLabel}: ${job.event_name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #222; font-size: 13px; }
    .page { max-width: 800px; margin: 0 auto; padding: 40px; }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo img { height: 80px; }
    .title { text-align: center; font-size: 16px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; margin-bottom: 24px; color: #1a1a1a; border-top: 2px solid #8B6914; border-bottom: 2px solid #8B6914; padding: 12px 0; }
    .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; border: 1px solid #ddd; }
    .info-table td { padding: 8px 12px; vertical-align: top; font-size: 12px; border: 1px solid #ddd; }
    .info-table .label { font-weight: 700; white-space: nowrap; }
    .info-table .header { background: #f5f0eb; font-weight: 700; font-size: 12px; }
    .items-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    .items-table th { background: #8B6914; color: white; padding: 8px 12px; text-align: left; font-size: 12px; font-weight: 600; letter-spacing: 0.05em; }
    .items-table th:last-child { text-align: right; }
    .box-count { margin: 20px 0; }
    .box-count-title { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; color: #8B6914; text-transform: uppercase; margin-bottom: 8px; }
    .box-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border: 1px solid #ddd; }
    .box-cell { border: 1px solid #ddd; padding: 6px 10px; font-size: 11px; min-height: 32px; }
    .confirm-text { font-style: italic; font-size: 11px; text-align: center; margin: 16px 0; color: #444; line-height: 1.6; }
    .sig-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    .sig-table td { border: 1px solid #ddd; padding: 10px 12px; font-size: 12px; width: 50%; min-height: 36px; }
    .footer { border-top: 1px solid #ddd; padding-top: 12px; text-align: center; font-size: 10px; color: #666; line-height: 1.6; margin-top: 20px; }
    .note-box { background: #fffbf0; border-left: 3px solid #8B6914; padding: 8px 12px; margin: 12px 0; font-size: 12px; color: #5a4000; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .page { padding: 20px; }
    }
  </style>
</head>
<body>
<div class="page">
  <div class="logo">
    ${logoHTML}
  </div>

  <div class="title">${typeLabel}: ${job.event_name?.toUpperCase()}</div>

  <table class="info-table">
    <tr>
      <td style="width:50%;vertical-align:top">
        <table style="width:100%;border:none">
          <tr><td class="label" style="border:none;padding:4px 0;width:140px">Order Date:</td><td style="border:none;padding:4px 0">${job.ordered_at ? fmtDate(job.ordered_at.split('T')[0]) : fmtDate(job.event_date)}</td></tr>
          <tr><td class="label" style="border:none;padding:4px 0">Our Reference:</td><td style="border:none;padding:4px 0">${job.crms_ref || '—'}</td></tr>
          <tr><td class="label" style="border:none;padding:4px 0">Delivery Date:</td><td style="border:none;padding:4px 0">${fmtDate(job.delivery_date, deliveryTimeStr ? `${deliveryTimeStr} - 17:00` : null)}</td></tr>
          <tr><td class="label" style="border:none;padding:4px 0">Collection Date:</td><td style="border:none;padding:4px 0">${fmtDate(job.collection_date, collectionTimeStr ? `${collectionTimeStr} - 17:00` : null)}</td></tr>
          <tr><td class="label" style="border:none;padding:4px 0">Event Date:</td><td style="border:none;padding:4px 0">${fmtDate(job.event_date)}</td></tr>
          ${drivers ? `<tr><td class="label" style="border:none;padding:4px 0">Driver:</td><td style="border:none;padding:4px 0">${drivers}</td></tr>` : ''}
        </table>
      </td>
      <td style="width:25%;vertical-align:top">
        <div class="header" style="padding:4px 0;margin-bottom:6px">Delivery Address</div>
        <div style="font-size:12px;line-height:1.8">
    ${job.venue ? `<strong>${job.venue}</strong><br>` : ''}
    ${(job.venue_address || '').replace(/,\s*/g, '<br>')}
    ${!job.venue && !job.venue_address ? '—' : ''}
  </div>
      </td>
      <td style="width:25%;vertical-align:top">
        <div class="header" style="padding:4px 0;margin-bottom:6px">Client Address</div>
        <div style="font-size:12px;line-height:1.6">${job.client_name || '—'}</div>
      </td>
    </tr>
  </table>

  ${specialNotes ? `<div class="note-box"><strong>Special Instructions:</strong> ${specialNotes}</div>` : ''}

  <table class="items-table">
    <thead>
      <tr>
        <th>Item</th>
        <th>Type</th>
        <th style="text-align:right">Quantity</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHTML || '<tr><td colspan="3" style="padding:12px;text-align:center;color:#999;font-size:12px">No items synced for this job</td></tr>'}
    </tbody>
  </table>

  <div class="box-count">
    <div class="box-count-title">Box Count</div>
    <div class="box-grid">
      <div class="box-cell">Charger Plate Box</div>
      <div class="box-cell">Lattice Crates</div>
      <div class="box-cell">Grey Cutlery Trays</div>
      <div class="box-cell">Grey Plate Box</div>
      <div class="box-cell">Clear Boxes</div>
      <div class="box-cell">Clear Dinner Plate Box + Lid</div>
      <div class="box-cell">Other</div>
      <div class="box-cell"></div>
      <div class="box-cell">Pink Linen Bag</div>
      <div class="box-cell">Inner Tubes for Clear Dinner Plate Boxes</div>
      <div class="box-cell">Black Napkin Box</div>
      <div class="box-cell"></div>
    </div>
  </div>

  <p class="confirm-text">We want your event to be perfect. Any differences or issues must be advised immediately so that we can put it right before the start of your event. Sign below to confirm the items listed have been ${isDelivery ? 'delivered' : 'collected'} to your satisfaction.</p>

  <table class="sig-table">
    <tr>
      <td>Signed:</td>
      <td>Printed:</td>
    </tr>
    <tr>
      <td>Date:</td>
      <td>Position:</td>
    </tr>
  </table>

  <div class="footer">
    Duchess & Butler Ltd | Unit 7 Oakengrove Yard | Gaddesden Home Farm | Red Lion Lane | Hemel Hempstead | Herts | HP2 6EZ
    T: 01442 262772 | www.duchessandbutler.com | email: hello@duchessandbutler.com | VAT No. 237 973 173 | Company Reg 09575189
    <br>Page 1
  </div>
</div>
<script>window.onload = function(){ window.print(); }</script>
</body>
</html>`

    win.document.open()
    win.document.write(html)
    win.document.close()
  }

  async function printRunSheet(date) {
    // Open window IMMEDIATELY on click
    const win = window.open('', '_blank')
    if (!win) {
      alert('Please allow popups for this site to open documents.')
      return
    }
    win.document.write('<html><body><p style="font-family:sans-serif;padding:40px;color:#666">Loading run sheet…</p></body></html>')

    const logoBase64 = await getLogoBase64()
    const logoHTML = logoBase64
      ? `<img src="${logoBase64}" alt="Duchess & Butler" style="height:60px" />`
      : `<div style="font-family:Georgia,serif;font-size:22px;font-weight:600;letter-spacing:0.04em;color:#1a1a1a">
        Duchess & Butler
        <div style="font-size:10px;letter-spacing:0.2em;color:#B8965A;font-weight:400;margin-top:4px">LUXURY TABLESCAPES & EVENT DECOR</div>
       </div>`

    const dayJobs = jobs.filter(j => j.delivery_date === date || j.collection_date === date)
    const runs = []
    for (const j of dayJobs) {
      if (j.delivery_date === date) runs.push({ job: j, type: 'DEL', time: j.delivery_time?.substring(0, 5) || null })
      if (j.collection_date === date) runs.push({ job: j, type: 'COL', time: j.collection_time?.substring(0, 5) || null })
    }
    runs.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))

    const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

    const runsHTML = runs.map(r => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0ebe3;vertical-align:top">
          <span style="background:${r.type === 'DEL' ? '#FCEBEB' : '#EAF3DE'};color:${r.type === 'DEL' ? '#A32D2D' : '#3B6D11'};font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px">${r.type}</span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0ebe3;vertical-align:top">
          <div style="font-weight:600;font-size:13px">${r.job.event_name}</div>
          <div style="font-size:11px;color:#666;margin-top:2px">${r.job.crms_ref} · ${r.job.venue || '—'}</div>
          <div style="font-size:11px;color:#666">${r.job.venue_address || ''}</div>
          ${r.job.crms_job_items?.length ? `<div style="font-size:11px;color:#444;margin-top:4px">${r.job.crms_job_items.slice(0,3).map(i => `${i.quantity}x ${i.item_name}`).join(' · ')}${r.job.crms_job_items.length > 3 ? ' · …' : ''}</div>` : ''}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0ebe3;vertical-align:top;white-space:nowrap">
          <div style="font-size:13px;font-weight:600">${r.time || '—'}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0ebe3;vertical-align:top">
          <div style="font-size:12px">${[r.job.assigned_driver_name, r.job.assigned_driver_name_2].filter(Boolean).join(' + ') || '<span style="color:#92400E">Unassigned</span>'}</div>
        </td>
      </tr>
    `).join('')

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Run Sheet — ${dateFormatted}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #222; }
    .page { max-width: 800px; margin: 0 auto; padding: 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; border-bottom: 2px solid #8B6914; padding-bottom: 16px; }
    .logo img { height: 60px; }
    .title { font-size: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .sub { font-size: 13px; color: #666; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #8B6914; color: white; padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
    .footer { border-top: 1px solid #ddd; padding-top: 12px; text-align: center; font-size: 10px; color: #666; margin-top: 24px; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      ${logoHTML}
    </div>
    <div style="text-align:right">
      <div class="title">Run Sheet</div>
      <div class="sub">${dateFormatted}</div>
      <div class="sub">${runs.length} run${runs.length !== 1 ? 's' : ''}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:60px">Type</th>
        <th>Event / Venue</th>
        <th style="width:80px">Time</th>
        <th style="width:140px">Driver</th>
      </tr>
    </thead>
    <tbody>
      ${runsHTML || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#999">No runs scheduled for this date</td></tr>'}
    </tbody>
  </table>

  <div class="footer">
    Duchess & Butler Ltd | Unit 7 Oakengrove Yard | Gaddesden Home Farm | Red Lion Lane | Hemel Hempstead | Herts | HP2 6EZ
    T: 01442 262772 | www.duchessandbutler.com
  </div>
</div>
<script>window.onload = function(){ window.print(); }</script>
</body>
</html>`

    win.document.open()
    win.document.write(html)
    win.document.close()
  }

  const filtered = jobs.filter(j =>
    !search || [j.event_name, j.client_name, j.crms_ref, j.venue]
      .some(f => f?.toLowerCase().includes(search.toLowerCase()))
  )

  const today = new Date().toISOString().split('T')[0]

  if (loading) return (
    <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
      Loading paperwork…
    </div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Today's run sheet shortcut */}
      <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <div style={{ fontSize: '13px', fontWeight: '500' }}>Today's run sheet</div>
          <div style={{ fontSize: '12px', color: '#6B6860' }}>
            {jobs.filter(j => j.delivery_date === today || j.collection_date === today).length} runs scheduled today
          </div>
        </div>
        <button
          onClick={() => printRunSheet(today)}
          style={{ background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 18px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
        >Print today's run sheet</button>
      </div>

      {/* Search */}
      <div style={{ marginBottom: '16px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search event, client, reference…"
          style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', boxSizing: 'border-box' }}
        />
      </div>

      {/* Jobs list */}
      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px 120px', gap: '0', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', padding: '10px 16px' }}>
          {['Event / Client', 'DEL Note', 'COL Note', 'Run Sheet'].map(h => (
            <div key={h} style={{ fontSize: '11px', fontWeight: '500', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#6B6860' }}>{h}</div>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9CA3AF', fontSize: '13px' }}>No jobs found</div>
        ) : filtered.map(job => (
          <div key={job.id} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px 120px', gap: '0', padding: '12px 16px', borderBottom: '0.5px solid #EDE8E0', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: '500', marginBottom: '2px' }}>{job.event_name}</div>
              <div style={{ fontSize: '11px', color: '#6B6860' }}>
                {job.crms_ref} · DEL {job.delivery_date || '—'} · COL {job.collection_date || '—'}
              </div>
              {(job.assigned_driver_name || job.assigned_driver_name_2) && (
                <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
                  {[job.assigned_driver_name, job.assigned_driver_name_2].filter(Boolean).join(' + ')}
                </div>
              )}
            </div>
            <div>
              {job.delivery_date ? (
                <button
                  onClick={() => printDocument(job, 'DEL')}
                  style={{ fontSize: '11px', fontWeight: '500', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: '#FCEBEB', color: '#A32D2D', border: '1px solid #FCA5A5' }}
                >DEL Note</button>
              ) : <span style={{ fontSize: '11px', color: '#DDD8CF' }}>—</span>}
            </div>
            <div>
              {job.collection_date ? (
                <button
                  onClick={() => printDocument(job, 'COL')}
                  style={{ fontSize: '11px', fontWeight: '500', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: '#EAF3DE', color: '#3B6D11', border: '1px solid #86EFAC' }}
                >COL Note</button>
              ) : <span style={{ fontSize: '11px', color: '#DDD8CF' }}>—</span>}
            </div>
            <div>
              <button
                onClick={() => {
                  const date = job.delivery_date || job.collection_date
                  if (date) printRunSheet(date)
                }}
                style={{ fontSize: '11px', fontWeight: '500', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: '#1C1C1E', color: '#fff', border: 'none' }}
              >Run Sheet</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

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

  function fmtRmsDate(d, t) {
    if (!d) return '—'
    const date = new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
    return t ? `${date}, ${t}` : date
  }

  function formatAddress(value) {
    if (!value) return ''
    return String(value)
      .split(/\r?\n|,\s*/g)
      .map(line => line.trim())
      .filter(Boolean)
      .join('<br>')
  }

  function cleanTime(t) {
    return t ? String(t).substring(0, 5) : null
  }

  function timeRange(t) {
    return t ? `${cleanTime(t)} - 18:00` : null
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function getDisplayCategory(item) {
    const rawCat = (item?.category || '').toLowerCase()
    const name = (item?.item_name || '').toLowerCase()

    if (rawCat.includes('charger')) return 'CHARGER PLATES'
    if (rawCat.includes('dinner') || rawCat.includes('crockery') || rawCat.includes('plate')) return 'DINNERWARE'
    if (rawCat.includes('cutlery')) return 'CUTLERY - TABLESCAPE'
    if (rawCat.includes('glass')) return 'GLASSWARE'
    if (rawCat.includes('linen')) return 'LINENS'
    if (rawCat.includes('furniture')) return 'FURNITURE'
    if (rawCat.includes('platter') || rawCat.includes('service')) return 'PLATTERS & SERVICEWARE'

    if (name.includes('charger')) return 'CHARGER PLATES'
    if (name.includes('knife') || name.includes('fork') || name.includes('spoon') || name.includes('teaspoon')) return 'CUTLERY - TABLESCAPE'
    if (name.includes('serving') || name.includes('dessert fork') || name.includes('dessert spoon')) return 'CUTLERY - SERVING AND DESSERT'
    if (name.includes('dinner plate') || name.includes('dessert plate') || name.includes('side plate') || name.includes('starter') || name.includes('bowl')) return 'DINNERWARE'
    if (name.includes('flute') || name.includes('goblet') || name.includes('glass') || name.includes('tumbler') || name.includes('coupe')) return 'GLASSWARE'
    if (name.includes('platter') || name.includes('jug') || name.includes('serviceware')) return 'PLATTERS & SERVICEWARE'
    if (name.includes('linen') || name.includes('napkin') || name.includes('tablecloth')) return 'LINENS'
    if (name.includes('chair') || name.includes('sofa') || name.includes('table')) return 'FURNITURE'
    return 'OTHER'
  }

  function getPackingNote(item) {
    const candidates = [
      item?.packing_note,
      item?.packing,
      item?.bundle_note,
      item?.bundle_size ? `Bundles of ${item.bundle_size}` : null,
      item?.pieces_per_unit ? `${item.pieces_per_unit} per bundle` : null,
      item?.capacity ? `${item.capacity} per crate` : null,
      item?.description,
      item?.notes,
    ]
    return candidates.find(v => v && String(v).trim()) || null
  }

  function groupItems(items) {
    const orderedCategories = [
      'CHARGER PLATES',
      'DINNERWARE',
      'CUTLERY - TABLESCAPE',
      'CUTLERY - SERVING AND DESSERT',
      'GLASSWARE',
      'PLATTERS & SERVICEWARE',
      'LINENS',
      'FURNITURE',
      'OTHER',
    ]
    const grouped = new Map(orderedCategories.map(cat => [cat, []]))
    for (const item of (items || [])) {
      if (!item?.quantity || parseInt(item.quantity, 10) === 0) continue
      const cat = getDisplayCategory(item)
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat).push(item)
    }
    return orderedCategories
      .map(cat => ({ category: cat, items: grouped.get(cat) || [] }))
      .filter(group => group.items.length > 0)
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
    const deliveryTimeStr = cleanTime(job.delivery_time)
    const collectionTimeStr = cleanTime(job.collection_time)

    const specialNotes = notes.map(n => n.note_text).join(' | ')
    const drivers = [job.assigned_driver_name, job.assigned_driver_name_2].filter(Boolean).join(' + ')

    const itemsHTML = groups.map(group => `
      <tr class="category-row"><td colspan="3">${escapeHtml(group.category)}</td></tr>
      ${group.category === 'CHARGER PLATES' ? `<tr><td colspan="3" class="category-note">We don't apply wash fees to our Charger Plates.</td></tr>` : ''}
      ${group.items.map(i => `
        <tr>
          <td class="item-cell">
            <div class="item-name">${escapeHtml(i.item_name)}</div>
            ${getPackingNote(i) ? `<div class="item-pack">${escapeHtml(getPackingNote(i))}</div>` : ''}
          </td>
          <td class="type-cell">Rental</td>
          <td class="qty-cell">${escapeHtml(i.quantity)}</td>
        </tr>
      `).join('')}
    `).join('')

    const orderDate = job.ordered_at ? String(job.ordered_at).split('T')[0] : job.event_date
    const titleText = `${typeLabel}: ${String(job.event_name || '').toUpperCase()}`
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(titleText)}</title>
  <style>
    /* RMS-style delivery note template. Visual source of truth is the official RMS delivery note. */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4 portrait; margin: 12mm; }
    body { background: #fff; color: #1C1C1E; font-family: 'Times New Roman', Georgia, serif; }
    .page { width: 100%; max-width: 186mm; margin: 0 auto; }
    .brand { text-align: center; margin-bottom: 12px; }
    .brand img { height: 70px; object-fit: contain; }
    .brand-text { font-size: 30px; letter-spacing: 0.02em; line-height: 1; }
    .brand-sub { font-size: 11px; letter-spacing: 0.2em; margin-top: 6px; color: #B8965A; font-family: 'DM Sans', Arial, sans-serif; text-transform: uppercase; }
    .details-wrap { display: grid; grid-template-columns: 1.1fr 1fr 1fr; gap: 12px; border: 1px solid #B9B1A4; padding: 10px; margin-bottom: 12px; page-break-inside: avoid; }
    .meta-table { width: 100%; border-collapse: collapse; font-family: 'DM Sans', Arial, sans-serif; }
    .meta-table td { font-size: 11px; padding: 2px 0; vertical-align: top; }
    .meta-label { width: 105px; color: #6B6860; font-weight: 600; }
    .address-head { font-family: 'DM Sans', Arial, sans-serif; font-size: 10px; letter-spacing: 0.08em; color: #6B6860; font-weight: 700; text-transform: uppercase; margin-bottom: 6px; }
    .address-body { font-size: 11px; line-height: 1.45; min-height: 74px; }
    .doc-title { text-align: center; font-family: 'DM Sans', Arial, sans-serif; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin: 8px 0 10px; }
    .special-notes { border: 1px solid #D7CEBF; background: #FCFAF7; padding: 6px 9px; margin-bottom: 10px; font-size: 10px; line-height: 1.4; font-family: 'DM Sans', Arial, sans-serif; }
    table.items-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; page-break-inside: auto; }
    .items-table thead { display: table-header-group; }
    .items-table th { background: #BBAA8A; color: #fff; border: 1px solid #A59373; padding: 6px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-family: 'DM Sans', Arial, sans-serif; text-align: left; }
    .items-table th.qty-head { text-align: center; width: 72px; }
    .items-table th.type-head { width: 80px; text-align: center; }
    .items-table tr { page-break-inside: avoid; }
    .category-row td { border: 1px solid #D8CFBF; background: #F7F2E9; color: #8D6E3B; padding: 5px 8px; font-size: 10px; font-weight: 700; font-family: 'DM Sans', Arial, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; }
    .category-note { border-left: 1px solid #D8CFBF; border-right: 1px solid #D8CFBF; border-bottom: 1px solid #D8CFBF; font-size: 10px; color: #6B6860; font-style: italic; padding: 4px 8px; }
    .item-cell, .type-cell, .qty-cell { border: 1px solid #E5DED0; padding: 6px 8px; vertical-align: top; font-size: 11px; }
    .item-name { font-size: 11px; }
    .item-pack { margin-top: 3px; font-size: 10px; color: #6B6860; font-style: italic; font-family: 'DM Sans', Arial, sans-serif; }
    .type-cell { text-align: center; font-family: 'DM Sans', Arial, sans-serif; color: #5F5E5A; font-size: 10px; }
    .qty-cell { text-align: center; font-family: 'DM Sans', Arial, sans-serif; font-size: 11px; font-weight: 700; }
    .box-wrap { margin: 10px 0 12px; page-break-inside: avoid; }
    .box-title { font-size: 10px; font-family: 'DM Sans', Arial, sans-serif; color: #6B6860; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; margin-bottom: 5px; }
    .box-table { width: 100%; border-collapse: collapse; }
    .box-table td { border: 1px solid #CFC6B8; padding: 6px 8px; font-size: 10px; height: 24px; }
    .box-name { width: 72%; font-family: 'DM Sans', Arial, sans-serif; }
    .box-count-cell { width: 28%; }
    .confirm-text { font-size: 10px; line-height: 1.45; margin: 8px 0 8px; font-family: 'DM Sans', Arial, sans-serif; page-break-inside: avoid; }
    .sig-table { width: 100%; border-collapse: collapse; page-break-inside: avoid; }
    .sig-table td { border: 1px solid #CFC6B8; padding: 8px 9px; font-size: 10px; height: 28px; font-family: 'DM Sans', Arial, sans-serif; }
    .doc-footer { margin-top: 10px; padding-top: 7px; border-top: 1px solid #D9D0C2; font-size: 9px; line-height: 1.35; text-align: center; color: #6B6860; font-family: 'DM Sans', Arial, sans-serif; }
    .page-mark { margin-top: 4px; font-size: 9px; color: #6B6860; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
<div class="page">
  <div class="brand">
    ${logoBase64
      ? logoHTML
      : `<div class="brand-text">Duchess & Butler</div><div class="brand-sub">Luxury Tablescapes & Event Decor</div>`}
  </div>

  <div class="details-wrap">
    <table class="meta-table">
      <tr><td class="meta-label">Order Date</td><td>${escapeHtml(fmtRmsDate(orderDate))}</td></tr>
      <tr><td class="meta-label">Our Reference</td><td>${escapeHtml(job.crms_ref || '—')}</td></tr>
      <tr><td class="meta-label">Delivery Date</td><td>${escapeHtml(fmtRmsDate(job.delivery_date, timeRange(job.delivery_time)))}</td></tr>
      <tr><td class="meta-label">Event Date</td><td>${escapeHtml(fmtRmsDate(job.event_date))}</td></tr>
      <tr><td class="meta-label">Collection Date</td><td>${escapeHtml(fmtRmsDate(job.collection_date, timeRange(job.collection_time)))}</td></tr>
      ${drivers ? `<tr><td class="meta-label">Driver</td><td>${escapeHtml(drivers)}</td></tr>` : ''}
    </table>
    <div>
      <div class="address-head">Delivery Address</div>
      <div class="address-body">
        ${job.venue ? `<strong>${escapeHtml(job.venue)}</strong><br>` : ''}
        ${formatAddress(job.venue_address) || '—'}
      </div>
    </div>
    <div>
      <div class="address-head">Client Address</div>
      <div class="address-body">
        ${formatAddress(job.client_address) || escapeHtml(job.client_name || '—')}
      </div>
    </div>
  </div>

  <div class="doc-title">${escapeHtml(titleText)}</div>

  ${specialNotes ? `<div class="special-notes"><strong>Special Instructions:</strong> ${escapeHtml(specialNotes)}</div>` : ''}

  <table class="items-table">
    <thead>
      <tr>
        <th>Item</th>
        <th class="type-head">Type</th>
        <th class="qty-head">Quantity</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHTML || '<tr><td colspan="3" style="padding:12px;text-align:center;color:#999;font-size:11px">No items synced for this job</td></tr>'}
    </tbody>
  </table>

  <div class="box-wrap">
    <div class="box-title">Box Count</div>
    <table class="box-table">
      <tr><td class="box-name">Charger Plate Box</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Lattice Crates</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Grey Cutlery Trays</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Grey Plate Box</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Clear Boxes</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Clear Dinner Plate Box + Lid</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Other</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Pink Linen Bag</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Inner Tubes for Clear Dinner Plate Boxes</td><td class="box-count-cell"></td></tr>
      <tr><td class="box-name">Black Napkin Box</td><td class="box-count-cell"></td></tr>
    </table>
  </div>

  <p class="confirm-text">We want your event to be perfect. Any differences or issues must be advised immediately so that we can put it right before the start of your event. Sign below to confirm the items listed have been delivered to your satisfaction.</p>

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

  <div class="doc-footer">
    Duchess & Butler Ltd | Unit 7 Oakengrove Yard | Gaddesden Home Farm | Red Lion Lane | Hemel Hempstead | Herts | HP2 6EZ
    T: 01442 262772 | www.duchessandbutler.com | email: hello@duchessandbutler.com | VAT No. 237 973 173 | Company Reg 09575189
    <div class="page-mark">Page 1 of 1</div>
  </div>
</div>
<script>
  document.title = ${JSON.stringify(titleText)};
  window.onload = function(){ window.print(); }
</script>
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

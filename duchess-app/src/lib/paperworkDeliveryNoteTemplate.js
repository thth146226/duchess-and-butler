const PAPERWORK_LOGO_URL = '/paperwork/duchess-butler-paperwork-logo.jpg'
const EMPTY_VALUE = '-'
const PAPERWORK_TIMEZONE = 'Europe/London'

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function cleanTime(value) {
  return value ? String(value).substring(0, 5) : null
}

function timeRange(value) {
  return value ? `${cleanTime(value)} - 18:00` : null
}

function formatDate(dateValue, timeValue, weekday = 'long') {
  if (!dateValue) return EMPTY_VALUE

  const baseDate = String(dateValue).split('T')[0]
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(baseDate)
    ? new Date(`${baseDate}T12:00:00Z`)
    : new Date(dateValue)

  if (Number.isNaN(normalized.getTime())) return EMPTY_VALUE

  const formattedDate = normalized.toLocaleDateString('en-GB', {
    weekday,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: PAPERWORK_TIMEZONE,
  })

  return timeValue ? `${formattedDate}, ${timeValue}` : formattedDate
}

function formatRmsDate(dateValue, timeValue) {
  return formatDate(dateValue, timeValue, 'short')
}

function formatAddressHtml(value) {
  if (!value) return ''

  return String(value)
    .split(/\r?\n|,\s*/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => escapeHtml(line))
    .join('<br>')
}

function getDisplayCategory(item) {
  const rawCategory = (item?.category || '').toLowerCase()
  const itemName = (item?.item_name || '').toLowerCase()

  if (rawCategory.includes('charger')) return 'CHARGER PLATES'
  if (rawCategory.includes('dinner') || rawCategory.includes('crockery') || rawCategory.includes('plate')) return 'DINNERWARE'
  if (rawCategory.includes('cutlery')) return 'CUTLERY - TABLESCAPE'
  if (rawCategory.includes('glass')) return 'GLASSWARE'
  if (rawCategory.includes('linen')) return 'LINENS'
  if (rawCategory.includes('furniture')) return 'FURNITURE'
  if (rawCategory.includes('platter') || rawCategory.includes('service')) return 'PLATTERS & SERVICEWARE'

  if (itemName.includes('charger')) return 'CHARGER PLATES'
  if (itemName.includes('tea spoon') || itemName.includes('teaspoon') || itemName.includes('starter fork') || itemName.includes('dessert fork') || itemName.includes('dessert spoon') || itemName.includes('serving')) return 'CUTLERY - SERVING AND DESSERT'
  if (itemName.includes('knife') || itemName.includes('fork') || itemName.includes('spoon')) return 'CUTLERY - TABLESCAPE'
  if (itemName.includes('dinner plate') || itemName.includes('dessert plate') || itemName.includes('side plate') || itemName.includes('starter') || itemName.includes('bowl')) return 'DINNERWARE'
  if (
    itemName.includes('flute')
    || itemName.includes('goblet')
    || itemName.includes('glass')
    || itemName.includes('tumbler')
    || itemName.includes('coupe')
    || itemName.includes('red wine')
    || itemName.includes('white wine')
    || itemName.includes('wine glass')
    || itemName.includes('grand vin')
    || itemName.includes('water/ grand vin')
    || itemName.includes('champagne flute')
  ) return 'GLASSWARE'
  if (itemName.includes('platter') || itemName.includes('jug') || itemName.includes('serviceware')) return 'PLATTERS & SERVICEWARE'
  if (itemName.includes('linen') || itemName.includes('napkin') || itemName.includes('tablecloth')) return 'LINENS'
  if (itemName.includes('chair') || itemName.includes('sofa') || itemName.includes('table')) return 'FURNITURE'
  return 'OTHER'
}

function getPackingNote(item) {
  // Packing notes are source-backed only; do not invent packing text in the print template.
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

  return candidates.find((value) => value && String(value).trim()) || null
}

function normalizeItemKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function resolvePackingFromLookup(item, packingLookup) {
  if (!packingLookup) return null
  const key = normalizeItemKey(item?.item_name)
  if (!key) return null
  return packingLookup[key] || null
}

function buildPackingTextFromSource(source) {
  if (!source) return null
  if (source.bundle_note) return source.bundle_note
  // Keep ATA-derived display conservative to avoid misleading paperwork notes.
  // Numeric-only fields (pieces_per_unit/unit_name) are suppressed unless a
  // human-readable bundle/crate note is explicitly available from source data.
  if (source.notes) return source.notes
  return null
}

function getItemType(item) {
  const typeValue = String(item?.item_type || item?.type_name || '').trim()
  if (!typeValue) return 'Rental'
  return typeValue
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ')
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

  const grouped = new Map(orderedCategories.map((category) => [category, []]))

  for (const item of items || []) {
    if (!item?.quantity || parseInt(item.quantity, 10) === 0) continue

    const category = getDisplayCategory(item)
    if (!grouped.has(category)) grouped.set(category, [])
    grouped.get(category).push(item)
  }

  return orderedCategories
    .map((category) => ({ category, items: grouped.get(category) || [] }))
    .filter((group) => group.items.length > 0)
}

function getTypeLabel(type) {
  return type === 'COL' ? 'COLLECTION NOTE' : 'DELIVERY NOTE'
}

function getDocumentTitle(job, type) {
  return `${getTypeLabel(type)}: ${String(job?.event_name || '').toUpperCase()}`
}

function sanitizeFilenamePart(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned || fallback
}

function buildDeliveryNoteFilename(job, type = 'DEL') {
  const reference = sanitizeFilenamePart(job?.crms_ref, 'delivery-note')
  const eventName = sanitizeFilenamePart(job?.event_name, 'event')
  const suffix = type === 'COL' ? 'collection_note' : 'delivery_note'
  return `${reference}_${eventName}_${suffix}.pdf`
}

function buildLogoMarkup(logoSrc) {
  if (logoSrc) {
    return `
      <img
        src="${escapeHtml(logoSrc)}"
        alt="Duchess & Butler"
        style="height:74px;max-width:110px;object-fit:contain;display:block;margin:0 auto"
        onerror="this.style.display='none';this.nextElementSibling.style.display='block';"
      />
      <div class="brand-fallback" style="display:none;">
        <div class="brand-text">Duchess & Butler</div>
        <div class="brand-sub">Luxury Tablescapes & Event Decor</div>
      </div>
    `
  }

  return `
    <div class="brand-text">Duchess & Butler</div>
    <div class="brand-sub">Luxury Tablescapes & Event Decor</div>
  `
}

function buildDeliveryNoteHtml({
  job,
  notes = [],
  type = 'DEL',
  logoSrc = null,
  packingLookup = null,
  showBodyBrand = true,
  autoPrint = false,
}) {
  const groups = groupItems(job?.crms_job_items)
  const drivers = [job?.assigned_driver_name, job?.assigned_driver_name_2].filter(Boolean).join(' + ')
  const specialNotes = (notes || [])
    .map((note) => note?.note_text)
    .filter((noteText) => noteText && String(noteText).trim())
    .join(' | ')
  const orderDate = job?.ordered_at ? String(job.ordered_at).split('T')[0] : job?.event_date
  const titleText = getDocumentTitle(job, type)
  const signatureRows = [
    ['Signed', 'Printed'],
    ['Date', 'Position'],
  ]

  const itemsHtml = groups.map((group) => `
      <tr class="category-row"><td colspan="3">${escapeHtml(group.category)}</td></tr>
      ${group.category === 'CHARGER PLATES' ? '<tr><td colspan="3" class="category-note">We don\'t apply wash fees to our Charger Plates.</td></tr>' : ''}
      ${group.items.map((item, index) => `
        <tr class="item-row ${index === 0 ? 'group-first-item' : ''}">
          <td class="item-cell">
            <div class="item-name">${escapeHtml(item.item_name)}</div>
            ${(() => {
              const sourcePacking = getPackingNote(item)
              if (sourcePacking) return `<div class="item-pack">${escapeHtml(sourcePacking)}</div>`
              const lookupPacking = buildPackingTextFromSource(resolvePackingFromLookup(item, packingLookup))
              return lookupPacking ? `<div class="item-pack">${escapeHtml(lookupPacking)}</div>` : ''
            })()}
          </td>
          <td class="type-cell">${escapeHtml(getItemType(item))}</td>
          <td class="qty-cell">${escapeHtml(item.quantity)}</td>
        </tr>
      `).join('')}
    `).join('')

  const signatureHtml = signatureRows.map((row) => `
      <tr>
        ${row.map((label) => `
          <td>
            <div class="sig-label">${escapeHtml(label)}</div>
            <div class="sig-line"></div>
          </td>
        `).join('')}
      </tr>
    `).join('')

  const footerScript = autoPrint
    ? `
<script>
  document.title = ${JSON.stringify(titleText)};
  window.onload = function () { window.print(); };
</script>`
    : ''

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(titleText)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4 portrait; margin: 23mm 17mm 20mm; }
    html, body { background: #fff; color: #1C1C1E; font-family: "Times New Roman", Georgia, Garamond, serif; font-size: 10pt; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { width: 100%; max-width: 176mm; margin: 0 auto; }
    .brand { text-align: center; margin-bottom: 14px; ${showBodyBrand ? '' : 'display:none;'} }
    .brand img { display: inline-block; }
    .brand-text { font-size: 25px; letter-spacing: 0.018em; line-height: 1; color: #2C2A27; }
    .brand-sub { font-size: 8.5px; letter-spacing: 0.16em; margin-top: 4px; color: #A28756; font-family: Arial, Helvetica, sans-serif; text-transform: uppercase; }
    .details-wrap { display: grid; grid-template-columns: 1.12fr 1fr 1fr; gap: 12px; border-top: 1px solid #CFC6B8; border-bottom: 1px solid #CFC6B8; padding: 10px 2px; margin-bottom: 14px; page-break-inside: avoid; }
    .meta-table { width: 100%; border-collapse: collapse; font-family: Arial, Helvetica, sans-serif; }
    .meta-table td { font-size: 10px; padding: 1.5px 0; vertical-align: top; line-height: 1.35; }
    .meta-label { width: 100px; color: #6B6860; font-weight: 600; }
    .address-head { font-family: Arial, Helvetica, sans-serif; font-size: 9px; letter-spacing: 0.08em; color: #8D6E3B; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
    .address-body { font-size: 10px; line-height: 1.38; min-height: 68px; }
    .doc-title { text-align: center; font-size: 14pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; margin: 10px 0 12px; color: #2A2825; }
    .special-notes { border: 1px solid #D7CEBF; background: #FCFAF7; padding: 6px 9px; margin-bottom: 10px; font-size: 10px; line-height: 1.4; font-family: Arial, Helvetica, sans-serif; }
    .items-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; page-break-inside: auto; }
    .items-table thead { display: table-header-group; }
    .items-table th { background: #B7A07A; color: #fff; border: 0; padding: 7px 8px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; font-family: Arial, Helvetica, sans-serif; text-align: left; }
    .items-table th.qty-head { text-align: center; width: 72px; }
    .items-table th.type-head { width: 90px; text-align: center; }
    .items-table tr { page-break-inside: avoid; break-inside: avoid; }
    .category-row td { border-bottom: 1px solid #DCCFB6; color: #8D6E3B; padding: 10px 0 4px; font-size: 13px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; page-break-after: avoid; break-after: avoid; }
    .category-note { border-bottom: 1px solid #EFE6D6; font-size: 9.5px; color: #6B6860; font-style: italic; padding: 2px 0 6px; page-break-after: avoid; break-after: avoid; }
    .item-row.group-first-item { page-break-before: avoid; break-before: avoid; }
    .item-cell, .type-cell, .qty-cell { border: 0; border-bottom: 1px solid #EEE7DA; padding: 7px 0; vertical-align: top; font-size: 10.5px; }
    .item-name { font-size: 11px; }
    .item-pack { margin-top: 2px; font-size: 9.5px; color: #6B6860; font-style: italic; }
    .type-cell { text-align: center; font-family: Arial, Helvetica, sans-serif; color: #5F5E5A; font-size: 10px; }
    .qty-cell { text-align: center; font-family: Arial, Helvetica, sans-serif; font-size: 11px; font-weight: 700; }
    .box-wrap { margin: 11px 0 12px; page-break-inside: avoid; }
    .box-title { font-size: 9.5px; font-family: Arial, Helvetica, sans-serif; color: #8D6E3B; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; margin-bottom: 5px; }
    .box-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .box-table td { border: 1px solid #BFAA83; padding: 6px 7px; font-size: 8.8px; height: 28px; vertical-align: top; }
    .box-label { width: 19%; font-family: Arial, Helvetica, sans-serif; color: #403B34; line-height: 1.26; }
    .box-count-cell { width: 6%; background: #FCFAF7; }
    .confirm-text { font-size: 9.4px; line-height: 1.44; margin: 8px 0 8px; font-style: italic; text-align: center; page-break-inside: avoid; color: #4F4A42; }
    .sig-table { width: 100%; border-collapse: collapse; page-break-inside: avoid; }
    .sig-table td { border: 1px solid #BFAA83; padding: 6px 10px 7px; font-size: 9px; height: 34px; font-family: Arial, Helvetica, sans-serif; vertical-align: top; }
    .sig-label { font-size: 8.2px; letter-spacing: 0.06em; text-transform: uppercase; color: #766C5B; }
    .sig-line { border-bottom: 1px solid #BFAA83; height: 11px; margin-top: 5px; }
    .doc-footer { margin-top: 11px; padding-top: 6px; border-top: 1px solid #D9D0C2; font-size: 7.7pt; line-height: 1.38; text-align: center; color: #6B6860; font-family: Arial, Helvetica, sans-serif; }
    .placeholder { color: #999; }
    @media print {
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="brand">
      ${buildLogoMarkup(logoSrc)}
    </div>

    <div class="details-wrap">
      <table class="meta-table">
        <tr><td class="meta-label">Order Date</td><td>${escapeHtml(formatRmsDate(orderDate))}</td></tr>
        <tr><td class="meta-label">Our Reference</td><td>${escapeHtml(job?.crms_ref || EMPTY_VALUE)}</td></tr>
        <tr><td class="meta-label">Delivery Date</td><td>${escapeHtml(formatRmsDate(job?.delivery_date, timeRange(job?.delivery_time)))}</td></tr>
        <tr><td class="meta-label">Event Date</td><td>${escapeHtml(formatRmsDate(job?.event_date))}</td></tr>
        <tr><td class="meta-label">Collection Date</td><td>${escapeHtml(formatRmsDate(job?.collection_date, timeRange(job?.collection_time)))}</td></tr>
        ${drivers ? `<tr><td class="meta-label">Driver</td><td>${escapeHtml(drivers)}</td></tr>` : ''}
      </table>
      <div>
        <div class="address-head">Delivery Address</div>
        <div class="address-body">
          ${job?.venue ? `<strong>${escapeHtml(job.venue)}</strong><br>` : ''}
          ${formatAddressHtml(job?.venue_address) || EMPTY_VALUE}
        </div>
      </div>
      <div>
        <div class="address-head">Client Address</div>
        <div class="address-body">
          ${formatAddressHtml(job?.client_address) || escapeHtml(job?.client_name || EMPTY_VALUE)}
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
        ${itemsHtml || '<tr><td colspan="3" class="placeholder" style="padding:12px;text-align:center;font-size:11px">No items synced for this job</td></tr>'}
      </tbody>
    </table>

    <div class="box-wrap">
      <div class="box-title">Box Count</div>
      <table class="box-table">
        <tr>
          <td class="box-label">Charger Plate Box</td><td class="box-count-cell"></td>
          <td class="box-label">Lattice Crates</td><td class="box-count-cell"></td>
          <td class="box-label">Grey Cutlery Trays</td><td class="box-count-cell"></td>
          <td class="box-label">Grey Plate Box</td><td class="box-count-cell"></td>
        </tr>
        <tr>
          <td class="box-label">Clear Boxes</td><td class="box-count-cell"></td>
          <td class="box-label">Clear Dinner Plate Box + Lid</td><td class="box-count-cell"></td>
          <td class="box-label">Other</td><td class="box-count-cell"></td>
          <td class="box-label"></td><td class="box-count-cell"></td>
        </tr>
        <tr>
          <td class="box-label">Pink Linen Bag</td><td class="box-count-cell"></td>
          <td class="box-label">Inner Tubes for Clear Dinner Plate Boxes</td><td class="box-count-cell"></td>
          <td class="box-label">Black Napkin Box</td><td class="box-count-cell"></td>
          <td class="box-label"></td><td class="box-count-cell"></td>
        </tr>
      </table>
    </div>

    <p class="confirm-text">We want your event to be perfect. Any differences or issues must be advised immediately so that we can put it right before the start of your event. Sign below to confirm the items listed have been delivered to your satisfaction.</p>

    <table class="sig-table">
      ${signatureHtml}
    </table>

    <div class="doc-footer">
      Duchess & Butler Ltd | Unit 7 Oakengrove Yard | Gaddesden Home Farm | Red Lion Lane | Hemel Hempstead | Herts | HP2 6EZ
      T: 01442 262772 | www.duchessandbutler.com | email: hello@duchessandbutler.com | VAT No. 237 973 173 | Company Reg 09575189
    </div>
  </div>
  ${footerScript}
</body>
</html>`
}

module.exports = {
  PAPERWORK_LOGO_URL,
  buildDeliveryNoteFilename,
  buildDeliveryNoteHtml,
  cleanTime,
  formatAddressHtml,
  formatDate,
  formatRmsDate,
  getDocumentTitle,
  getPackingNote,
  getTypeLabel,
  groupItems,
  timeRange,
}

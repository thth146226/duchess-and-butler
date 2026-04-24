export const LABEL_ORDER_COLOURS = {
  black: { key: 'black', label: 'Black', color: '#1C1C1E' },
  blue: { key: 'blue', label: 'Blue', color: '#1D4ED8' },
  green: { key: 'green', label: 'Green', color: '#15803D' },
  red: { key: 'red', label: 'Red', color: '#B91C1C' },
  orange: { key: 'orange', label: 'Orange', color: '#C2410C' },
  purple: { key: 'purple', label: 'Purple', color: '#6B21A8' },
  pink: { key: 'pink', label: 'Pink', color: '#BE185D' },
}

const NON_LABEL_EXACT_BLOCKLIST = new Set([
  'delivery & collection',
  'dinnerware',
  'fine napkins',
  'glassware',
  'tailored tablecloths',
  'delivery and collection',
  'delivery/collection',
  'service',
  'services',
  'collection',
  'delivery',
])

const LINEN_CATEGORY_MARKERS = new Set([
  'linen',
  'linens',
  'fine napkins',
  'classic napkins',
  'duchess drape tablecloths',
  'tailored tablecloths',
  'place mats',
  'placemats',
  'tablecloths',
  'napkins',
])

const LINEN_NAME_MARKERS = [
  'napkin',
  'napkins',
  'tablecloth',
  'tablecloths',
  'placemat',
  'place mat',
  'placemats',
  'place mats',
  'drape tablecloth',
  'tailored tablecloth',
  'linen',
]

export function normalizeItemName(name) {
  if (!name) return ''
  return String(name)
    .normalize('NFKC')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function normalizeAliasKey(normalizedName) {
  if (!normalizedName) return ''
  return normalizeItemName(normalizedName)
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

// Phase 3E: first controlled RMS-first reconciliation round.
// Keys are normalized legacy/divergent names; values are canonical RMS names.
const RAW_CURATED_RMS_CANONICAL_NAME_MAP = {
  ' audrey gold flute ': ' Audrey Gold Rimmed Champagne Flute ',
  ' audrey gold g.vin ': ' Audrey Gold Rimmed Water/ Grand Vin Glass ',
  ' audrey gold red wine ': ' Audrey Gold Rimmed Red Wine ',
  ' audrey gold white ': ' Audrey Gold Rimmed White Wine Glass ',
  ' baroque side plate ( 50 ) ': ' Baroque Side Plate ',
  ' diva green dessert plate ': ' Diva Dessert Plate 21cm - Green ',
  ' diva green dinner plate ': ' Diva Starter / Dinner Plate 26cm - Green ',
  ' etoile white dessert plate ': ' Etoile White & Gold Dessert Plate ',
  ' etoile white dinner plate ': ' Etoile White & Gold Dinner Plate ',
  ' etoile white side plate ': ' Etoile White & Gold Side Plate ',
  ' hydrangea leaf bread plate - small ': ' Hydrangea Leaf Bread Plate Small ',
  ' nude flute ': ' Nude Champagne Flute ',
  ' nude red wine ': ' Nude Red Wine Glass ',
  ' nude white wine ': ' Nude White Wine Glass ',
  ' scalloped tea cup ( 5 ) ': ' Scalloped Tea Cup ',
  ' scalloped tea saucer ( 20 ) ': ' Scalloped Tea Saucer ',
  ' tortoiseshell butter knife ( 60 ) ': ' Tortoiseshell Butter Knife ',
  ' tortoiseshell dessert spoon ( 35 ) ': ' Tortoiseshell Dessert Spoon ',
  ' tortoiseshell dinner fork ( 40 ) ': ' Tortoiseshell Dinner Fork ',
  ' tortoiseshell dinner knife ( 35 ) ': ' Tortoiseshell Dinner Knife ',
  ' tulip green ': ' Tulip Water Glass - Green ',
  ' tulip pink ': ' Tulip Water Glass - Dusty Rose ',
  ' valentina peony charger plate ': ' Valentina Peony ',
  ' valentina sage green gold charger plate ': ' Valentina Sage Green and Gold Charger Plate ',
  ' valentina sage green gold charger plate ( 5 ) ': ' Valentina Sage Green and Gold Charger Plate ',
}

const CURATED_RMS_CANONICAL_NAME_MAP = Object.entries(RAW_CURATED_RMS_CANONICAL_NAME_MAP).reduce((acc, [legacyName, canonicalName]) => {
  const normalizedLegacy = normalizeAliasKey(normalizeItemName(legacyName))
  if (normalizedLegacy) acc[normalizedLegacy] = String(canonicalName || '').trim()
  return acc
}, {})

function toDisplayCategory(category) {
  const raw = normalizeItemName(category)
  if (!raw) return 'OTHER'
  return raw.toUpperCase()
}

export function extractPackagingFromUnitName(unitName) {
  if (!unitName) return ''
  const normalized = normalizeItemName(unitName)
  const slash = normalized.split('/').map(s => s.trim()).filter(Boolean)
  if (slash.length >= 2) return slash[slash.length - 1]
  const tokens = normalized.split(' ').filter(Boolean)
  return tokens[tokens.length - 1] || ''
}

export function buildAtaCapacityMap(ataItems) {
  const map = new Map()

  for (const item of ataItems || []) {
    if (!item?.active) continue
    if (!item?.name) continue

    const normalizedName = normalizeItemName(item.name)
    if (!normalizedName) continue

    const capacity = Number.parseInt(item.pieces_per_unit, 10)
    if (!Number.isFinite(capacity) || capacity <= 0) continue

    const next = {
      name: item.name,
      normalizedName,
      category: item.category || null,
      capacity,
      packaging: extractPackagingFromUnitName(item.unit_name),
      unitName: item.unit_name || '',
    }

    const existing = map.get(normalizedName)
    if (!existing || next.capacity > existing.capacity) {
      map.set(normalizedName, next)
    }
  }

  return map
}

export function isNonLabelJobItem(itemName, quantity) {
  const qty = Number.parseInt(quantity, 10)
  if (!Number.isFinite(qty) || qty <= 0) return true

  const normalized = normalizeItemName(itemName)
  if (!normalized) return true
  return NON_LABEL_EXACT_BLOCKLIST.has(normalized)
}

export function isDbLinenStudioItem(jobItem) {
  // Phase 3G: conservative first round. If uncertain, do not exclude.
  const category = normalizeItemName(jobItem?.category)
  if (category && LINEN_CATEGORY_MARKERS.has(category)) return true

  const itemName = normalizeItemName(jobItem?.item_name)
  if (!itemName) return false
  return LINEN_NAME_MARKERS.some(marker => itemName.includes(marker))
}

export function resolveJobItemRule(jobItem, ataCapacityMap) {
  const normalizedName = normalizeItemName(jobItem?.item_name)
  if (!normalizedName) {
    return { matched: false, rule: null, reason: 'No ATA rule found', matchedBy: null, canonicalNameUsed: null }
  }

  // Layer 1: exact normalized match.
  const exactRule = ataCapacityMap.get(normalizedName)
  if (exactRule) {
    return { matched: true, rule: exactRule, reason: null, matchedBy: 'exact', canonicalNameUsed: null }
  }

  // Layer 2: safe alias normalization match.
  const aliasKey = normalizeAliasKey(normalizedName)
  for (const [ataName, ataRule] of ataCapacityMap.entries()) {
    if (normalizeAliasKey(ataName) === aliasKey) {
      return { matched: true, rule: ataRule, reason: null, matchedBy: 'safe-alias', canonicalNameUsed: null }
    }
  }

  // Layer 3: curated RMS-first canonical reconciliation.
  const canonicalName = CURATED_RMS_CANONICAL_NAME_MAP[aliasKey]
  if (canonicalName) {
    const normalizedCanonical = normalizeItemName(canonicalName)
    const curatedRule = ataCapacityMap.get(normalizedCanonical)
    if (curatedRule) {
      return {
        matched: true,
        rule: curatedRule,
        reason: null,
        matchedBy: 'curated-rms-canonical',
        canonicalNameUsed: canonicalName,
      }
    }
  }

  return { matched: false, rule: null, reason: 'No ATA rule found', matchedBy: null, canonicalNameUsed: null }
}

export function generateLabelsForQuantity(totalQty, capacity) {
  const qty = Number.parseInt(totalQty, 10)
  const cap = Number.parseInt(capacity, 10)
  if (!Number.isFinite(qty) || qty <= 0) return []
  if (!Number.isFinite(cap) || cap <= 0) return []

  const labels = []
  const full = Math.floor(qty / cap)
  const remainder = qty % cap

  for (let i = 0; i < full; i++) labels.push(cap)
  if (remainder > 0) labels.push(remainder)
  return labels
}

export function generateLabelsForItem(jobItem, resolvedRule) {
  const totalQty = Number.parseInt(jobItem?.quantity, 10)
  const itemKey = jobItem?.itemKey || ''
  const productName = jobItem?.item_name || 'Unnamed item'
  const ataCategory = resolvedRule?.rule?.category
  const jobCategory = jobItem?.category
  const category = toDisplayCategory(ataCategory || jobCategory || 'other')

  if (!resolvedRule?.matched || !resolvedRule.rule) {
    return {
      itemKey,
      productName,
      totalQty: Number.isFinite(totalQty) ? totalQty : 0,
      category,
      packagingType: '',
      capacity: 0,
      autoLabels: [],
      confidence: 'low',
      flags: [{ level: 'error', message: 'No ATA rule found' }],
      matchedBy: resolvedRule?.matchedBy || null,
    }
  }

  const capacity = Number.parseInt(resolvedRule.rule.capacity, 10)
  const quantities = generateLabelsForQuantity(totalQty, capacity)
  const autoLabels = quantities.map((q, idx) => ({ id: `${itemKey}-auto-${idx + 1}`, quantity: q }))
  const remainder = Number.isFinite(totalQty) && Number.isFinite(capacity) && capacity > 0 ? totalQty % capacity : 0

  const flags = []
  let confidence = 'high'

  if (!Number.isFinite(totalQty) || totalQty <= 0 || !Number.isFinite(capacity) || capacity <= 0) {
    confidence = 'low'
    flags.push({ level: 'error', message: 'Invalid quantity or capacity' })
  } else if (remainder > 0) {
    confidence = 'medium'
    flags.push({ level: 'warning', message: 'Remainder split required' })
  }

  if (autoLabels.length > 20) {
    if (confidence !== 'low') confidence = 'medium'
    flags.push({ level: 'warning', message: 'High label count — analysis check recommended' })
  }

  return {
    itemKey,
    productName,
    totalQty: Number.isFinite(totalQty) ? totalQty : 0,
    category,
    packagingType: resolvedRule.rule.packaging || extractPackagingFromUnitName(resolvedRule.rule.unitName),
    capacity: Number.isFinite(capacity) ? capacity : 0,
    autoLabels,
    confidence,
    flags,
    matchedBy: resolvedRule.matchedBy || 'exact',
  }
}

export function normalizeManualLabels(labels, totalQty) {
  const normalized = (labels || [])
    .map((l, idx) => {
      const qty = Number.parseInt(l?.quantity, 10)
      return {
        id: l?.id || `manual-${idx + 1}`,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
      }
    })
    .filter(l => Number.isFinite(l.quantity) && l.quantity > 0)

  const qty = Number.parseInt(totalQty, 10)
  if (!Number.isFinite(qty) || qty <= 0) return []
  return normalized
}

export function sumManualLabels(labels) {
  return (labels || []).reduce((sum, l) => sum + (Number.parseInt(l.quantity, 10) || 0), 0)
}

export function isManualSplitValid(labels, totalQty) {
  const qty = Number.parseInt(totalQty, 10)
  if (!Number.isFinite(qty) || qty <= 0) return false
  return sumManualLabels(labels) === qty
}

export function getLabelOrderColour(key) {
  return LABEL_ORDER_COLOURS[key] || LABEL_ORDER_COLOURS.black
}

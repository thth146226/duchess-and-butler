export const LUTON_LIMIT_KG = 1200

const MICRO_PER_KG = 1000000n
const LIMIT_MICRO = BigInt(LUTON_LIMIT_KG) * MICRO_PER_KG
const CONTAINER_UNITS = new Set(['box', 'crate', 'bag'])
const PIECE_UNITS = new Set(['individual', 'piece', 'each'])

export function normalizeCatalogName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function asNonNegativeInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return null
}

function asPositiveInteger(value) {
  const parsed = asNonNegativeInteger(value)
  if (parsed == null || parsed <= 0) {
    return null
  }
  return parsed
}

function weightMicrograms(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { kind: 'invalid' }
    }
    if (value === 0) {
      return { kind: 'zero' }
    }
    if (value < 0) {
      return { kind: 'invalid' }
    }
    const micro = Math.round(value * 1000000)
    if (Math.abs(value * 1000000 - micro) > 0.001) {
      return { kind: 'invalid' }
    }
    return micro > 0 ? { kind: 'positive', micro: BigInt(micro) } : { kind: 'zero' }
  }
  const text = String(value ?? '').trim()
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { kind: 'invalid' }
  }
  if (/^0+(\.0+)?$/.test(text)) {
    return { kind: 'zero' }
  }
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    return { kind: 'invalid' }
  }
  const micro = BigInt(whole) * MICRO_PER_KG + BigInt((fraction + '000000').slice(0, 6))
  return micro > 0n ? { kind: 'positive', micro } : { kind: 'zero' }
}

function packingMode(unitName) {
  const unit = String(unitName || '').trim().toLowerCase()
  if (CONTAINER_UNITS.has(unit)) {
    return 'container'
  }
  if (PIECE_UNITS.has(unit)) {
    return 'piece'
  }
  return 'unknown'
}

function isNonPhysical(item) {
  const opportunity = String(item.opportunity_item_type_name || item.opportunityItemType || '').trim().toLowerCase()
  const transaction = String(item.transaction_type_name || item.transactionType || '').trim().toLowerCase()
  return opportunity === 'group' || transaction === 'service'
}

export function indexAtaCatalog(rows) {
  const grouped = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.active === false) {
      continue
    }
    const key = normalizeCatalogName(row.name)
    if (!key) {
      continue
    }
    const pieces = asPositiveInteger(row.pieces_per_unit)
    const weight = weightMicrograms(row.weight_per_unit)
    const entry = {
      name: row.name,
      unitName: String(row.unit_name || '').trim(),
      piecesPerUnit: pieces,
      weight,
    }
    const list = grouped.get(key) || []
    list.push(entry)
    grouped.set(key, list)
  }
  const index = new Map()
  for (const [key, list] of grouped) {
    const first = list[0]
    const sameRule = list.every((entry) => (
      entry.unitName.toLowerCase() === first.unitName.toLowerCase()
      && entry.piecesPerUnit === first.piecesPerUnit
      && entry.weight.kind === first.weight.kind
      && entry.weight.micro === first.weight.micro
    ))
    index.set(key, sameRule
      ? { status: 'unique', entry: first }
      : { status: 'ambiguous' })
  }
  return index
}

function unavailableAssessment() {
  return {
    status: 'UNAVAILABLE',
    knownMicro: 0n,
    calculated: 0,
    missing: 0,
    lines: [],
    limitMicro: LIMIT_MICRO,
  }
}

export function assessOrderWeight(items, catalogRows) {
  const index = catalogRows instanceof Map ? catalogRows : indexAtaCatalog(catalogRows)
  const lines = []
  let knownMicro = 0n
  let calculated = 0
  let missing = 0
  for (const item of Array.isArray(items) ? items : []) {
    const name = item && item.item_name ? item.item_name : ''
    if (item && isNonPhysical(item)) {
      lines.push({ id: item.id, name, disposition: 'not_physical' })
      continue
    }
    const quantity = item ? asNonNegativeInteger(item.quantity) : null
    const match = index.get(normalizeCatalogName(name))
    if (!match) {
      missing += 1
      lines.push({ id: item && item.id, name, disposition: 'missing', label: 'Weight missing' })
      continue
    }
    if (match.status === 'ambiguous') {
      missing += 1
      lines.push({ id: item && item.id, name, disposition: 'ambiguous', label: 'Needs verification' })
      continue
    }
    const entry = match.entry
    const mode = packingMode(entry.unitName)
    if (mode === 'unknown' || entry.weight.kind !== 'positive' || entry.piecesPerUnit == null || quantity == null) {
      missing += 1
      const weightMissing = mode !== 'unknown' && entry.weight.kind !== 'positive'
      lines.push({
        id: item && item.id,
        name,
        disposition: weightMissing ? 'zero_weight' : 'unknown_unit',
        label: weightMissing ? 'Weight missing' : 'Needs verification',
      })
      continue
    }
    const containers = mode === 'piece' || quantity === 0
      ? quantity
      : Math.ceil(quantity / entry.piecesPerUnit)
    const weightMicro = BigInt(containers) * entry.weight.micro
    knownMicro += weightMicro
    calculated += 1
    lines.push({
      id: item.id,
      name,
      disposition: 'calculated',
      containers,
      piecesPerUnit: entry.piecesPerUnit,
      unitName: entry.unitName,
      weightMicro,
      containerMicro: entry.weight.micro,
      mode,
    })
  }
  const physical = calculated + missing
  return {
    status: physical === 0 ? 'UNAVAILABLE' : (missing === 0 ? 'COMPLETE' : 'PARTIAL'),
    knownMicro,
    calculated,
    missing,
    lines,
    limitMicro: LIMIT_MICRO,
  }
}

export async function loadOrderWeight(items, loadCatalog) {
  try {
    const rows = await loadCatalog()
    if (!Array.isArray(rows)) {
      return unavailableAssessment()
    }
    return assessOrderWeight(items, rows)
  } catch (_error) {
    return unavailableAssessment()
  }
}

export function formatKilograms(micro) {
  const value = typeof micro === 'bigint' ? micro : 0n
  const whole = value / MICRO_PER_KG
  const fraction = (value % MICRO_PER_KG).toString().padStart(6, '0').slice(0, 3).replace(/0+$/, '')
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString()
}

export function presentOrderWeight(assessment, options = {}) {
  const source = options.itemsError ? unavailableAssessment() : (assessment || unavailableAssessment())
  const reason = options.itemsError ? 'items' : (source.status === 'UNAVAILABLE' ? 'catalog' : null)
  const complete = source.status === 'COMPLETE'
  const hasConfirmedWeight = complete || (source.status === 'PARTIAL' && source.knownMicro > 0n)
  const overLimit = complete && source.knownMicro > source.limitMicro
  const remainingMicro = complete ? source.limitMicro - source.knownMicro : null
  const percentTenths = complete
    ? Number((source.knownMicro * 1000n) / source.limitMicro)
    : null
  const estimateVehicles = overLimit
    ? Number((source.knownMicro + source.limitMicro - 1n) / source.limitMicro)
    : null
  return {
    status: source.status,
    reason,
    knownKg: hasConfirmedWeight ? formatKilograms(source.knownMicro) : null,
    calculated: source.calculated || 0,
    missing: source.missing || 0,
    percent: percentTenths == null ? null : (percentTenths / 10).toFixed(1),
    remainingKg: remainingMicro == null ? null : formatKilograms(remainingMicro < 0n ? 0n : remainingMicro),
    overLimit,
    estimateVehicles,
    lines: source.lines || [],
  }
}

export function orderWeightMessage(view) {
  if (!view || view.reason === 'items') {
    return 'The item list could not be loaded. The order weight is not shown.'
  }
  if (view.reason === 'catalog' || view.status === 'UNAVAILABLE') {
    return 'The weight catalog could not be loaded. The order weight is not shown.'
  }
  if (view.status === 'PARTIAL' && view.knownKg == null) {
    return 'No confirmed weight yet. The order total is not available.'
  }
  if (view.status === 'PARTIAL') {
    return 'Some physical lines still need a weight. This is not a vehicle recommendation.'
  }
  return 'All physical lines have a validated weight.'
}

let catalogPromise = null

export function resetAtaCatalogCache() {
  catalogPromise = null
}

export function fetchAtaCatalog(client) {
  if (!catalogPromise) {
    catalogPromise = readAtaCatalog(client).catch((error) => {
      catalogPromise = null
      throw error
    })
  }
  return catalogPromise
}

async function readAtaCatalog(client) {
  const rows = []
  const pageSize = 1000
  for (let from = 0; from < 5000; from += pageSize) {
    const { data, error } = await client
      .from('ata_items')
      .select('id, name, category, unit_name, pieces_per_unit, weight_per_unit, active')
      .eq('active', true)
      .range(from, from + pageSize - 1)
    if (error) {
      throw error
    }
    const batch = data || []
    rows.push(...batch)
    if (batch.length < pageSize) {
      return rows
    }
  }
  throw new Error('CATALOG_TRUNCATED')
}

import { buildAtaCapacityMap, resolveJobItemRule } from './labelGenerator'
import { planPacking } from './packingPlan'

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

// Exact, reviewed alias: the dimensions in inches are the same as the cm name.
// Do NOT automatically alias different fabric, colour, size, or weight.
const VERIFIED_ATA_NAME_ALIASES = new Map([
  [
    normalizeCatalogName('Duchess Drape Iris White Tablecloth 245cm x 350cm (96" x 137")'),
    normalizeCatalogName('Duchess Drape Iris White Tablecloth 245cm x 350cm'),
  ],
  [
    normalizeCatalogName('Dali Dining Chair'),
    normalizeCatalogName('Dali Black and White Boucle Chair'),
  ],
])

function findCatalogRule(index, orderName, labelsMap) {
  const normalized = normalizeCatalogName(orderName)
  const direct = index.get(normalized)
  if (direct) return direct
  const alias = VERIFIED_ATA_NAME_ALIASES.get(normalized)
  if (alias && index.get(alias)) {
    const matched = index.get(alias)

    if (normalized === normalizeCatalogName('Dali Dining Chair')) {
      const chair = matched.status === 'unique' ? matched.entry : null
      const unit = String(chair?.unitName || '').trim().toLowerCase()

      // Only match a validated individual chair, never an unknown pack.
      if (!chair || chair.piecesPerUnit !== 1 || !PIECE_UNITS.has(unit)) {
        return undefined
      }
    }

    return matched
  }
  if (!labelsMap) return undefined
  const resolved = resolveJobItemRule({ item_name: orderName }, labelsMap)
  if (!resolved.matched || !resolved.rule?.name) return undefined
  return index.get(normalizeCatalogName(resolved.rule.name))
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
  // Specifically verified logistics service; other Sale products may be physical.
  return opportunity === 'group'
    || transaction === 'service'
    || (transaction === 'sale' && normalizeCatalogName(item.item_name) === 'delivery collection')
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
      id: row.id == null || String(row.id).trim() === '' ? `${key}#${listLength(grouped, key)}` : String(row.id),
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
    const alternatives = list
      .map(presentAlternative)
      .sort(compareAlternatives)
    index.set(key, sameRule
      ? { status: 'unique', entry: first, alternatives }
      : { status: 'ambiguous', alternatives })
  }
  return index
}

function listLength(grouped, key) {
  const list = grouped.get(key)
  return list ? list.length : 0
}

function presentAlternative(entry) {
  return {
    id: entry.id,
    name: entry.name,
    unitName: entry.unitName,
    piecesPerUnit: entry.piecesPerUnit,
    weightKind: entry.weight.kind,
    weightMicro: entry.weight.kind === 'positive' ? entry.weight.micro : 0n,
  }
}

function compareAlternatives(left, right) {
  const leftPieces = left.piecesPerUnit == null ? Number.MAX_SAFE_INTEGER : left.piecesPerUnit
  const rightPieces = right.piecesPerUnit == null ? Number.MAX_SAFE_INTEGER : right.piecesPerUnit
  if (leftPieces !== rightPieces) {
    return leftPieces - rightPieces
  }
  return String(left.id).localeCompare(String(right.id))
}

function unavailableAssessment() {
  return {
    status: 'UNAVAILABLE',
    knownMicro: 0n,
    previewMicro: 0n,
    calculated: 0,
    previewCount: 0,
    missing: 0,
    lines: [],
    limitMicro: LIMIT_MICRO,
  }
}

function selectionMatches(alternative, choice) {
  if (typeof choice === 'string') {
    return choice.trim() !== '' && alternative.id === choice
  }
  if (!choice || typeof choice !== 'object' || choice.id == null) {
    return false
  }
  const weight = alternative.weightMicro == null ? '0' : alternative.weightMicro.toString()
  return alternative.id === String(choice.id)
    && alternative.piecesPerUnit === choice.piecesPerUnit
    && String(alternative.unitName || '').toLowerCase() === String(choice.unitName || '').toLowerCase()
    && weight === String(choice.weightMicro)
}

function selectedAlternative(alternatives, lineId, selections) {
  if (!lineId || !selections || typeof selections !== 'object') {
    return null
  }
  const choice = selections[lineId]
  if (choice == null || choice === '') {
    return null
  }
  return (alternatives || []).find((alternative) => selectionMatches(alternative, choice)) || null
}

function packingRules(alternatives) {
  return (alternatives || [])
    .filter((rule) => packingMode(rule.unitName) === 'container' && rule.piecesPerUnit > 0)
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      unitName: rule.unitName,
      piecesPerUnit: rule.piecesPerUnit,
      weightKind: rule.weightKind,
      weightMicro: rule.weightMicro,
    }))
}

function ruleFromEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    unitName: entry.unitName,
    piecesPerUnit: entry.piecesPerUnit,
    weightKind: entry.weight.kind,
    weightMicro: entry.weight.kind === 'positive' ? entry.weight.micro : 0n,
  }
}

function confirmedPlan(plans, choice, quantity) {
  if (!choice || typeof choice !== 'object' || !choice.confirmed || choice.quantity !== quantity) {
    return null
  }
  const wanted = Array.isArray(choice.rules) ? choice.rules : []
  return (plans || []).find((plan) => (
    plan.fingerprint.rules.length === wanted.length
    && plan.fingerprint.rules.every((rule, index) => {
      const other = wanted[index]
      return other
        && rule.id === String(other.id)
        && rule.piecesPerUnit === other.piecesPerUnit
        && String(rule.unitName || '').toLowerCase() === String(other.unitName || '').toLowerCase()
        && rule.weightMicro === String(other.weightMicro)
        && rule.count === other.count
    })
  )) || null
}

function containerCount(quantity, entry) {
  const mode = packingMode(entry.unitName)
  if (mode === 'unknown' || entry.piecesPerUnit == null || quantity == null) {
    return null
  }
  if (mode === 'piece' || quantity === 0) {
    return quantity
  }
  return Math.ceil(quantity / entry.piecesPerUnit)
}

export function assessOrderWeight(items, catalogRows, selections) {
  const index = catalogRows instanceof Map ? catalogRows : indexAtaCatalog(catalogRows)
  const labelsMap = catalogRows instanceof Map ? null : buildAtaCapacityMap(catalogRows)
  const lines = []
  let knownMicro = 0n
  let previewMicro = 0n
  let calculated = 0
  let previewCount = 0
  let missing = 0
  for (const item of Array.isArray(items) ? items : []) {
    const name = item && item.item_name ? item.item_name : ''
    if (item && isNonPhysical(item)) {
      lines.push({ id: item.id, name, disposition: 'not_physical' })
      continue
    }
    const quantity = item ? asNonNegativeInteger(item.quantity) : null
    const match = findCatalogRule(index, name, labelsMap)
    if (!match) {
      missing += 1
      lines.push({ id: item && item.id, name, disposition: 'missing', label: 'Weight missing' })
      continue
    }
    if (match.status === 'ambiguous') {
      const alternatives = match.alternatives || []
      const rules = packingRules(alternatives)
      const planned = planPacking({ quantity, rules })
      const choice = selections && item && selections[item.id]
      const accepted = confirmedPlan(planned.plans, choice, quantity)
      if (accepted && accepted.exact && accepted.weightState === 'calculated') {
        knownMicro += accepted.calculatedMicro
        calculated += 1
        lines.push({
          id: item.id,
          name,
          disposition: 'calculated',
          label: 'Confirmed weight',
          alternatives,
          plans: planned.plans,
          packingTruncation: planned.truncation,
          plan: accepted,
          planConfirmed: true,
          weightMicro: accepted.calculatedMicro,
          containers: accepted.boxCount,
        })
        continue
      }
      missing += 1
      if (accepted && accepted.weightState === 'unknown-partial') {
        const partialBox = accepted.boxes.find((box) => !box.full)
        lines.push({
          id: item.id,
          name,
          disposition: 'partial_box',
          label: 'Unknown weight',
          alternatives,
          plans: planned.plans,
          packingTruncation: planned.truncation,
          plan: accepted,
          planConfirmed: true,
          piecesPerUnit: partialBox ? partialBox.piecesPerUnit : null,
          unitName: partialBox ? partialBox.unitName : '',
          partialPieces: partialBox ? partialBox.piecesEach : null,
          unfilled: partialBox ? partialBox.unfilled : null,
        })
        continue
      }
      const chosen = selectedAlternative(alternatives, item && item.id, selections)
      const single = chosen && chosen.weightKind === 'positive'
        ? planPacking({ quantity, rules: packingRules([chosen]) }).plans[0]
        : null
      if (!single) {
        lines.push({
          id: item && item.id,
          name,
          disposition: 'ambiguous',
          label: 'Needs verification',
          alternatives,
          plans: planned.plans,
          packingTruncation: planned.truncation,
        })
        continue
      }
      if (single.exact && single.weightState === 'calculated') {
        previewMicro += single.calculatedMicro
        previewCount += 1
      }
      lines.push({
        id: item.id,
        name,
        disposition: 'preview',
        label: 'Packaging preview',
        alternatives,
        plans: planned.plans,
        packingTruncation: planned.truncation,
        plan: single,
        selectedId: chosen.id,
        containers: single.boxCount,
        piecesPerUnit: chosen.piecesPerUnit,
        unitName: chosen.unitName,
        weightMicro: single.exact ? single.calculatedMicro : 0n,
        containerMicro: chosen.weightMicro,
      })
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
        unitName: entry.unitName,
        piecesPerUnit: entry.piecesPerUnit,
      })
      continue
    }
    if (mode === 'container' && quantity > 0 && quantity % entry.piecesPerUnit !== 0) {
      const planned = planPacking({ quantity, rules: [ruleFromEntry(entry)] })
      const plan = planned.plans[0] || null
      missing += 1
      lines.push({
        id: item.id,
        name,
        disposition: 'partial_box',
        label: 'Unknown weight',
        plan,
        plans: planned.plans,
        packingTruncation: planned.truncation,
        containers: plan ? plan.boxes.filter((box) => box.full).reduce((sum, box) => sum + box.count, 0) : 0,
        piecesPerUnit: entry.piecesPerUnit,
        unitName: entry.unitName,
        containerMicro: entry.weight.micro,
        partialPieces: plan ? plan.boxes.find((box) => !box.full)?.piecesEach : quantity,
        unfilled: plan ? plan.unfilledPieces : null,
      })
      continue
    }
    const containers = containerCount(quantity, entry)
    const weightMicro = BigInt(containers) * entry.weight.micro
    const planned = mode === 'container'
      ? planPacking({ quantity, rules: [ruleFromEntry(entry)] })
      : null
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
      plan: planned ? planned.plans[0] || null : null,
      packingTruncation: planned ? planned.truncation : [],
      planConfirmed: true,
    })
  }
  const physical = calculated + missing
  return {
    status: physical === 0 ? 'UNAVAILABLE' : (missing === 0 ? 'COMPLETE' : 'PARTIAL'),
    knownMicro,
    previewMicro,
    calculated,
    previewCount,
    missing,
    lines,
    limitMicro: LIMIT_MICRO,
  }
}

export async function loadOrderWeight(items, loadCatalog, selections) {
  try {
    const rows = await loadCatalog()
    if (!Array.isArray(rows)) {
      return unavailableAssessment()
    }
    return assessOrderWeight(items, rows, selections)
  } catch (_error) {
    return unavailableAssessment()
  }
}

export function measurementRequest(line) {
  if (!line) {
    return ''
  }
  if (line.disposition === 'zero_weight' && line.piecesPerUnit && line.unitName) {
    return `Weigh one packed ${line.unitName.toLowerCase()} of ${line.piecesPerUnit}. Do not copy another product.`
  }
  if (line.disposition === 'missing') {
    return 'No catalog packing rule. Do not copy another product weight.'
  }
  if (line.disposition === 'ambiguous') {
    return 'Labels / ATA can suggest a packing plan. The suggestion is a preview and is not saved.'
  }
  if (line.disposition === 'partial_box') {
    const unit = String(line.unitName || 'pack').toLowerCase()
    const filled = line.partialPieces || line.plan?.boxes?.find((box) => !box.full)?.piecesEach
    const capacity = line.piecesPerUnit
    if (filled && capacity) {
      return `A partly filled ${unit} of ${capacity} holds ${filled}. ATA records the full ${unit} weight, not the weight of ${filled} pieces.`
    }
    return 'ATA records the full pack weight, not the weight of a partly filled pack.'
  }
  return ''
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
  const previewMicro = source.previewMicro || 0n
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
    previewKg: previewMicro > 0n ? formatKilograms(previewMicro) : null,
    previewCount: source.previewCount || 0,
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
  if (view.status === 'PARTIAL' && view.previewKg) {
    return 'Some physical lines still need a weight. A selected box is only a preview: it is not saved and it is not a vehicle recommendation.'
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
  if (catalogPromise) {
    return catalogPromise
  }
  const pending = readAtaCatalog(client).then(
    (rows) => rows,
    (error) => {
      if (catalogPromise === pending) {
        catalogPromise = null
      }
      throw error
    },
  )
  catalogPromise = pending
  return pending
}

export function refreshAtaCatalog(client) {
  catalogPromise = null
  return fetchAtaCatalog(client)
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

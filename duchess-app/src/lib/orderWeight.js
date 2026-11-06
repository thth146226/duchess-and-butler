import { buildAtaCapacityMap, resolveJobItemRule } from './labelGenerator'
import { planPacking } from './packingPlan'
import { RELIABILITY, addRational } from './netWeight'

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

function optionalMicro(value) {
  if (value == null || value === '') {
    return null
  }
  const parsed = weightMicrograms(value)
  if (parsed.kind === 'positive') {
    return parsed.micro
  }
  if (parsed.kind === 'zero') {
    return 0n
  }
  return null
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
      tareMicro: optionalMicro(row.tare_kg),
      bundlePieces: asPositiveInteger(row.bundle_pieces),
      additionalPackagingMicro: optionalMicro(row.additional_packaging_kg),
      partialOnlyPackagingMicro: optionalMicro(row.partial_only_packaging_kg),
      measuredMicro: optionalMicro(row.measured_weight_kg),
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
      && entry.tareMicro === first.tareMicro
      && entry.bundlePieces === first.bundlePieces
      && entry.additionalPackagingMicro === first.additionalPackagingMicro
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
    tareMicro: entry.tareMicro,
    bundlePieces: entry.bundlePieces,
    additionalPackagingMicro: entry.additionalPackagingMicro,
    partialOnlyPackagingMicro: entry.partialOnlyPackagingMicro,
    measuredMicro: entry.measuredMicro,
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
    planningMicro: 0n,
    derivedMicro: 0n,
    measuredMicro: 0n,
    calculated: 0,
    previewCount: 0,
    planningCount: 0,
    derivedCount: 0,
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
      tareMicro: rule.tareMicro,
      bundlePieces: rule.bundlePieces,
      additionalPackagingMicro: rule.additionalPackagingMicro,
      partialOnlyPackagingMicro: rule.partialOnlyPackagingMicro,
      measuredMicro: rule.measuredMicro,
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
    tareMicro: entry.tareMicro,
    bundlePieces: entry.bundlePieces,
    additionalPackagingMicro: entry.additionalPackagingMicro,
    partialOnlyPackagingMicro: entry.partialOnlyPackagingMicro,
    measuredMicro: entry.measuredMicro,
  }
}

function choiceSelectsPack(choice) {
  return Boolean(choice && typeof choice === 'object' && (choice.selected || choice.confirmed || choice.weightConfirmed))
}

function matchedPlan(plans, choice, quantity) {
  if (!choiceSelectsPack(choice) || choice.quantity !== quantity) {
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
        && (rule.tareMicro || '') === String(other.tareMicro || '')
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
  let planningMicro = 0n
  let derivedMicro = 0n
  let derivedRational = null
  let measuredTotal = 0n
  let calculated = 0
  let previewCount = 0
  let planningCount = 0
  let derivedCount = 0
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
      const accepted = matchedPlan(planned.plans, choice, quantity) || (
        planned.automatic && planned.automatic.signature
        && matchedPlan([planned.automatic], choice, quantity)
      )
      function pushResolved(plan, selected) {
        const partialBox = (plan.boxes || []).find((box) => !box.full)
        const base = {
          id: item.id,
          name,
          alternatives,
          plans: planned.plans,
          packingTruncation: planned.truncation,
          plan,
          planSelected: selected,
          planConfirmed: plan.reliability === RELIABILITY.ATA_FULL_PACK,
          catalogInconsistent: Boolean(plan.catalogInconsistent),
          qualified: Boolean(plan.qualified),
          qualification: plan.qualification || null,
          configurationOpen: planned.plans.length > 1
            || (planned.truncation.length > 0 && alternatives.length > 1),
        }
        if (plan.reliability === RELIABILITY.ATA_FULL_PACK && plan.calculatedMicro > 0n) {
          knownMicro += plan.calculatedMicro
          calculated += 1
          lines.push({
            ...base,
            disposition: 'calculated',
            label: 'ATA full-pack total',
            weightMicro: plan.calculatedMicro,
            containers: plan.boxCount,
          })
          return
        }
        if (plan.reliability === RELIABILITY.ATA_DERIVED_GROSS && plan.derivedNumerator != null) {
          derivedRational = addRational(derivedRational, {
            numerator: plan.derivedNumerator,
            denominator: plan.derivedDenominator,
          })
          if (plan.derivedMicro != null) derivedMicro += plan.derivedMicro
          derivedCount += 1
          missing += 1
          lines.push({
            ...base,
            disposition: 'derived',
            label: 'Derived gross',
            derivedMicro: plan.derivedMicro,
            derivedNumerator: plan.derivedNumerator,
            derivedDenominator: plan.derivedDenominator,
            piecesPerUnit: partialBox ? partialBox.piecesPerUnit : null,
            unitName: partialBox ? partialBox.unitName : '',
            partialPieces: partialBox ? partialBox.piecesEach : null,
            bundles: plan.bundles,
          })
          return
        }
        if (plan.reliability === RELIABILITY.MEASURED && plan.measuredMicro != null) {
          measuredTotal += plan.measuredMicro
          missing += 1
          lines.push({
            ...base,
            disposition: 'measured',
            label: 'Measured weight',
            measuredMicro: plan.measuredMicro,
          })
          return
        }
        if (plan.reliability === RELIABILITY.GROSS_PACKING_ALLOWANCE && plan.planningAllowanceMicro != null && plan.planningAllowanceMicro > 0n) {
          planningMicro += plan.planningAllowanceMicro
          planningCount += 1
          missing += 1
          lines.push({
            ...base,
            disposition: 'partial_box',
            label: 'Planning allowance',
            planningAllowanceMicro: plan.planningAllowanceMicro,
            piecesPerUnit: partialBox ? partialBox.piecesPerUnit : null,
            unitName: partialBox ? partialBox.unitName : '',
            partialPieces: partialBox ? partialBox.piecesEach : null,
            unfilled: partialBox ? partialBox.unfilled : null,
          })
          return
        }
        missing += 1
        lines.push({ ...base, disposition: 'ambiguous', label: 'Needs verification' })
      }
      if (accepted) {
        pushResolved(accepted, true)
        continue
      }
      const chosen = selectedAlternative(alternatives, item && item.id, selections)
      if (!chosen) {
        if (planned.automatic) {
          pushResolved(planned.automatic, false)
        } else {
          missing += 1
          lines.push({
            id: item && item.id,
            name,
            disposition: 'ambiguous',
            label: 'Needs verification',
            alternatives,
            plans: planned.plans,
            packingTruncation: planned.truncation,
          })
        }
        continue
      }
      const single = chosen.weightKind === 'positive'
        ? planPacking({ quantity, rules: packingRules([chosen]) }).plans[0]
        : null
      missing += 1
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
      } else if (single.planningAllowanceMicro != null && single.planningAllowanceMicro > 0n) {
        planningMicro += single.planningAllowanceMicro
        planningCount += 1
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
      const plan = planned.automatic || planned.plans[0] || null
      if (plan && plan.reliability === RELIABILITY.UNKNOWN) {
        missing += 1
        lines.push({
          id: item.id,
          name,
          disposition: 'ambiguous',
          label: 'Needs verification',
          plan,
          plans: planned.plans,
          packingTruncation: planned.truncation,
          piecesPerUnit: entry.piecesPerUnit,
          unitName: entry.unitName,
        })
        continue
      }
      if (plan && plan.reliability === RELIABILITY.ATA_DERIVED_GROSS && plan.derivedNumerator != null) {
        derivedRational = addRational(derivedRational, {
          numerator: plan.derivedNumerator,
          denominator: plan.derivedDenominator,
        })
        if (plan.derivedMicro != null) derivedMicro += plan.derivedMicro
        derivedCount += 1
        missing += 1
        lines.push({
          id: item.id,
          name,
          disposition: 'derived',
          label: 'Derived gross',
          plan,
          plans: planned.plans,
          packingTruncation: planned.truncation,
          derivedMicro: plan.derivedMicro,
          derivedNumerator: plan.derivedNumerator,
          derivedDenominator: plan.derivedDenominator,
          qualified: Boolean(plan.qualified),
          qualification: plan.qualification || null,
          bundles: plan.bundles,
          piecesPerUnit: entry.piecesPerUnit,
          unitName: entry.unitName,
          partialPieces: plan.boxes.find((box) => !box.full)?.piecesEach || quantity,
          unfilled: plan.unfilledPieces,
        })
        continue
      }
      missing += 1
      const allowance = plan && plan.planningAllowanceMicro != null && plan.planningAllowanceMicro > 0n
        ? plan.planningAllowanceMicro
        : null
      if (allowance != null) {
        planningMicro += allowance
        planningCount += 1
      }
      lines.push({
        id: item.id,
        name,
        disposition: 'partial_box',
        label: allowance != null ? 'Planning allowance' : 'Unknown weight',
        plan,
        plans: planned.plans,
        packingTruncation: planned.truncation,
        containers: plan ? plan.boxes.filter((box) => box.full).reduce((sum, box) => sum + box.count, 0) : 0,
        piecesPerUnit: entry.piecesPerUnit,
        unitName: entry.unitName,
        containerMicro: entry.weight.kind === 'positive' ? entry.weight.micro : 0n,
        planningAllowanceMicro: allowance,
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
      plan: planned ? planned.automatic || planned.plans[0] || null : null,
      packingTruncation: planned ? planned.truncation : [],
      planConfirmed: true,
    })
  }
  const physical = calculated + missing
  return {
    status: physical === 0 ? 'UNAVAILABLE' : (missing === 0 ? 'COMPLETE' : 'PARTIAL'),
    knownMicro,
    previewMicro,
    planningMicro,
    derivedMicro,
    derivedNumerator: derivedRational ? derivedRational.numerator : 0n,
    derivedDenominator: derivedRational ? derivedRational.denominator : 1n,
    configurationOpen: lines.some((line) => line.configurationOpen),
    measuredMicro: measuredTotal,
    calculated,
    previewCount,
    planningCount,
    derivedCount,
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
  if (line.disposition === 'derived') {
    const bundles = line.bundles && line.bundles.bundlePieces
      ? ` ${line.bundles.fullBundles} complete bundles of ${line.bundles.bundlePieces} and ${line.bundles.extraPieces} additional pieces.`
      : ''
    const qualified = line.qualified
      ? ' Partial bundle packaging is not recorded, so this remains a qualified estimate.'
      : ''
    return `Derived gross from the empty-box tare and the net content.${bundles} It is not a scale measurement of this order.${qualified}`
  }
  if (line.disposition === 'measured') {
    return 'This line uses a recorded scale measurement. It is separate from the ATA catalog weight.'
  }
  if (line.disposition === 'ambiguous') {
    return 'There is no automatic packing plan for this line. A planning allowance is not a confirmed weight.'
  }
  if (line.disposition === 'pack_selected') {
    return 'The weight is calculated from ATA full-pack records. It is not a scale measurement of this order.'
  }
  if (line.disposition === 'partial_box') {
    const unit = String(line.unitName || line.plan?.boxes?.find((box) => !box.full)?.unitName || 'pack').toLowerCase()
    const filled = line.partialPieces || line.plan?.boxes?.find((box) => !box.full)?.piecesEach
    const capacity = line.piecesPerUnit || line.plan?.boxes?.find((box) => !box.full)?.piecesPerUnit
    const allowance = line.planningAllowanceMicro != null
      ? ` Planning allowance: ${formatKilograms(line.planningAllowanceMicro)} kg, the gross weight of the full packs in this configuration. It is not a confirmed weight.`
      : ''
    if (filled && capacity) {
      return `A partly filled ${unit} of ${capacity} holds ${filled}. ATA records the full ${unit} weight, not the weight of ${filled} pieces.${allowance}`
    }
    return `ATA records the full pack weight, not the weight of a partly filled pack.${allowance}`
  }
  return ''
}

export const DISPLAY_ROUNDING = 'Round half away from zero to the nearest 0.001 kg, and only when the weight is shown.'

const DISPLAY_STEP = 1000n

export function formatKilograms(micro, denominator = 1n) {
  const numerator = typeof micro === 'bigint' ? micro : 0n
  const denom = typeof denominator === 'bigint' && denominator > 0n ? denominator : 1n
  const negative = numerator < 0n
  const absolute = negative ? -numerator : numerator
  const rounded = ((absolute + (denom * DISPLAY_STEP) / 2n) / (denom * DISPLAY_STEP)) * DISPLAY_STEP
  const whole = rounded / MICRO_PER_KG
  const fraction = (rounded % MICRO_PER_KG).toString().padStart(6, '0').slice(0, 3).replace(/0+$/, '')
  const text = fraction ? `${whole.toString()}.${fraction}` : whole.toString()
  return negative && rounded !== 0n ? `-${text}` : text
}

function allowanceMicro(line) {
  if (line && typeof line.planningAllowanceMicro === 'bigint' && line.planningAllowanceMicro > 0n) {
    return line.planningAllowanceMicro
  }
  const planAllowance = line && line.plan ? line.plan.planningAllowanceMicro : null
  if (typeof planAllowance === 'bigint' && planAllowance > 0n) {
    return planAllowance
  }
  return null
}

function lineEstimateKind(line) {
  if (!line || line.disposition === 'not_physical') {
    return 'ignored'
  }
  if (line.disposition === 'calculated') {
    return 'ata'
  }
  if (line.disposition === 'derived' && typeof line.derivedNumerator === 'bigint' && line.derivedNumerator > 0n) {
    return 'derived'
  }
  if (line.disposition === 'measured' && typeof line.measuredMicro === 'bigint' && line.measuredMicro > 0n) {
    return 'measured'
  }
  if ((line.disposition === 'partial_box' || line.disposition === 'preview') && allowanceMicro(line)) {
    return 'allowance'
  }
  return 'none'
}

export function presentOrderWeight(assessment, options = {}) {
  const source = options.itemsError ? unavailableAssessment() : (assessment || unavailableAssessment())
  const reason = options.itemsError ? 'items' : (source.status === 'UNAVAILABLE' ? 'catalog' : null)
  const complete = source.status === 'COMPLETE'
  const previewMicro = source.previewMicro || 0n
  const planningMicro = source.planningMicro || 0n
  const knownMicro = source.knownMicro || 0n
  const derivedNumerator = typeof source.derivedNumerator === 'bigint' ? source.derivedNumerator : 0n
  const derivedDenominator = typeof source.derivedDenominator === 'bigint' && source.derivedDenominator > 0n
    ? source.derivedDenominator
    : 1n
  const measuredMicro = source.measuredMicro || 0n
  const hasConfirmedWeight = complete || (source.status === 'PARTIAL' && knownMicro > 0n)
  const overLimit = complete && knownMicro > source.limitMicro
  const remainingMicro = complete ? source.limitMicro - knownMicro : null
  const percentTenths = complete
    ? Number((knownMicro * 1000n) / source.limitMicro)
    : null
  const estimateVehicles = overLimit && !source.configurationOpen
    ? Number((knownMicro + source.limitMicro - 1n) / source.limitMicro)
    : null
  let estimated = null
  function include(numerator, denominator) {
    if (typeof numerator !== 'bigint' || numerator === 0n) {
      return
    }
    estimated = addRational(estimated, { numerator, denominator })
  }
  include(knownMicro, 1n)
  include(derivedNumerator, derivedDenominator)
  include(planningMicro, 1n)
  include(measuredMicro, 1n)
  const unestimatedCount = (source.lines || []).filter((line) => lineEstimateKind(line) === 'none').length
  const estimatedProvisional = planningMicro > 0n || derivedNumerator > 0n
  const estimatedCoverage = estimated == null ? null : (unestimatedCount > 0 ? 'partial' : 'complete')
  return {
    status: source.status,
    reason,
    knownKg: hasConfirmedWeight ? formatKilograms(knownMicro) : null,
    previewKg: previewMicro > 0n ? formatKilograms(previewMicro) : null,
    planningKg: planningMicro > 0n ? formatKilograms(planningMicro) : null,
    derivedKg: derivedNumerator > 0n ? formatKilograms(derivedNumerator, derivedDenominator) : null,
    measuredKg: measuredMicro > 0n ? formatKilograms(measuredMicro) : null,
    estimatedTotalKg: estimated ? formatKilograms(estimated.numerator, estimated.denominator) : null,
    estimatedCoverage,
    estimatedProvisional,
    showEstimatedHeadline: Boolean(estimated) && (estimatedProvisional || unestimatedCount > 0),
    unestimatedCount,
    previewCount: source.previewCount || 0,
    planningCount: source.planningCount || 0,
    derivedCount: source.derivedCount || 0,
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
  if (view.showEstimatedHeadline) {
    const gap = view.estimatedCoverage === 'partial'
      ? ` ${view.unestimatedCount} ${view.unestimatedCount === 1 ? 'line has' : 'lines have'} no usable weight.`
      : ''
    return `Planning estimate based on ATA packing records. Not a scale measurement or a vehicle loading approval.${gap}`
  }
  if (view.status === 'PARTIAL' && view.knownKg == null && !view.previewKg && !view.planningKg && !view.derivedKg && !view.measuredKg) {
    return 'No confirmed weight yet. The order total is not available.'
  }
  if (view.status === 'PARTIAL' && (view.planningKg || view.derivedKg || view.measuredKg)) {
    return 'Some physical lines still need a weight. A derived gross uses tare and net content. A planning allowance is the full-box gross. Neither is a scale measurement or a vehicle recommendation.'
  }
  if (view.status === 'PARTIAL' && view.previewKg) {
    return 'Some physical lines still need a weight. A selected box is only a preview: it is not saved and it is not a vehicle recommendation.'
  }
  if (view.status === 'PARTIAL') {
    return 'Some physical lines still need a weight. This is not a vehicle recommendation.'
  }
  return 'All physical lines have an ATA full-pack total. This is not a scale measurement of this order.'
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
      // tare_kg, bundle_pieces and additional_packaging_kg are not selected.
      // Those columns do not exist yet. Requesting them would fail the catalog read.
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

import {
  buildAtaCapacityMap,
  generateLabelsForQuantity,
  resolveJobItemRule,
} from './labelGenerator'
import {
  AUTOMATIC_PACKING_POLICY,
  RELIABILITY,
  addRational,
  comparePackNets,
  deriveContentWeight,
} from './netWeight'

const CONTAINER_UNITS = new Set(['box', 'crate', 'bag'])

// The Labels split of the largest ATA capacity is the first suggestion.
// It is not confirmation that those physical boxes will be used.
// Other exact combinations of the same product follow, largest capacity first.
// Fewer boxes is not treated as less weight.
// The search stops at 6 rules, 8 boxes, 240 steps, and 4 plans.
export const PACKING_PLAN_LIMITS = Object.freeze({
  maxRules: 6,
  maxBoxes: 8,
  maxNodes: 240,
  maxPlans: 4,
})

export const PACKING_PRIORITY = 'Labels largest-capacity split first, then other exact combinations of the same product. Fewer boxes is not treated as less weight.'

export { AUTOMATIC_PACKING_POLICY, RELIABILITY }

function productKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function containerRule(rule) {
  return CONTAINER_UNITS.has(String(rule?.unitName || '').trim().toLowerCase())
    && Number.isInteger(rule?.piecesPerUnit)
    && rule.piecesPerUnit > 0
}

function weightKnown(rule) {
  return rule?.weightKind === 'positive' && rule.weightMicro > 0n
}

function splitQuantity(quantity, capacity) {
  if (Math.ceil(quantity / capacity) > PACKING_PLAN_LIMITS.maxBoxes) {
    return { truncated: true, full: 0, remainder: 0 }
  }
  const generated = generateLabelsForQuantity(quantity, capacity)
  return {
    truncated: false,
    full: generated.filter((part) => part === capacity).length,
    remainder: generated.find((part) => part !== capacity) || 0,
  }
}

function labelsRuleFor(rules) {
  const rows = rules.map((rule) => ({
    id: rule.id,
    name: rules[0].name,
    active: true,
    pieces_per_unit: rule.piecesPerUnit,
    unit_name: rule.unitName,
    category: '',
  }))
  const resolved = resolveJobItemRule({ item_name: rules[0].name }, buildAtaCapacityMap(rows))
  if (!resolved.matched || !resolved.rule) {
    return null
  }
  return rules.find((rule) => rule.id === resolved.rule.sourceId)
    || rules.find((rule) => rule.piecesPerUnit === resolved.rule.capacity)
    || null
}

function storedMicro(value) {
  return typeof value === 'bigint' ? value.toString() : null
}

function boxGroup(rule, count, piecesEach, full) {
  const grossKnown = weightKnown(rule)
  return {
    id: String(rule.id),
    piecesPerUnit: rule.piecesPerUnit,
    unitName: rule.unitName,
    count,
    piecesEach,
    full,
    unfilled: full ? 0 : rule.piecesPerUnit - piecesEach,
    weightMicro: rule.weightMicro == null ? '0' : rule.weightMicro.toString(),
    weightKnown: full && grossKnown,
    grossWeightKnown: grossKnown,
    tareMicro: storedMicro(rule.tareMicro),
    bundlePieces: Number.isInteger(rule.bundlePieces) && rule.bundlePieces > 1 ? rule.bundlePieces : null,
    additionalPackagingMicro: storedMicro(rule.additionalPackagingMicro),
    partialOnlyPackagingMicro: storedMicro(rule.partialOnlyPackagingMicro),
    measuredMicro: storedMicro(rule.measuredMicro),
  }
}

function groupsFromSplit(rule, split) {
  const groups = []
  if (split.full > 0) {
    groups.push(boxGroup(rule, split.full, rule.piecesPerUnit, true))
  }
  if (split.remainder > 0) {
    groups.push(boxGroup(rule, 1, split.remainder, false))
  }
  return groups
}

function asMicro(value) {
  return value == null || value === '' ? null : BigInt(value)
}

function groupContent(group) {
  if (group.measuredMicro != null && BigInt(group.measuredMicro) > 0n) {
    return {
      reliability: RELIABILITY.MEASURED,
      micro: BigInt(group.measuredMicro) * BigInt(group.count),
      qualified: false,
      qualification: null,
    }
  }
  if (group.full) {
    if (!group.grossWeightKnown) {
      return { reliability: RELIABILITY.UNKNOWN, micro: null, qualified: false, qualification: null }
    }
    return {
      reliability: RELIABILITY.ATA_FULL_PACK,
      micro: BigInt(group.weightMicro) * BigInt(group.count),
      qualified: false,
      qualification: null,
    }
  }
  const derived = deriveContentWeight({
    fullGrossMicro: group.grossWeightKnown ? BigInt(group.weightMicro) : null,
    tareMicro: asMicro(group.tareMicro),
    capacity: group.piecesPerUnit,
    pieces: group.piecesEach,
    bundlePieces: group.bundlePieces,
    additionalPackagingMicro: asMicro(group.additionalPackagingMicro),
    partialOnlyPackagingMicro: asMicro(group.partialOnlyPackagingMicro),
  })
  if (derived.reliability === RELIABILITY.ATA_DERIVED_GROSS) {
    const count = BigInt(group.count)
    return {
      reliability: derived.reliability,
      numerator: derived.numerator * count,
      denominator: derived.denominator,
      micro: derived.micro == null ? null : derived.micro * count,
      qualified: derived.qualified,
      qualification: derived.qualification,
      bundles: derived.bundles,
    }
  }
  // A recorded tare that cannot support the proportional model does not fall back to a precise figure.
  if (group.tareMicro != null) {
    return { reliability: RELIABILITY.UNKNOWN, micro: null, qualified: false, qualification: null, reason: derived.reason }
  }
  if (group.grossWeightKnown) {
    return {
      reliability: RELIABILITY.GROSS_PACKING_ALLOWANCE,
      micro: BigInt(group.weightMicro) * BigInt(group.count),
      qualified: false,
      qualification: null,
    }
  }
  return { reliability: RELIABILITY.UNKNOWN, micro: null, qualified: false, qualification: null, reason: derived.reason }
}

const RELIABILITY_RANK = {
  [RELIABILITY.UNKNOWN]: 0,
  [RELIABILITY.GROSS_PACKING_ALLOWANCE]: 1,
  [RELIABILITY.ATA_DERIVED_GROSS]: 2,
  [RELIABILITY.ATA_FULL_PACK]: 3,
  [RELIABILITY.MEASURED]: 4,
}

function decorate(groups, quantity, role, catalogInconsistent) {
  const parts = groups.map(groupContent)
  let weakest = parts.reduce((lowest, part) => (
    RELIABILITY_RANK[part.reliability] < RELIABILITY_RANK[lowest] ? part.reliability : lowest
  ), RELIABILITY.MEASURED)
  const measuredParts = parts.filter((part) => part.reliability === RELIABILITY.MEASURED).length
  if (measuredParts > 0 && measuredParts !== parts.length) {
    weakest = RELIABILITY.UNKNOWN
  }
  const partial = groups.some((group) => !group.full)
  const summed = parts.every((part) => part.micro != null)
    ? parts.reduce((sum, part) => sum + part.micro, 0n)
    : null
  const rational = parts.every((part) => part.numerator != null || part.micro != null)
    ? parts.reduce((total, part) => addRational(total, part.numerator != null
      ? { numerator: part.numerator, denominator: part.denominator }
      : { numerator: part.micro, denominator: 1n }), null)
    : null
  const fullPack = weakest === RELIABILITY.ATA_FULL_PACK
  const derived = weakest === RELIABILITY.ATA_DERIVED_GROSS
  const allowance = weakest === RELIABILITY.GROSS_PACKING_ALLOWANCE
  const measured = weakest === RELIABILITY.MEASURED
  const weightState = fullPack ? 'calculated' : (partial ? 'unknown-partial' : 'unknown-weight')
  const fingerprintRules = groups.map((group) => ({
    id: group.id,
    piecesPerUnit: group.piecesPerUnit,
    unitName: group.unitName,
    weightMicro: group.weightMicro,
    tareMicro: group.tareMicro || '',
    count: group.count,
  }))
  let missingInformation = null
  if (derived) {
    missingInformation = 'Derived from the empty-box tare and the net content. It is not a scale measurement.'
  } else if (partial) {
    missingInformation = 'ATA records the full pack weight, not the weight of a partly filled pack. The planning allowance uses that full gross weight and is not a confirmed weight.'
  } else if (!fullPack) {
    missingInformation = 'ATA does not have a confirmed weight for every pack in this plan.'
  }
  const qualification = parts.find((part) => part.qualification)?.qualification || null
  return {
    role,
    origin: role === 'automatic' ? 'Automatic packing' : 'Labels / ATA',
    exact: weightState === 'calculated',
    boxes: groups,
    boxCount: groups.reduce((sum, group) => sum + group.count, 0),
    coveredPieces: quantity,
    unfilledPieces: groups.reduce((sum, group) => sum + group.unfilled, 0),
    calculatedMicro: fullPack && summed != null ? summed : 0n,
    derivedMicro: derived && rational && rational.numerator % rational.denominator === 0n
      ? rational.numerator / rational.denominator
      : null,
    derivedNumerator: derived && rational ? rational.numerator : null,
    derivedDenominator: derived && rational ? rational.denominator : null,
    measuredMicro: measured && summed != null ? summed : null,
    planningAllowanceMicro: allowance && summed != null && summed > 0n ? summed : null,
    reliability: weakest,
    qualified: Boolean(qualification),
    qualification,
    bundles: parts.find((part) => part.bundles)?.bundles || null,
    catalogInconsistent: Boolean(catalogInconsistent),
    weightState,
    missingInformation,
    fingerprint: { quantity, rules: fingerprintRules },
    signature: fingerprintRules.map((rule) => `${rule.id}:${rule.count}`).join('|'),
    physicalSignature: groups
      .map((group) => `${group.piecesPerUnit}:${group.count}:${group.piecesEach}:${group.full}:${group.weightMicro}`)
      .join('|'),
  }
}

function exactCombinations(rules, quantity) {
  const found = []
  const counts = rules.map(() => 0)
  let nodes = 0
  let truncated = false
  function walk(index, remaining, boxes) {
    if (nodes > PACKING_PLAN_LIMITS.maxNodes) {
      truncated = true
      return
    }
    nodes += 1
    if (remaining === 0) {
      found.push(counts.slice())
      return
    }
    if (index >= rules.length || boxes >= PACKING_PLAN_LIMITS.maxBoxes) {
      return
    }
    const capacity = rules[index].piecesPerUnit
    const maxCount = Math.min(
      Math.floor(remaining / capacity),
      PACKING_PLAN_LIMITS.maxBoxes - boxes,
    )
    for (let count = maxCount; count >= 0; count -= 1) {
      counts[index] = count
      walk(index + 1, remaining - count * capacity, boxes + count)
    }
    counts[index] = 0
  }
  walk(0, quantity, 0)
  return { found, truncated }
}

function countsToGroups(rules, counts) {
  return rules
    .map((rule, index) => (counts[index] > 0 ? boxGroup(rule, counts[index], rule.piecesPerUnit, true) : null))
    .filter(Boolean)
}

function chooseAutomatic(rules, quantity) {
  const exact = exactCombinations(rules, quantity)
  if (exact.found.length) {
    const ranked = exact.found.slice().sort((left, right) => {
      const leftBoxes = left.reduce((sum, count) => sum + count, 0)
      const rightBoxes = right.reduce((sum, count) => sum + count, 0)
      if (leftBoxes !== rightBoxes) {
        return leftBoxes - rightBoxes
      }
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
          return right[index] - left[index]
        }
      }
      return 0
    })
    const groups = countsToGroups(rules, ranked[0])
    if (groups.length) {
      return groups
    }
  }
  const tightest = rules
    .filter((rule) => rule.piecesPerUnit >= quantity)
    .sort((left, right) => left.piecesPerUnit - right.piecesPerUnit || String(left.id).localeCompare(String(right.id)))
  if (tightest.length) {
    const rule = tightest[0]
    return [boxGroup(rule, 1, quantity, rule.piecesPerUnit === quantity)]
  }
  const largest = rules[0]
  const fullCount = Math.floor(quantity / largest.piecesPerUnit)
  const remainder = quantity % largest.piecesPerUnit
  const groups = []
  if (fullCount > 0) {
    groups.push(boxGroup(largest, fullCount, largest.piecesPerUnit, true))
  }
  if (remainder > 0) {
    const holder = rules
      .filter((rule) => rule.piecesPerUnit >= remainder)
      .sort((left, right) => left.piecesPerUnit - right.piecesPerUnit || String(left.id).localeCompare(String(right.id)))[0]
    if (!holder) {
      return null
    }
    groups.push(boxGroup(holder, 1, remainder, false))
  }
  if (!groups.length) {
    return null
  }
  return groups
}

export function planPacking({ quantity, rules }) {
  const qty = Number(quantity)
  const empty = {
    priority: PACKING_PRIORITY,
    policy: AUTOMATIC_PACKING_POLICY,
    plans: [],
    automatic: null,
    catalogInconsistent: false,
    truncated: false,
    truncation: [],
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return empty
  }
  const source = Array.isArray(rules) ? rules : []
  const productName = source.find((rule) => rule && rule.name)?.name
  const matched = source
    .filter((rule) => rule && productKey(rule.name) === productKey(productName) && containerRule(rule))
    .sort((left, right) => (
      right.piecesPerUnit - left.piecesPerUnit
      || String(left.id).localeCompare(String(right.id))
    ))
  const usable = matched.slice(0, PACKING_PLAN_LIMITS.maxRules)
  const limits = {
    rules: matched.length > usable.length,
    search: false,
    plans: false,
    boxes: false,
    labels: false,
  }
  if (!usable.length) {
    return empty
  }
  const selected = labelsRuleFor(usable)
  if (!selected) {
    return empty
  }
  const consistency = comparePackNets(usable)
  const plans = []
  const seen = new Set()
  function add(groups, role) {
    if (!groups.length) {
      return
    }
    const plan = decorate(groups, qty, role, consistency.inconsistent)
    if (!plan.signature || seen.has(plan.signature) || seen.has(plan.physicalSignature)) {
      return
    }
    if (plan.boxCount > PACKING_PLAN_LIMITS.maxBoxes) {
      limits.boxes = true
      return
    }
    if (plans.length >= PACKING_PLAN_LIMITS.maxPlans) {
      limits.plans = true
      return
    }
    seen.add(plan.signature)
    seen.add(plan.physicalSignature)
    plans.push(plan)
  }
  const selectedSplit = splitQuantity(qty, selected.piecesPerUnit)
  if (selectedSplit.truncated) {
    limits.labels = true
  } else {
    add(groupsFromSplit(selected, selectedSplit), 'suggestion')
  }
  const combinations = exactCombinations(usable, qty)
  limits.search = combinations.truncated
  for (const counts of combinations.found) {
    const groups = usable
      .map((rule, index) => (counts[index] > 0 ? boxGroup(rule, counts[index], rule.piecesPerUnit, true) : null))
      .filter(Boolean)
    add(groups, 'alternative')
  }
  if (!plans.some((plan) => plan.exact)) {
    for (const rule of usable) {
      if (rule.id === selected.id) {
        continue
      }
      const split = splitQuantity(qty, rule.piecesPerUnit)
      if (split.truncated) {
        limits.labels = true
        continue
      }
      add(groupsFromSplit(rule, split), 'alternative')
    }
  }
  const automaticGroups = chooseAutomatic(usable, qty)
  let automatic = null
  if (automaticGroups) {
    const candidate = decorate(automaticGroups, qty, 'automatic', consistency.inconsistent)
    automatic = plans.find((plan) => (
      plan.signature === candidate.signature || plan.physicalSignature === candidate.physicalSignature
    )) || candidate
  }
  const truncation = []
  if (limits.rules) truncation.push('Some packing rules were omitted because the rule limit was reached.')
  if (limits.search) truncation.push('The combination search stopped at its step limit.')
  if (limits.plans) truncation.push('Some exact combinations are not listed because the plan limit was reached.')
  if (limits.boxes) truncation.push('A combination was omitted because it needs more boxes than the limit.')
  if (limits.labels) truncation.push('The Labels split was not listed because it needs more boxes than the limit.')
  return {
    priority: PACKING_PRIORITY,
    policy: AUTOMATIC_PACKING_POLICY,
    plans,
    automatic,
    catalogInconsistent: consistency.inconsistent,
    truncated: truncation.length > 0,
    truncation,
  }
}

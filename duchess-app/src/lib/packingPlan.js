import {
  buildAtaCapacityMap,
  generateLabelsForQuantity,
  resolveJobItemRule,
} from './labelGenerator'

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

function boxGroup(rule, count, piecesEach, full) {
  return {
    id: String(rule.id),
    piecesPerUnit: rule.piecesPerUnit,
    unitName: rule.unitName,
    count,
    piecesEach,
    full,
    unfilled: full ? 0 : rule.piecesPerUnit - piecesEach,
    weightMicro: rule.weightMicro == null ? '0' : rule.weightMicro.toString(),
    weightKnown: full && weightKnown(rule),
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

function decorate(groups, quantity, role) {
  const fullGroups = groups.filter((group) => group.full)
  const partial = groups.some((group) => !group.full)
  const unknownFull = fullGroups.some((group) => !group.weightKnown)
  const calculatedMicro = unknownFull
    ? 0n
    : fullGroups.reduce((sum, group) => sum + BigInt(group.count) * BigInt(group.weightMicro), 0n)
  const weightState = partial ? 'unknown-partial' : (unknownFull ? 'unknown-weight' : 'calculated')
  const fingerprintRules = groups.map((group) => ({
    id: group.id,
    piecesPerUnit: group.piecesPerUnit,
    unitName: group.unitName,
    weightMicro: group.weightMicro,
    count: group.count,
  }))
  return {
    role,
    origin: 'Labels / ATA',
    exact: !partial && !unknownFull,
    boxes: groups,
    boxCount: groups.reduce((sum, group) => sum + group.count, 0),
    coveredPieces: quantity,
    unfilledPieces: groups.reduce((sum, group) => sum + group.unfilled, 0),
    calculatedMicro,
    weightState,
    missingInformation: partial
      ? 'ATA records the full pack weight, not the weight of a partly filled pack.'
      : (unknownFull ? 'ATA does not have a confirmed weight for every pack in this plan.' : null),
    fingerprint: { quantity, rules: fingerprintRules },
    signature: fingerprintRules.map((rule) => `${rule.id}:${rule.count}`).join('|'),
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

export function planPacking({ quantity, rules }) {
  const qty = Number(quantity)
  const empty = { priority: PACKING_PRIORITY, plans: [], truncated: false, truncation: [] }
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
  const plans = []
  const seen = new Set()
  function add(groups, role) {
    if (!groups.length) {
      return
    }
    const plan = decorate(groups, qty, role)
    if (!plan.signature || seen.has(plan.signature)) {
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
  const truncation = []
  if (limits.rules) truncation.push('Some packing rules were omitted because the rule limit was reached.')
  if (limits.search) truncation.push('The combination search stopped at its step limit.')
  if (limits.plans) truncation.push('Some exact combinations are not listed because the plan limit was reached.')
  if (limits.boxes) truncation.push('A combination was omitted because it needs more boxes than the limit.')
  if (limits.labels) truncation.push('The Labels split was not listed because it needs more boxes than the limit.')
  return { priority: PACKING_PRIORITY, plans, truncated: truncation.length > 0, truncation }
}

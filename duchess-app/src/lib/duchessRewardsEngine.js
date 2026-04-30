export const DEFAULT_POINT_VALUE_PENCE = 0.5
export const DEFAULT_BASE_REWARD_PERCENT = 3
export const DEFAULT_AVAILABILITY_DELAY_DAYS = 3

const DEFAULT_LINEN_BONUS_PERCENT = 20
const DEFAULT_CHAIR_BONUS_PERCENT = 15
const DEFAULT_FURNITURE_BONUS_PERCENT = 15

const CLEAR_NON_BONUS_CATEGORY_SIGNALS = [
  'crockery',
  'cutlery',
  'glassware',
  'service',
  'fee',
  'transport',
  'admin',
  'stationery',
  'floristry',
]

const CLEAR_NON_BONUS_NAME_SIGNALS = [
  'plate',
  'glass',
  'fork',
  'knife',
  'spoon',
  'charger',
  'delivery fee',
  'collection fee',
  'transport fee',
  'service fee',
  'admin fee',
]

const LINEN_SIGNALS = ['linen', 'linens', 'tablecloth', 'napkin']
const CHAIR_SIGNALS = ['chair', 'chairs', 'chaivari', 'chiavari', 'dining chair']
const FURNITURE_CATEGORY_SIGNALS = ['furniture', 'lounge', 'sofa']
const FURNITURE_NAME_SIGNALS = [
  'furniture',
  'sofa',
  'lounge',
  'armchair',
  'bench',
  'stool',
  'ottoman',
  'pouf',
  'dining table',
  'coffee table',
  'side table',
  'console table',
  'banquet table',
  'trestle table',
]
const FURNITURE_TABLE_EXCLUSIONS = ['tablecloth', 'table lamp']

function normalizeText(value) {
  if (typeof value !== 'string') return ''

  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeBoolean(value) {
  return value === true
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toNonNegativeInteger(value) {
  const parsed = Math.floor(toFiniteNumber(value, 0))
  return parsed > 0 ? parsed : 0
}

function normalizePercent(value, fallback) {
  const parsed = toFiniteNumber(value, fallback)
  return parsed >= 0 ? parsed : fallback
}

function normalizePointValuePence(value) {
  const parsed = toFiniteNumber(value, DEFAULT_POINT_VALUE_PENCE)
  return parsed > 0 ? parsed : DEFAULT_POINT_VALUE_PENCE
}

function includesSignal(text, signals) {
  return signals.some((signal) => text.includes(signal))
}

function includesWholeWord(text, word) {
  return ` ${text} `.includes(` ${word} `)
}

function buildSettings(settings = {}) {
  return {
    pointValuePence: normalizePointValuePence(settings.pointValuePence),
    baseRewardPercent: normalizePercent(settings.baseRewardPercent, DEFAULT_BASE_REWARD_PERCENT),
    linenBonusPercent: normalizePercent(settings.linenBonusPercent, DEFAULT_LINEN_BONUS_PERCENT),
    chairBonusPercent: normalizePercent(settings.chairBonusPercent, DEFAULT_CHAIR_BONUS_PERCENT),
    furnitureBonusPercent: normalizePercent(settings.furnitureBonusPercent, DEFAULT_FURNITURE_BONUS_PERCENT),
    availabilityDelayDays: Math.max(
      0,
      Math.floor(toFiniteNumber(settings.availabilityDelayDays, DEFAULT_AVAILABILITY_DELAY_DAYS))
    ),
  }
}

function normalizeCategoryFlags(categoryFlags = {}) {
  return {
    hasLinen: normalizeBoolean(categoryFlags.hasLinen),
    hasChairs: normalizeBoolean(categoryFlags.hasChairs),
    hasFurniture: normalizeBoolean(categoryFlags.hasFurniture),
    needsAttention: normalizeBoolean(categoryFlags.needsAttention),
    needsAttentionReasons: Array.isArray(categoryFlags.needsAttentionReasons)
      ? categoryFlags.needsAttentionReasons.filter(Boolean)
      : [],
  }
}

function calculatePercentOfPoints(basePoints, percent) {
  if (basePoints <= 0 || percent <= 0) return 0
  return Math.floor((basePoints * percent) / 100)
}

function toDateFromYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  const day = Number(match[3])
  const candidate = new Date(Date.UTC(year, monthIndex, day))

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== monthIndex ||
    candidate.getUTCDate() !== day
  ) {
    return null
  }

  return candidate
}

function dedupeReasons(reasons) {
  return Array.from(new Set(reasons.filter(Boolean)))
}

export function calculateBasePoints({
  eligibleValuePence,
  baseRewardPercent = DEFAULT_BASE_REWARD_PERCENT,
  pointValuePence = DEFAULT_POINT_VALUE_PENCE,
} = {}) {
  const safeEligibleValuePence = toNonNegativeInteger(eligibleValuePence)
  const safeBaseRewardPercent = normalizePercent(baseRewardPercent, DEFAULT_BASE_REWARD_PERCENT)
  const safePointValuePence = normalizePointValuePence(pointValuePence)

  // Use Math.floor so MVP suggestions never over-credit points.
  const rewardValuePence = (safeEligibleValuePence * safeBaseRewardPercent) / 100
  return Math.floor(rewardValuePence / safePointValuePence)
}

export function calculateBonusPoints({
  basePoints,
  hasLinen,
  hasChairs,
  hasFurniture,
  linenBonusPercent = DEFAULT_LINEN_BONUS_PERCENT,
  chairBonusPercent = DEFAULT_CHAIR_BONUS_PERCENT,
  furnitureBonusPercent = DEFAULT_FURNITURE_BONUS_PERCENT,
} = {}) {
  const safeBasePoints = toNonNegativeInteger(basePoints)
  const linen = normalizeBoolean(hasLinen)
    ? calculatePercentOfPoints(safeBasePoints, normalizePercent(linenBonusPercent, DEFAULT_LINEN_BONUS_PERCENT))
    : 0
  const chairs = normalizeBoolean(hasChairs)
    ? calculatePercentOfPoints(safeBasePoints, normalizePercent(chairBonusPercent, DEFAULT_CHAIR_BONUS_PERCENT))
    : 0
  const furniture = normalizeBoolean(hasFurniture)
    ? calculatePercentOfPoints(
      safeBasePoints,
      normalizePercent(furnitureBonusPercent, DEFAULT_FURNITURE_BONUS_PERCENT)
    )
    : 0

  return {
    linen,
    chairs,
    furniture,
    totalBonusPoints: linen + chairs + furniture,
  }
}

export function calculateRewardValuePence({
  points,
  pointValuePence = DEFAULT_POINT_VALUE_PENCE,
} = {}) {
  const safePoints = Math.trunc(toFiniteNumber(points, 0))
  const safePointValuePence = normalizePointValuePence(pointValuePence)

  // Round to the nearest whole penny because the schema stores integer pence snapshots.
  return Math.round(safePoints * safePointValuePence)
}

export function calculateSuggestedReward({
  eligibleValuePence,
  categoryFlags,
  settings,
} = {}) {
  const safeSettings = buildSettings(settings)
  const safeCategoryFlags = normalizeCategoryFlags(categoryFlags)
  const needsAttentionReasons = [...safeCategoryFlags.needsAttentionReasons]

  if (safeCategoryFlags.needsAttention && needsAttentionReasons.length === 0) {
    needsAttentionReasons.push('Category classification needs manual review.')
  }

  const rawEligibleValuePence = Number(eligibleValuePence)
  if (!Number.isFinite(rawEligibleValuePence) || rawEligibleValuePence < 0) {
    needsAttentionReasons.push('Eligible order value was missing or invalid.')
  }

  const safeEligibleValuePence = toNonNegativeInteger(eligibleValuePence)
  const basePoints = calculateBasePoints({
    eligibleValuePence: safeEligibleValuePence,
    baseRewardPercent: safeSettings.baseRewardPercent,
    pointValuePence: safeSettings.pointValuePence,
  })

  const bonuses = calculateBonusPoints({
    basePoints,
    hasLinen: safeCategoryFlags.hasLinen,
    hasChairs: safeCategoryFlags.hasChairs,
    hasFurniture: safeCategoryFlags.hasFurniture,
    linenBonusPercent: safeSettings.linenBonusPercent,
    chairBonusPercent: safeSettings.chairBonusPercent,
    furnitureBonusPercent: safeSettings.furnitureBonusPercent,
  })

  const totalPoints = basePoints + bonuses.totalBonusPoints
  const rewardValuePence = calculateRewardValuePence({
    points: totalPoints,
    pointValuePence: safeSettings.pointValuePence,
  })

  const dedupedNeedsAttentionReasons = dedupeReasons(needsAttentionReasons)

  return {
    basePoints,
    bonuses,
    totalPoints,
    rewardValuePence,
    needsAttention: dedupedNeedsAttentionReasons.length > 0,
    needsAttentionReasons: dedupedNeedsAttentionReasons,
    calculationSnapshot: {
      eligibleValuePence: safeEligibleValuePence,
      categoryFlags: {
        hasLinen: safeCategoryFlags.hasLinen,
        hasChairs: safeCategoryFlags.hasChairs,
        hasFurniture: safeCategoryFlags.hasFurniture,
      },
      settingsUsed: safeSettings,
      roundingRules: {
        basePoints: 'floor',
        bonusPoints: 'floor',
        rewardValuePence: 'round',
      },
      outputs: {
        basePoints,
        bonusPoints: bonuses.totalBonusPoints,
        totalPoints,
        rewardValuePence,
      },
    },
  }
}

export function getAvailableAtFromEventDate(eventDate, delayDays = DEFAULT_AVAILABILITY_DELAY_DAYS) {
  const safeDelayDays = Math.max(0, Math.floor(toFiniteNumber(delayDays, DEFAULT_AVAILABILITY_DELAY_DAYS)))

  let safeDate = null

  if (typeof eventDate === 'string') {
    safeDate = toDateFromYmd(eventDate) || new Date(eventDate)
  } else if (eventDate instanceof Date) {
    safeDate = new Date(eventDate.getTime())
  }

  if (!(safeDate instanceof Date) || Number.isNaN(safeDate.getTime())) {
    return null
  }

  const availableAt = new Date(Date.UTC(
    safeDate.getUTCFullYear(),
    safeDate.getUTCMonth(),
    safeDate.getUTCDate()
  ))
  availableAt.setUTCDate(availableAt.getUTCDate() + safeDelayDays)

  return availableAt.toISOString()
}

export function classifyRewardCategoriesFromItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      hasLinen: false,
      hasChairs: false,
      hasFurniture: false,
      needsAttention: true,
      needsAttentionReasons: ['No items were provided for Duchess Rewards classification.'],
    }
  }

  const needsAttentionReasons = []
  let hasLinen = false
  let hasChairs = false
  let hasFurniture = false

  items.forEach((item, index) => {
    const category = normalizeText(item?.category)
    const itemName = normalizeText(item?.item_name || item?.name)
    const itemLabel = itemName || category || `item ${index + 1}`

    if (!category && !itemName) {
      needsAttentionReasons.push(`Item ${index + 1} is missing both category and item_name.`)
      return
    }

    if (includesSignal(category, LINEN_SIGNALS) || includesSignal(itemName, LINEN_SIGNALS)) {
      hasLinen = true
      return
    }

    if (includesSignal(category, CHAIR_SIGNALS) || includesSignal(itemName, CHAIR_SIGNALS)) {
      hasChairs = true
      return
    }

    const hasTableKeyword = includesWholeWord(itemName, 'table') && !includesSignal(itemName, FURNITURE_TABLE_EXCLUSIONS)
    const hasFurnitureCategoryKeyword =
      includesSignal(category, FURNITURE_CATEGORY_SIGNALS) ||
      includesWholeWord(category, 'table') ||
      includesWholeWord(category, 'tables')

    if (hasFurnitureCategoryKeyword || includesSignal(itemName, FURNITURE_NAME_SIGNALS) || hasTableKeyword) {
      hasFurniture = true
      return
    }

    const clearlyNonBonusCategory = includesSignal(category, CLEAR_NON_BONUS_CATEGORY_SIGNALS)
    const clearlyNonBonusName = includesSignal(itemName, CLEAR_NON_BONUS_NAME_SIGNALS)

    if (!category) {
      needsAttentionReasons.push(`${itemLabel} is missing category and did not match a strategic bonus keyword.`)
      return
    }

    if (
      !clearlyNonBonusCategory &&
      !clearlyNonBonusName &&
      ['other', 'misc', 'miscellaneous', 'unknown', 'uncategorised', 'uncategorized'].includes(category)
    ) {
      needsAttentionReasons.push(`${itemLabel} uses an unclear category for rewards classification.`)
    }
  })

  const dedupedNeedsAttentionReasons = dedupeReasons(needsAttentionReasons)

  return {
    hasLinen,
    hasChairs,
    hasFurniture,
    needsAttention: dedupedNeedsAttentionReasons.length > 0,
    needsAttentionReasons: dedupedNeedsAttentionReasons,
  }
}

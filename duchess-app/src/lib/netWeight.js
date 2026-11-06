// Integer weights use the same unit as the order catalog: 1 kg = 1_000_000.
// That unit is 1 milligram. Values stay as integers until display.

export const RELIABILITY = Object.freeze({
  ATA_FULL_PACK: 'ATA_FULL_PACK',
  ATA_DERIVED_GROSS: 'ATA_DERIVED_GROSS',
  GROSS_PACKING_ALLOWANCE: 'GROSS_PACKING_ALLOWANCE',
  UNKNOWN: 'UNKNOWN',
  MEASURED: 'MEASURED',
})

// One gram. A smaller gap is the catalog's 0.001 kg recording precision.
export const MATERIAL_PIECE_MICRO = 1000n

export const AUTOMATIC_PACKING_POLICY = 'Exact full packs with the fewest boxes, larger capacities first. Otherwise the smallest box that holds the quantity. Otherwise full boxes of the largest capacity and the remainder in the smallest box that holds it. Calculated weight does not choose the plan.'

export function bundleSplit(pieces, bundlePieces) {
  if (!Number.isInteger(pieces) || pieces < 0) {
    return { fullBundles: 0, extraPieces: 0, bundlePieces: null }
  }
  if (!Number.isInteger(bundlePieces) || bundlePieces <= 1) {
    return { fullBundles: 0, extraPieces: pieces, bundlePieces: null }
  }
  return {
    fullBundles: Math.floor(pieces / bundlePieces),
    extraPieces: pieces % bundlePieces,
    bundlePieces,
  }
}

function unsupported(reason, extra = {}) {
  return {
    reliability: RELIABILITY.UNKNOWN,
    micro: null,
    qualified: false,
    qualification: null,
    reason,
    bundles: null,
    ...extra,
  }
}

export function gcdBig(left, right) {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b !== 0n) {
    const next = a % b
    a = b
    b = next
  }
  return a > 0n ? a : 1n
}

export function reduceRational(numerator, denominator) {
  const divisor = gcdBig(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

export function addRational(left, right) {
  if (!left) return right
  if (!right) return left
  return reduceRational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  )
}

// The full gross already includes the piece mass and the packaging that was
// inside that weighed box. Only partialOnlyPackagingMicro is extra, and only
// for a partly filled box. An unspecified additional mass is not added.
export function deriveContentWeight({
  fullGrossMicro = null,
  tareMicro = null,
  capacity = null,
  pieces = null,
  bundlePieces = null,
  additionalPackagingMicro = null,
  partialOnlyPackagingMicro = null,
  measuredMicro = null,
} = {}) {
  if (typeof measuredMicro === 'bigint' && measuredMicro > 0n) {
    return {
      reliability: RELIABILITY.MEASURED,
      micro: measuredMicro,
      qualified: false,
      qualification: null,
      reason: null,
      bundles: bundleSplit(pieces, bundlePieces),
    }
  }
  if (!Number.isInteger(capacity) || capacity <= 0 || !Number.isInteger(pieces) || pieces <= 0 || pieces > capacity) {
    return unsupported('invalid-quantity')
  }
  if (typeof fullGrossMicro !== 'bigint' || fullGrossMicro <= 0n) {
    return unsupported('missing-gross')
  }
  if (pieces === capacity) {
    return {
      reliability: RELIABILITY.ATA_FULL_PACK,
      micro: fullGrossMicro,
      qualified: false,
      qualification: null,
      reason: null,
      bundles: bundleSplit(pieces, bundlePieces),
    }
  }
  if (typeof tareMicro !== 'bigint') {
    return unsupported('missing-tare')
  }
  if (tareMicro < 0n || tareMicro >= fullGrossMicro) {
    return unsupported('invalid-tare')
  }
  const net = fullGrossMicro - tareMicro
  const capacityDenominator = BigInt(capacity)
  let numerator = tareMicro * capacityDenominator + BigInt(pieces) * net
  let denominator = capacityDenominator
  const bundles = bundleSplit(pieces, bundlePieces)
  let qualified = false
  let qualification = null
  const exclusive = typeof partialOnlyPackagingMicro === 'bigint' && partialOnlyPackagingMicro > 0n
  if (exclusive) {
    numerator += partialOnlyPackagingMicro * denominator
  } else if (typeof additionalPackagingMicro === 'bigint' && additionalPackagingMicro > 0n) {
    qualified = true
    qualification = 'additional-material-not-separated'
  } else if (bundles.bundlePieces && bundles.extraPieces > 0 && additionalPackagingMicro == null && partialOnlyPackagingMicro == null) {
    qualified = true
    qualification = 'partial-bundle-packaging-unrecorded'
  }
  const reduced = reduceRational(numerator, denominator)
  return {
    reliability: RELIABILITY.ATA_DERIVED_GROSS,
    numerator: reduced.numerator,
    denominator: reduced.denominator,
    micro: reduced.numerator % reduced.denominator === 0n ? reduced.numerator / reduced.denominator : null,
    qualified,
    qualification,
    reason: null,
    bundles,
    netPerPieceNumerator: net,
    netPerPieceDenominator: capacityDenominator,
  }
}

export function comparePackNets(rules) {
  const nets = []
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (typeof rule?.tareMicro !== 'bigint' || typeof rule?.weightMicro !== 'bigint') {
      continue
    }
    if (rule.tareMicro < 0n || rule.tareMicro >= rule.weightMicro || !(rule.piecesPerUnit > 0)) {
      continue
    }
    nets.push({
      id: String(rule.id),
      piecesPerUnit: rule.piecesPerUnit,
      numerator: rule.weightMicro - rule.tareMicro,
      denominator: BigInt(rule.piecesPerUnit),
    })
  }
  let inconsistent = false
  for (let left = 0; left < nets.length; left += 1) {
    for (let right = left + 1; right < nets.length; right += 1) {
      const first = nets[left]
      const second = nets[right]
      const difference = first.numerator * second.denominator - second.numerator * first.denominator
      const gap = difference < 0n ? -difference : difference
      const limit = MATERIAL_PIECE_MICRO * first.denominator * second.denominator
      if (gap > limit) {
        inconsistent = true
      }
    }
  }
  return { inconsistent, nets }
}

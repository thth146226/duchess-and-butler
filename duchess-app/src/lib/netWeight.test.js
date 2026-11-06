import { DISPLAY_ROUNDING, assessOrderWeight, formatKilograms, presentOrderWeight } from './orderWeight'
import { planPacking } from './packingPlan'
import { comparePackNets, deriveContentWeight } from './netWeight'

// Synthetic catalog only. These figures must never be written to ATA.
const GROSS = 10000000n
const TARE = 300000n

function fork(overrides = {}) {
  return {
    id: 'fork-100',
    name: 'Synthetic Dinner Fork',
    unit_name: 'box',
    pieces_per_unit: 100,
    weight_per_unit: '10',
    tare_kg: '0.3',
    bundle_pieces: 10,
    additional_packaging_kg: '0',
    active: true,
    ...overrides,
  }
}

function line(quantity) {
  return {
    id: 'fork',
    item_name: 'Synthetic Dinner Fork',
    quantity,
    opportunity_item_type_name: 'Principal',
    transaction_type_name: 'Rental',
  }
}

describe('synthetic net weight', () => {
  test('derives the partial gross without rounding and recognises a partial bundle', () => {
    const cases = [
      [50, 5150000n, '5.15'],
      [80, 8060000n, '8.06'],
      [85, 8545000n, '8.545'],
      [100, 10000000n, '10'],
    ]
    for (const [pieces, micro, text] of cases) {
      const derived = deriveContentWeight({
        fullGrossMicro: GROSS,
        tareMicro: TARE,
        capacity: 100,
        pieces,
        bundlePieces: 10,
        additionalPackagingMicro: 0n,
      })
      expect(derived.micro).toBe(micro)
      expect(formatKilograms(derived.micro)).toBe(text)
      expect(derived.qualified).toBe(false)
    }
    const partial = deriveContentWeight({
      fullGrossMicro: GROSS,
      tareMicro: TARE,
      capacity: 100,
      pieces: 85,
      bundlePieces: 10,
      additionalPackagingMicro: 0n,
    })
    expect(partial.bundles).toEqual({ fullBundles: 8, extraPieces: 5, bundlePieces: 10 })
    expect(partial.reliability).toBe('ATA_DERIVED_GROSS')
    const qualified = deriveContentWeight({
      fullGrossMicro: GROSS,
      tareMicro: TARE,
      capacity: 100,
      pieces: 85,
      bundlePieces: 10,
      additionalPackagingMicro: null,
    })
    expect(qualified.micro).toBe(8545000n)
    expect(qualified.qualified).toBe(true)
    const withBag = deriveContentWeight({
      fullGrossMicro: GROSS,
      tareMicro: TARE,
      capacity: 100,
      pieces: 85,
      bundlePieces: 10,
      additionalPackagingMicro: 50000n,
    })
    expect(withBag.micro).toBe(8545000n)
    expect(withBag.qualified).toBe(true)
    expect(withBag.qualification).toBe('additional-material-not-separated')
    const exclusive = deriveContentWeight({
      fullGrossMicro: GROSS,
      tareMicro: TARE,
      capacity: 100,
      pieces: 85,
      bundlePieces: 10,
      partialOnlyPackagingMicro: 50000n,
    })
    expect(exclusive.micro).toBe(8595000n)
    expect(exclusive.qualified).toBe(false)
    const full = deriveContentWeight({
      fullGrossMicro: GROSS,
      tareMicro: TARE,
      capacity: 100,
      pieces: 100,
      partialOnlyPackagingMicro: 50000n,
    })
    expect(full.micro).toBe(GROSS)
    expect(full.reliability).toBe('ATA_FULL_PACK')
  })

  test('keeps a fractional net exact until the displayed kilogram', () => {
    expect(DISPLAY_ROUNDING).toContain('0.001 kg')
    expect(formatKilograms(500n)).toBe('0.001')
    expect(formatKilograms(499n)).toBe('0')
    expect(formatKilograms(1500n)).toBe('0.002')
    expect(formatKilograms(8545000n)).toBe('8.545')
    const fractional = deriveContentWeight({
      fullGrossMicro: GROSS,
      tareMicro: TARE,
      capacity: 90,
      pieces: 85,
    })
    expect(fractional.reliability).toBe('ATA_DERIVED_GROSS')
    expect(fractional.micro).toBeNull()
    expect(fractional.numerator % fractional.denominator).not.toBe(0n)
    expect(formatKilograms(fractional.numerator, fractional.denominator)).toBe('9.461')
    const assessed = assessOrderWeight([line(85)], [fork({ pieces_per_unit: 90 })])
    expect(assessed.lines[0].disposition).toBe('derived')
    expect(presentOrderWeight(assessed).derivedKg).toBe('9.461')
    expect(presentOrderWeight(assessed).estimateVehicles).toBeNull()
  })

  test('keeps disagreeing box nets separate and does not copy a tare', () => {
    const compared = comparePackNets([
      { id: 'hundred', piecesPerUnit: 100, weightMicro: GROSS, tareMicro: TARE },
      { id: 'fifty', piecesPerUnit: 50, weightMicro: 5500000n, tareMicro: TARE },
    ])
    expect(compared.inconsistent).toBe(true)
    const rows = [
      fork(),
      fork({
        id: 'fork-50',
        pieces_per_unit: 50,
        weight_per_unit: '5.5',
        tare_kg: '0.3',
      }),
    ]
    const eightyFive = assessOrderWeight([line(85)], rows)
    expect(eightyFive.lines[0].plan.catalogInconsistent).toBe(true)
    expect(eightyFive.lines[0].derivedMicro).toBe(8545000n)
    expect(eightyFive.knownMicro).toBe(0n)
    const twenty = assessOrderWeight([line(20)], rows)
    expect(twenty.lines[0].derivedMicro).toBe(2380000n)
    expect(twenty.lines[0].plan.boxes[0].piecesPerUnit).toBe(50)
    const copied = assessOrderWeight([line(20)], [
      fork(),
      fork({ id: 'fork-50', pieces_per_unit: 50, weight_per_unit: '5.5', tare_kg: null }),
    ])
    expect(copied.lines[0].disposition).toBe('partial_box')
    expect(copied.lines[0].derivedMicro).toBeUndefined()
    expect(formatKilograms(copied.planningMicro)).toBe('5.5')
  })

  test('automatic quantities stay out of the Luton recommendation', () => {
    const rows = [fork(), fork({ id: 'fork-50', pieces_per_unit: 50, weight_per_unit: '5', tare_kg: '0.15', additional_packaging_kg: '0' })]
    const quantities = [20, 50, 70, 80, 85, 95, 100, 150]
    for (const quantity of quantities) {
      const view = presentOrderWeight(assessOrderWeight([line(quantity)], rows))
      expect(view.estimateVehicles).toBeNull()
      expect(view.status === 'COMPLETE' || view.knownKg != null || view.derivedKg != null || view.planningKg != null).toBe(true)
    }
    const large = assessOrderWeight([line(1000)], rows)
    expect(large.lines[0].disposition).toBe('calculated')
    expect(large.lines[0].plan.boxes).toEqual([
      expect.objectContaining({ count: 10, piecesPerUnit: 100, full: true }),
    ])
    expect(formatKilograms(large.knownMicro)).toBe('100')
    expect(large.lines[0].configurationOpen).toBe(true)
    const heavy = assessOrderWeight([line(5000)], [
      fork({ weight_per_unit: '30' }),
      fork({ id: 'fork-50', pieces_per_unit: 50, weight_per_unit: '16', tare_kg: '0.2' }),
    ])
    const heavyView = presentOrderWeight(heavy)
    expect(heavy.lines[0].plan.boxCount).toBe(50)
    expect(heavyView.knownKg).toBe('1500')
    expect(heavyView.estimateVehicles).toBeNull()
    const onlyLarge = presentOrderWeight(assessOrderWeight([line(5000)], [fork({ weight_per_unit: '30', tare_kg: null })]))
    expect(onlyLarge.estimateVehicles).toBe(2)
    expect(planPacking({
      quantity: 85,
      rules: [{
        id: 'fork-100',
        name: 'Synthetic Dinner Fork',
        unitName: 'box',
        piecesPerUnit: 100,
        weightKind: 'positive',
        weightMicro: GROSS,
        tareMicro: TARE,
        bundlePieces: 10,
        additionalPackagingMicro: 0n,
      }],
    }).automatic.bundles.fullBundles).toBe(8)
  })

  test('an invalid tare does not become a precise derived weight', () => {
    const assessed = assessOrderWeight([line(85)], [fork({ tare_kg: '11' })])
    expect(assessed.lines[0].disposition).toBe('ambiguous')
    expect(assessed.derivedMicro).toBe(0n)
    expect(assessed.planningMicro).toBe(0n)
    expect(assessed.knownMicro).toBe(0n)
  })
})

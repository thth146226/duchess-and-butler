import { planPacking, PACKING_PRIORITY } from './packingPlan'
import { formatKilograms } from './orderWeight'

function rule(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    unitName: 'box',
    piecesPerUnit: overrides.piecesPerUnit,
    weightKind: 'positive',
    weightMicro: overrides.weightMicro,
    tareMicro: overrides.tareMicro,
  }
}

function formatPlanKg(plan) {
  return formatKilograms(plan.operationalNumerator, plan.operationalDenominator)
}

describe('shared packing plans', () => {
  test('Prima Dessert Plate keeps both exact capacities and does not treat fewer boxes as less weight', () => {
    const result = planPacking({
      quantity: 30,
      rules: [
        rule({ id: 'small', name: 'Prima Dessert Plate', piecesPerUnit: 15, weightMicro: 6300000n }),
        rule({ id: 'large', name: 'Prima Dessert Plate', piecesPerUnit: 30, weightMicro: 16100000n }),
        rule({ id: 'other', name: 'Prima Dinner Plate', piecesPerUnit: 15, weightMicro: 9000000n }),
      ],
    })
    expect(result.priority).toBe(PACKING_PRIORITY)
    expect(result.plans[0].role).toBe('suggestion')
    expect(result.plans[0].origin).toBe('Labels / ATA')
    expect(result.plans[0].exact).toBe(true)
    expect(result.plans[0].calculatedMicro).toBe(16100000n)
    expect(result.plans.some((plan) => plan.calculatedMicro === 12600000n)).toBe(true)
    expect(result.plans.some((plan) => plan.boxes.some((box) => box.id === 'other'))).toBe(false)
    expect(result.plans.every((plan) => plan.fingerprint.quantity === 30)).toBe(true)
  })

  test('charger-plate capacities can be combined without choosing the lightest plan', () => {
    const result = planPacking({
      quantity: 30,
      rules: [
        rule({ id: 'five', name: 'Synthetic Charger Plate', piecesPerUnit: 5, weightMicro: 2000000n }),
        rule({ id: 'ten', name: 'Synthetic Charger Plate', piecesPerUnit: 10, weightMicro: 5000000n }),
      ],
    })
    expect(result.plans[0].boxes).toEqual([
      expect.objectContaining({ id: 'ten', count: 3, full: true }),
    ])
    expect(result.plans[0].calculatedMicro).toBe(15000000n)
    const smallerBoxes = result.plans.find((plan) => plan.boxes.some((box) => box.id === 'five' && box.count === 6))
    expect(smallerBoxes.calculatedMicro).toBe(12000000n)
    expect(smallerBoxes.calculatedMicro < result.plans[0].calculatedMicro).toBe(true)
    expect(result.plans.length).toBeLessThanOrEqual(4)
  })

  test('a partial box keeps the empty space and withholds the full-box weight', () => {
    const result = planPacking({
      quantity: 16,
      rules: [rule({ id: 'box', name: 'Pearl Oval Platter 40cm', piecesPerUnit: 15, weightMicro: 2000000n })],
    })
    expect(result.plans).toHaveLength(1)
    expect(result.plans[0].exact).toBe(false)
    expect(result.plans[0].weightState).toBe('unknown-partial')
    expect(result.plans[0].reliability).toBe('ATA_PROPORTIONAL_ESTIMATE')
    expect(result.plans[0].calculatedMicro).toBe(2000000n)
    expect(result.plans[0].planningAllowanceMicro).toBe(4000000n)
    expect(result.plans[0].proportionalNumerator).toBe(400000n)
    expect(result.plans[0].proportionalDenominator).toBe(3n)
    expect(result.plans[0].unfilledPieces).toBe(14)
    expect(result.plans[0].missingInformation).toContain('partly filled')
    expect(result.plans[0].boxes.map((box) => [box.full, box.piecesEach, box.unfilled])).toEqual([
      [true, 15, 0],
      [false, 1, 14],
    ])
  })

  test('a search that passes a limit says that the list was cut', () => {
    const result = planPacking({
      quantity: 12,
      rules: [8, 7, 6, 5, 4, 3, 2, 1].map((pieces) => rule({
        id: `box-${pieces}`,
        name: 'Mixed Capacity Plate',
        piecesPerUnit: pieces,
        weightMicro: BigInt(pieces) * 1000000n,
      })),
    })
    expect(result.truncated).toBe(true)
    expect(result.plans.length).toBeLessThanOrEqual(4)
    expect(result.truncation.join(' ')).toContain('limit')
    const exact = planPacking({
      quantity: 30,
      rules: [
        rule({ id: 'small', name: 'Prima Dessert Plate', piecesPerUnit: 15, weightMicro: 6300000n }),
        rule({ id: 'large', name: 'Prima Dessert Plate', piecesPerUnit: 30, weightMicro: 16100000n }),
      ],
    })
    expect(exact.truncated).toBe(false)
    expect(exact.truncation).toEqual([])
  })

  test('a product without a positive weight does not receive an invented weight', () => {
    const result = planPacking({
      quantity: 15,
      rules: [{
        id: 'linen',
        name: 'Canvas Dinner Plate - Linen',
        unitName: 'box',
        piecesPerUnit: 15,
        weightKind: 'zero',
        weightMicro: 0n,
      }],
    })
    expect(result.plans[0].weightState).toBe('unknown-weight')
    expect(result.plans[0].calculatedMicro).toBe(0n)
    expect(result.plans[0].planningAllowanceMicro).toBeNull()
    expect(result.plans[0].missingInformation).toContain('confirmed weight')
    const partial = planPacking({
      quantity: 16,
      rules: [{
        id: 'linen',
        name: 'Canvas Dinner Plate - Linen',
        unitName: 'box',
        piecesPerUnit: 15,
        weightKind: 'zero',
        weightMicro: 0n,
      }],
    })
    expect(partial.plans[0].planningAllowanceMicro).toBeNull()
    expect(partial.plans[0].calculatedMicro).toBe(0n)
  })
})

describe('cutlery and Eclipse packing allowances', () => {
  test('70 dinner knives keep both partial configurations unknown and use full-box gross weight', () => {
    const result = planPacking({
      quantity: 70,
      rules: [
        rule({ id: 'knife-50', name: 'Piccadilly Polished Dinner Knife', piecesPerUnit: 50, weightMicro: 3800000n }),
        rule({ id: 'knife-90', name: 'Piccadilly Polished Dinner Knife', piecesPerUnit: 90, weightMicro: 7400000n }),
      ],
    })
    expect(result.plans[0].role).toBe('suggestion')
    expect(result.plans[0].boxes.map((box) => [box.piecesPerUnit, box.piecesEach, box.full])).toEqual([[90, 70, false]])
    expect(result.plans[0].exact).toBe(false)
    expect(result.plans[0].calculatedMicro).toBe(0n)
    expect(result.plans[0].reliability).toBe('ATA_PROPORTIONAL_ESTIMATE')
    expect(result.plans[0].planningAllowanceMicro).toBe(7400000n)
    expect(result.plans[0].proportionalNumerator).toBe(51800000n)
    expect(result.plans[0].proportionalDenominator).toBe(9n)
    const smaller = result.plans.find((plan) => plan.boxes.some((box) => box.piecesPerUnit === 50))
    expect(smaller.boxes.map((box) => [box.piecesPerUnit, box.piecesEach, box.full])).toEqual([
      [50, 50, true],
      [50, 20, false],
    ])
    expect(smaller.calculatedMicro).toBe(3800000n)
    expect(smaller.planningAllowanceMicro).toBe(7600000n)
    expect(smaller.operationalNumerator).toBe(5320000n)
    expect(smaller.operationalDenominator).toBe(1n)
    expect(smaller.planningAllowanceMicro).not.toBe(7400000n)
  })

  test('150 Eclipse dessert plates keep every listed combination at 107 kg', () => {
    const result = planPacking({
      quantity: 150,
      rules: [
        rule({ id: 'fifteen', name: 'Eclipse Dessert Plate', piecesPerUnit: 15, weightMicro: 10700000n }),
        rule({ id: 'thirty', name: 'Eclipse Dessert Plate', piecesPerUnit: 30, weightMicro: 21400000n }),
      ],
    })
    expect(result.plans).toHaveLength(4)
    expect(result.plans.every((plan) => plan.exact && plan.calculatedMicro === 107000000n)).toBe(true)
    expect(result.plans.every((plan) => plan.planningAllowanceMicro == null)).toBe(true)
    expect(result.plans.map((plan) => plan.boxes.map((box) => [box.piecesPerUnit, box.count]))).toEqual([
      [[30, 5]],
      [[30, 4], [15, 2]],
      [[30, 3], [15, 4]],
      [[30, 2], [15, 6]],
    ])
    const twenty = planPacking({
      quantity: 20,
      rules: [
        rule({ id: 'fifteen', name: 'Eclipse Dessert Plate', piecesPerUnit: 15, weightMicro: 10700000n }),
        rule({ id: 'thirty', name: 'Eclipse Dessert Plate', piecesPerUnit: 30, weightMicro: 21400000n }),
      ],
    })
    expect(twenty.plans).toHaveLength(2)
    expect(twenty.plans.every((plan) => plan.planningAllowanceMicro === 21400000n)).toBe(true)
    expect(twenty.plans.every((plan) => plan.reliability === 'ATA_PROPORTIONAL_ESTIMATE')).toBe(true)
    expect(twenty.plans.map((plan) => formatPlanKg(plan))).toEqual(['14.267', '14.267'])
    expect(new Set(twenty.plans.map((plan) => plan.physicalSignature)).size).toBe(2)
  })

  test('the automatic plan prefers an exact smaller box, then one larger box, then both full boxes', () => {
    const rules = [
      rule({ id: 'fifty', name: 'Synthetic Dinner Fork', piecesPerUnit: 50, weightMicro: 5000000n }),
      rule({ id: 'hundred', name: 'Synthetic Dinner Fork', piecesPerUnit: 100, weightMicro: 10000000n }),
    ]
    const boxesOf = (quantity) => {
      const plan = planPacking({ quantity, rules }).automatic
      return plan ? plan.boxes.map((box) => [box.piecesPerUnit, box.piecesEach, box.full]) : null
    }
    expect(boxesOf(20)).toEqual([[50, 20, false]])
    expect(boxesOf(50)).toEqual([[50, 50, true]])
    expect(boxesOf(70)).toEqual([[100, 70, false]])
    expect(boxesOf(80)).toEqual([[100, 80, false]])
    expect(boxesOf(85)).toEqual([[100, 85, false]])
    expect(boxesOf(95)).toEqual([[100, 95, false]])
    expect(boxesOf(100)).toEqual([[100, 100, true]])
    expect(boxesOf(150)).toEqual([[100, 100, true], [50, 50, true]])
    const thousand = planPacking({ quantity: 1000, rules })
    expect(thousand.automatic.boxes).toEqual([
      expect.objectContaining({ piecesPerUnit: 100, count: 10, full: true }),
    ])
    expect(thousand.automatic.boxCount).toBe(10)
    expect(thousand.plans.length).toBeLessThanOrEqual(4)
    expect(thousand.truncation.join(' ')).toContain('limit')
    expect(planPacking({ quantity: 900, rules }).automatic.boxes).toEqual([
      expect.objectContaining({ piecesPerUnit: 100, count: 9, full: true }),
    ])
    expect(planPacking({ quantity: 5000, rules }).automatic.boxes).toEqual([
      expect.objectContaining({ piecesPerUnit: 100, count: 50, full: true }),
    ])
    expect(planPacking({ quantity: 50, rules }).plans[0].boxes.map((box) => box.piecesPerUnit)).toEqual([100])
  })

  test('partial quantities without tare use a proportional gross and keep the full-box limit separate', () => {
    const rules = [
      rule({ id: 'hundred', name: 'Synthetic Dinner Fork', piecesPerUnit: 100, weightMicro: 10000000n }),
    ]
    const estimate = (quantity) => {
      const plan = planPacking({ quantity, rules }).automatic
      return {
        reliability: plan.reliability,
        kg: plan.operationalNumerator == null
          ? null
          : formatPlanKg(plan),
        limit: plan.planningAllowanceMicro,
      }
    }
    expect(estimate(20)).toEqual({ reliability: 'ATA_PROPORTIONAL_ESTIMATE', kg: '2', limit: 10000000n })
    expect(estimate(50)).toEqual({ reliability: 'ATA_PROPORTIONAL_ESTIMATE', kg: '5', limit: 10000000n })
    expect(estimate(70)).toEqual({ reliability: 'ATA_PROPORTIONAL_ESTIMATE', kg: '7', limit: 10000000n })
    expect(estimate(80)).toEqual({ reliability: 'ATA_PROPORTIONAL_ESTIMATE', kg: '8', limit: 10000000n })
    expect(estimate(85)).toEqual({ reliability: 'ATA_PROPORTIONAL_ESTIMATE', kg: '8.5', limit: 10000000n })
    expect(estimate(95)).toEqual({ reliability: 'ATA_PROPORTIONAL_ESTIMATE', kg: '9.5', limit: 10000000n })
    expect(estimate(100)).toEqual({ reliability: 'ATA_FULL_PACK', kg: '10', limit: null })
    expect(estimate(150)).toEqual({ reliability: 'ATA_PROPORTIONAL_ESTIMATE', kg: '15', limit: 20000000n })
    expect(estimate(900)).toEqual({ reliability: 'ATA_FULL_PACK', kg: '90', limit: null })
    expect(estimate(5000)).toEqual({ reliability: 'ATA_FULL_PACK', kg: '500', limit: null })
    const withTare = planPacking({
      quantity: 85,
      rules: [rule({
        id: 'hundred',
        name: 'Synthetic Dinner Fork',
        piecesPerUnit: 100,
        weightMicro: 10000000n,
        tareMicro: 300000n,
      })],
    }).automatic
    expect(withTare.reliability).toBe('ATA_DERIVED_GROSS')
    expect(withTare.proportionalNumerator).toBeNull()
    const invalidTare = planPacking({
      quantity: 85,
      rules: [rule({
        id: 'hundred',
        name: 'Synthetic Dinner Fork',
        piecesPerUnit: 100,
        weightMicro: 10000000n,
        tareMicro: 11000000n,
      })],
    }).automatic
    expect(invalidTare.reliability).toBe('UNKNOWN')
    expect(invalidTare.proportionalNumerator).toBeNull()
    expect(invalidTare.planningAllowanceMicro).toBeNull()
    const bundled = planPacking({
      quantity: 85,
      rules: [{
        ...rule({ id: 'hundred', name: 'Synthetic Dinner Fork', piecesPerUnit: 100, weightMicro: 10000000n }),
        bundlePieces: 10,
      }],
    }).automatic
    expect(bundled.reliability).toBe('ATA_PROPORTIONAL_ESTIMATE')
    expect(formatPlanKg(bundled)).toBe('8.5')
    expect(bundled.derivedNumerator).toBeNull()
  })
})

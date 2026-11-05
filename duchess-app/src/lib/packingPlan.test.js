import { planPacking, PACKING_PRIORITY } from './packingPlan'

function rule(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    unitName: 'box',
    piecesPerUnit: overrides.piecesPerUnit,
    weightKind: 'positive',
    weightMicro: overrides.weightMicro,
  }
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
    expect(result.plans[0].calculatedMicro).toBe(0n)
    expect(result.plans[0].planningAllowanceMicro).toBe(4000000n)
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
    expect(result.plans[0].planningAllowanceMicro).toBe(7400000n)
    const smaller = result.plans.find((plan) => plan.boxes.some((box) => box.piecesPerUnit === 50))
    expect(smaller.boxes.map((box) => [box.piecesPerUnit, box.piecesEach, box.full])).toEqual([
      [50, 50, true],
      [50, 20, false],
    ])
    expect(smaller.calculatedMicro).toBe(0n)
    expect(smaller.planningAllowanceMicro).toBe(7600000n)
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
    expect(twenty.plans.every((plan) => plan.calculatedMicro === 0n && plan.planningAllowanceMicro === 21400000n)).toBe(true)
    expect(new Set(twenty.plans.map((plan) => plan.physicalSignature)).size).toBe(2)
  })
})

import {
  assessOrderWeight,
  formatKilograms,
  loadOrderWeight,
  presentOrderWeight,
} from './orderWeight'

function catalogItem(overrides) {
  return {
    name: 'Pearl Oval Platter 40cm',
    category: 'dinnerware',
    unit_name: 'box',
    pieces_per_unit: 15,
    weight_per_unit: '4.5',
    active: true,
    ...overrides,
  }
}

function orderItem(overrides) {
  return {
    id: 'line-1',
    item_name: 'Pearl Oval Platter — 40cm',
    quantity: 30,
    unit: 'unit',
    category: 'other',
    opportunity_item_type_name: 'Principal',
    transaction_type_name: 'Rental',
    ...overrides,
  }
}

describe('order weight', () => {
  test('matches an exact normalized name and converts pieces into full boxes', () => {
    const result = assessOrderWeight([orderItem()], [catalogItem()])
    expect(result.status).toBe('COMPLETE')
    expect(result.calculated).toBe(1)
    expect(result.lines[0].containers).toBe(2)
    expect(formatKilograms(result.knownMicro)).toBe('9')
  })

  test('does not treat a different size or shape as the same item', () => {
    const catalog = [
      catalogItem(),
      catalogItem({ name: 'Pearl Oval Platter 30cm', weight_per_unit: '3' }),
      catalogItem({ name: 'Pearl Rectangular Platter 40cm', weight_per_unit: '6' }),
    ]
    const result = assessOrderWeight([
      orderItem({ id: 'size', item_name: 'Pearl Oval Platter 30cm', quantity: 15 }),
      orderItem({ id: 'shape', item_name: 'Pearl Rectangular Platter 40cm', quantity: 15 }),
    ], catalog)
    expect(result.lines.map((line) => formatKilograms(line.weightMicro))).toEqual(['3', '6'])
  })

  test('leaves an item that is absent from the catalog unverified', () => {
    const result = assessOrderWeight([orderItem({ item_name: 'Unlisted Bowl' })], [catalogItem()])
    expect(result.status).toBe('PARTIAL')
    expect(result.lines[0].label).toBe('Weight missing')
  })

  test('does not turn a zero or null catalog weight into a calculated zero', () => {
    const zero = assessOrderWeight([orderItem()], [catalogItem({ weight_per_unit: '0' })])
    const missing = assessOrderWeight([orderItem()], [catalogItem({ weight_per_unit: null })])
    expect(zero.lines[0].label).toBe('Weight missing')
    expect(missing.lines[0].label).toBe('Weight missing')
    expect(zero.knownMicro).toBe(0n)
    expect(presentOrderWeight(zero).remainingKg).toBeNull()
  })

  test('does not calculate when the packing unit is unknown', () => {
    const result = assessOrderWeight([orderItem()], [catalogItem({ unit_name: 'pallet' })])
    expect(result.lines[0].label).toBe('Needs verification')
    expect(result.status).toBe('PARTIAL')
  })

  test('rounds a partial container up and keeps an exact container whole', () => {
    const catalog = [catalogItem({ pieces_per_unit: 15, weight_per_unit: '2' })]
    const partial = assessOrderWeight([orderItem({ quantity: 16 })], catalog)
    const exact = assessOrderWeight([orderItem({ quantity: 15 })], catalog)
    expect(partial.lines[0].containers).toBe(2)
    expect(exact.lines[0].containers).toBe(1)
  })

  test('handles a large quantity and a zero quantity without losing the rule', () => {
    const catalog = [catalogItem({ pieces_per_unit: 10, weight_per_unit: '1.25' })]
    const large = assessOrderWeight([orderItem({ quantity: 1000000 })], catalog)
    const none = assessOrderWeight([orderItem({ quantity: 0 })], catalog)
    expect(large.lines[0].containers).toBe(100000)
    expect(formatKilograms(large.knownMicro)).toBe('125000')
    expect(none.lines[0].containers).toBe(0)
    expect(none.status).toBe('COMPLETE')
    expect(none.knownMicro).toBe(0n)
  })

  test('excludes a section or service line from the physical total', () => {
    const result = assessOrderWeight([
      orderItem({ id: 'group', item_name: 'Dinner service', opportunity_item_type_name: 'Group', quantity: 1 }),
      orderItem({ id: 'service', item_name: 'Staff service', transaction_type_name: 'Service', quantity: 4 }),
      orderItem(),
    ], [catalogItem()])
    expect(result.lines.filter((line) => line.disposition === 'not_physical')).toHaveLength(2)
    expect(result.calculated).toBe(1)
    expect(result.status).toBe('COMPLETE')
  })

  test('a catalog read failure stays unavailable and does not invent a total', async () => {
    const result = await loadOrderWeight([orderItem()], async () => {
      throw new Error('catalog offline')
    })
    const view = presentOrderWeight(result)
    expect(view.status).toBe('UNAVAILABLE')
    expect(view.knownKg).toBe('0')
    expect(view.remainingKg).toBeNull()
    expect(view.estimateVehicles).toBeNull()
  })

  test('reports capacity only when every physical line is validated', () => {
    const heavy = catalogItem({ weight_per_unit: '600', pieces_per_unit: 1 })
    const under = presentOrderWeight(assessOrderWeight([orderItem({ quantity: 1 })], [heavy]))
    const equal = presentOrderWeight(assessOrderWeight([
      orderItem({ id: 'a', quantity: 1 }),
      orderItem({ id: 'b', quantity: 1 }),
    ], [heavy]))
    const over = presentOrderWeight(assessOrderWeight([
      orderItem({ id: 'a', quantity: 1 }),
      orderItem({ id: 'b', quantity: 1 }),
      orderItem({ id: 'c', quantity: 1 }),
    ], [heavy]))
    const partial = presentOrderWeight(assessOrderWeight([
      orderItem(),
      orderItem({ id: 'gap', item_name: 'Unknown glass' }),
    ], [catalogItem()]))
    expect(under.percent).toBe('50.0')
    expect(under.remainingKg).toBe('600')
    expect(under.overLimit).toBe(false)
    expect(under.estimateVehicles).toBeNull()
    expect(equal.remainingKg).toBe('0')
    expect(equal.overLimit).toBe(false)
    expect(over.overLimit).toBe(true)
    expect(over.estimateVehicles).toBe(2)
    expect(over.remainingKg).toBe('0')
    expect(partial.status).toBe('PARTIAL')
    expect(partial.remainingKg).toBeNull()
    expect(partial.percent).toBeNull()
    expect(partial.estimateVehicles).toBeNull()
  })

  test('a later order does not keep the previous order total', () => {
    const first = assessOrderWeight([orderItem({ quantity: 30 })], [catalogItem()])
    const second = assessOrderWeight([orderItem({ item_name: 'Unlisted Bowl', quantity: 4 })], [catalogItem()])
    expect(formatKilograms(first.knownMicro)).toBe('9')
    expect(second.knownMicro).toBe(0n)
    expect(second.missing).toBe(1)
  })

  test('conflicting catalog rows for one name are not averaged', () => {
    const result = assessOrderWeight([orderItem()], [
      catalogItem({ weight_per_unit: '4' }),
      catalogItem({ weight_per_unit: '9' }),
    ])
    expect(result.lines[0].label).toBe('Needs verification')
    expect(result.knownMicro).toBe(0n)
  })
})

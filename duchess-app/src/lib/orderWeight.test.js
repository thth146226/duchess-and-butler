import {
  assessOrderWeight,
  fetchAtaCatalog,
  formatKilograms,
  loadOrderWeight,
  measurementRequest,
  orderWeightMessage,
  presentOrderWeight,
  refreshAtaCatalog,
  resetAtaCatalogCache,
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
    expect(view.reason).toBe('catalog')
    expect(view.knownKg).toBeNull()
    expect(orderWeightMessage(view)).toBe('The weight catalog could not be loaded. The order weight is not shown.')
    expect(view.remainingKg).toBeNull()
    expect(view.estimateVehicles).toBeNull()
  })

  test('a physical order with no confirmed weight is not presented as 0 kg', () => {
    const missing = presentOrderWeight(assessOrderWeight([orderItem({ item_name: 'Unlisted Bowl' })], []))
    const zero = presentOrderWeight(assessOrderWeight([orderItem()], [catalogItem({ weight_per_unit: '0' })]))
    const itemsFailed = presentOrderWeight(null, { itemsError: true })
    expect(missing.status).toBe('PARTIAL')
    expect(zero.status).toBe('PARTIAL')
    expect(missing.knownKg).toBeNull()
    expect(zero.knownKg).toBeNull()
    expect(itemsFailed.knownKg).toBeNull()
    expect(orderWeightMessage(missing)).toBe('No confirmed weight yet. The order total is not available.')
    expect(orderWeightMessage(itemsFailed)).toBe('The item list could not be loaded. The order weight is not shown.')
    expect(orderWeightMessage(itemsFailed)).not.toBe(orderWeightMessage(presentOrderWeight(null)))
  })

  test('a complete order can show 0 kg when every physical weight is known', () => {
    const view = presentOrderWeight(assessOrderWeight(
      [orderItem({ quantity: 0 })],
      [catalogItem({ pieces_per_unit: 10, weight_per_unit: '1.25' })],
    ))
    expect(view.status).toBe('COMPLETE')
    expect(view.knownKg).toBe('0')
    expect(view.reason).toBeNull()
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
      catalogItem({ id: 'light', weight_per_unit: '4', pieces_per_unit: 50 }),
      catalogItem({ id: 'heavy', weight_per_unit: '9', pieces_per_unit: 100 }),
    ])
    expect(result.lines[0].label).toBe('Needs verification')
    expect(result.lines[0].alternatives.map((alternative) => alternative.id)).toEqual(['light', 'heavy'])
    expect(result.knownMicro).toBe(0n)
    expect(result.previewMicro).toBe(0n)
    expect(result.status).toBe('PARTIAL')
  })

  test('a selected heavier box is a preview and does not complete the order', () => {
    const catalog = [
      catalogItem({ id: 'light', weight_per_unit: '4', pieces_per_unit: 50 }),
      catalogItem({ id: 'heavy', weight_per_unit: '9', pieces_per_unit: 100 }),
    ]
    const missingChoice = assessOrderWeight([orderItem({ id: 'spoon' })], catalog, { spoon: 'missing-pack' })
    const heavier = assessOrderWeight([orderItem({ id: 'spoon', quantity: 20 })], catalog, { spoon: 'heavy' })
    const view = presentOrderWeight(heavier)
    expect(missingChoice.lines[0].disposition).toBe('ambiguous')
    expect(heavier.lines[0].disposition).toBe('preview')
    expect(heavier.lines[0].piecesPerUnit).toBe(100)
    expect(formatKilograms(heavier.previewMicro)).toBe('9')
    expect(heavier.knownMicro).toBe(0n)
    expect(heavier.status).toBe('PARTIAL')
    expect(view.previewKg).toBe('9')
    expect(view.knownKg).toBeNull()
    expect(view.estimateVehicles).toBeNull()
    expect(view.remainingKg).toBeNull()
  })

  test('a line without type metadata stays physical', () => {
    const result = assessOrderWeight([
      orderItem({
        item_name: 'Delivery & Collection',
        quantity: 1,
        opportunity_item_type_name: '',
        transaction_type_name: '',
      }),
    ], [])
    expect(result.lines[0].disposition).toBe('missing')
    expect(measurementRequest(result.lines[0])).toBe('No catalog packing rule. Do not copy another product weight.')
  })

  test('a zero catalog weight names the pack that still has to be weighed', () => {
    const result = assessOrderWeight([orderItem()], [catalogItem({ unit_name: 'box', pieces_per_unit: 15, weight_per_unit: '0' })])
    expect(result.lines[0].disposition).toBe('zero_weight')
    expect(measurementRequest(result.lines[0])).toBe('Weigh one packed box of 15. Do not copy another product.')
  })
})

function pagingClient(sequence) {
  const state = { calls: 0 }
  return {
    calls: () => state.calls,
    from() {
      return {
        select() { return this },
        eq() { return this },
        range() {
          state.calls += 1
          const step = sequence[Math.min(state.calls, sequence.length) - 1]
          return Promise.resolve(step)
        },
      }
    },
  }
}

describe('ATA catalog cache', () => {
  beforeEach(() => {
    resetAtaCatalogCache()
  })

  test('a corrected catalog weight is used on the next controlled re-read and then cached', async () => {
    const plate = {
      id: 'plate',
      name: 'Canvas Dinner Plate - Linen',
      unit_name: 'box',
      pieces_per_unit: 15,
      weight_per_unit: '0',
      active: true,
    }
    const client = pagingClient([
      { data: [plate], error: null },
      { data: [{ ...plate, weight_per_unit: '4.5' }], error: null },
    ])
    const item = orderItem({ item_name: 'Canvas Dinner Plate - Linen', quantity: 15 })
    const first = await fetchAtaCatalog(client)
    const repeated = await fetchAtaCatalog(client)
    expect(repeated).toBe(first)
    expect(client.calls()).toBe(1)
    expect(assessOrderWeight([item], first).lines[0].disposition).toBe('zero_weight')
    const refreshed = await refreshAtaCatalog(client)
    const corrected = assessOrderWeight([item], refreshed)
    expect(client.calls()).toBe(2)
    expect(corrected.lines[0].disposition).toBe('calculated')
    expect(formatKilograms(corrected.knownMicro)).toBe('4.5')
    await fetchAtaCatalog(client)
    expect(client.calls()).toBe(2)
  })

  test('a temporary catalog failure is not cached and the next read can succeed', async () => {
    const client = pagingClient([
      { data: null, error: { message: 'timeout' } },
      { data: [catalogItem({ weight_per_unit: '4.5', pieces_per_unit: 15 })], error: null },
    ])
    await expect(fetchAtaCatalog(client)).rejects.toEqual({ message: 'timeout' })
    const rows = await fetchAtaCatalog(client)
    expect(client.calls()).toBe(2)
    expect(rows[0].weight_per_unit).toBe('4.5')
    const view = presentOrderWeight(await loadOrderWeight(
      [orderItem({ quantity: 15 })],
      () => fetchAtaCatalog(client),
    ))
    expect(view.knownKg).toBe('4.5')
    expect(client.calls()).toBe(2)
  })

  test('a later order does not reuse another order preview from the shared catalog', async () => {
    const client = pagingClient([{
      data: [catalogItem({ id: 'box', pieces_per_unit: 15, weight_per_unit: '4.5' })],
      error: null,
    }])
    const rows = await fetchAtaCatalog(client)
    const first = assessOrderWeight([orderItem({ id: 'order-a', quantity: 15 })], rows)
    const second = assessOrderWeight([
      orderItem({ id: 'order-b', item_name: 'Unlisted Bowl', quantity: 4 }),
    ], rows)
    expect(formatKilograms(first.knownMicro)).toBe('4.5')
    expect(second.knownMicro).toBe(0n)
    expect(second.previewMicro).toBe(0n)
    expect(second.missing).toBe(1)
    expect(client.calls()).toBe(1)
  })

  test('a changed or removed pack invalidates the earlier preview choice', () => {
    const item = orderItem({ id: 'spoon', item_name: 'Piccadilly Polished Dessert Spoon', quantity: 20 })
    const packs = [
      catalogItem({ id: 'box', name: item.item_name, pieces_per_unit: 50, weight_per_unit: '4.1' }),
      catalogItem({ id: 'crate', name: item.item_name, pieces_per_unit: 100, weight_per_unit: '7.9' }),
    ]
    const chosen = assessOrderWeight([item], packs, { spoon: 'box' })
    const recorded = {
      id: chosen.lines[0].selectedId,
      piecesPerUnit: chosen.lines[0].piecesPerUnit,
      unitName: chosen.lines[0].unitName,
      weightMicro: chosen.lines[0].containerMicro.toString(),
    }
    expect(chosen.lines[0].disposition).toBe('preview')
    const changed = assessOrderWeight([item], [
      catalogItem({ id: 'box', name: item.item_name, pieces_per_unit: 40, weight_per_unit: '5' }),
      catalogItem({ id: 'crate', name: item.item_name, pieces_per_unit: 100, weight_per_unit: '7.9' }),
    ], { spoon: recorded })
    expect(changed.lines[0].disposition).toBe('ambiguous')
    expect(changed.previewMicro).toBe(0n)
    expect(changed.status).toBe('PARTIAL')
    const removed = assessOrderWeight([item], [
      catalogItem({ id: 'other', name: item.item_name, pieces_per_unit: 80, weight_per_unit: '6' }),
      catalogItem({ id: 'crate', name: item.item_name, pieces_per_unit: 100, weight_per_unit: '7.9' }),
    ], { spoon: recorded })
    expect(removed.lines[0].disposition).toBe('ambiguous')
    expect(removed.previewMicro).toBe(0n)
    expect(presentOrderWeight(removed).estimateVehicles).toBeNull()
  })
})

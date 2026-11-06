import { assessOrderWeight, formatKilograms, measurementRequest, presentOrderWeight } from './orderWeight'

const KATRINA = [
  ['Prima Dinner Plate', 30],
  ['Duchess Drape Tablecloths', 0],
  ['Cutlery', 0],
  ['Lily Water / Grand Vin Glass', 30],
  ['Delivery & Collection', 0],
  ['Glassware', 0],
  ['Table Lamps', 0],
  ['Chairs', 0],
  ['Lily Flute Glass', 28],
  ['Pearl Oval Platter - 50cm', 2],
  ['Fine Napkins', 0],
  ['Delivery & Collection', 1],
  ['Dinnerware', 0],
  ['Piccadilly Polished Starter Knife', 20],
  ['Canvas Dinner Plate - Linen', 30],
  ['Piccadilly Polished Dinner Fork', 20],
  ['Piccadilly Polished Dinner Knife', 20],
  ['Piccadilly Polished Tea Spoon', 20],
  ['Lily Red Wine Glass', 24],
  ['Piccadilly Polished Starter/ Dessert Fork', 40],
  ['Piccadilly Polished Dessert Spoon', 20],
  ['Tulip Water Glass - Dusty Rose', 30],
  ['Lennox Chrome Table Lamp', 13],
  ['Dali Dining Chair', 18],
  ['Pearl Oval Platter - 40cm', 3],
  ['Pearl Rectangular Platter - 30cm', 3],
  ['Perlette Napkin - Cream', 20],
  ['Duchess Drape Iris White Tablecloth 245cm x 350cm (96" x 137")', 4],
  ['Prima Dessert Plate', 30],
  ['Platters & Serviceware', 0],
]

const positiveRules = [
  ['Prima Dinner Plate', 15, '1.5'],
  ['Lily Water / Grand Vin Glass', 15, '1.5'],
  ['Lily Flute Glass', 28, '3'],
  ['Lily Red Wine Glass', 24, '3'],
  ['Tulip Water Glass - Dusty Rose', 15, '1.5'],
  ['Perlette Napkin - Cream', 20, '2'],
]
const zeroNames = [
  ['Canvas Dinner Plate - Linen', 15],
  ['Lennox Chrome Table Lamp', 8],
  ['Pearl Oval Platter - 40cm', 3],
  ['Pearl Oval Platter - 50cm', 4],
  ['Pearl Rectangular Platter - 30cm', 5],
  ['Duchess Drape Iris White Tablecloth 245cm x 350cm', 4],
]
const ambiguousNames = [
  'Piccadilly Polished Starter Knife', 'Piccadilly Polished Dinner Fork',
  'Piccadilly Polished Dinner Knife', 'Piccadilly Polished Tea Spoon',
  'Piccadilly Polished Starter/ Dessert Fork', 'Piccadilly Polished Dessert Spoon',
  'Prima Dessert Plate',
]
const testCatalog = [
  // Synthetic fixture weights. These are NOT real ATA measurements, and must
  // never be copied to production records or presented as Katrina's real total.
  ...positiveRules.map(([name, pieces, weight]) => ({ name, unit_name: 'box', pieces_per_unit: pieces, weight_per_unit: weight, active: true })),
  ...zeroNames.map(([name, pieces]) => ({ name, unit_name: name.includes('Tablecloth') ? 'bag' : 'box', pieces_per_unit: pieces, weight_per_unit: '0', active: true })),
  ...ambiguousNames.flatMap(name => [
    { name, unit_name: 'box', pieces_per_unit: 50, weight_per_unit: '4', active: true },
    { name, unit_name: 'box', pieces_per_unit: 100, weight_per_unit: '8', active: true },
  ]),
]

function line(name, quantity, idx) {
  return {
    id: `KAT-${idx}`,
    item_name: name,
    quantity,
    unit: 'unit',
    category: 'other',
    opportunity_item_type_name: quantity === 0 ? 'Group' : 'Principal',
    transaction_type_name: name === 'Delivery & Collection' && quantity === 1 ? 'Sale' : 'Rental',
  }
}

describe('Katrina QDB08128 full order: 30 line regression', () => {
  test('the complete 30-line order remains partial, 10 nonphysical, 6 known and 14 unresolved', () => {
    const items = KATRINA.map(([name, quantity], idx) => line(name, quantity, idx))
    expect(items).toHaveLength(30)
    const assessed = assessOrderWeight(items, testCatalog)
    const view = presentOrderWeight(assessed)
    expect(assessed.lines.filter(l => l.disposition === 'not_physical')).toHaveLength(10)
    expect(assessed.calculated).toBe(6)
    expect(assessed.missing).toBe(14)
    expect(assessed.status).toBe('PARTIAL')
    expect(view.remainingKg).toBeNull()
    expect(view.estimateVehicles).toBeNull()
    expect(assessed.lines.find(l => l.name === 'Dali Dining Chair').disposition).toBe('missing')
    expect(assessed.lines.find(l => l.name.includes('Iris White')).disposition).toBe('zero_weight')
    expect(formatKilograms(assessed.knownMicro)).toBe('17')
    expect(formatKilograms(assessed.knownMicro)).not.toBe('63.8')
  })

  test('only the verified Delivery & Collection Sale line is excluded', () => {
    const items = [
      line('Delivery & Collection', 1, 1),
      { ...line('Delivery & Collection', 1, 2), transaction_type_name: null },
      { ...line('Prima Dinner Plate', 3, 3), transaction_type_name: 'Sale' },
    ]
    const assessed = assessOrderWeight(items, testCatalog)
    expect(assessed.lines.map(l => l.disposition)).toEqual(['not_physical', 'missing', 'partial_box'])
  })

  test('Iris White exact alias never borrows Magnolia weight or a different size', () => {
    const assessed = assessOrderWeight([line('Duchess Drape Iris White Tablecloth 245cm x 350cm (96" x 137")', 4, 1)], [
      { name: 'Duchess Drape Iris White Tablecloth 245cm x 350cm', unit_name: 'bag', pieces_per_unit: 4, weight_per_unit: '0', active: true },
      { name: 'Duchess Drape Magnolia Tablecloth 245cm x 350cm', unit_name: 'bag', pieces_per_unit: 4, weight_per_unit: '16.9', active: true },
    ])
    expect(assessed.status).toBe('PARTIAL')
    expect(assessed.lines[0].disposition).toBe('zero_weight')
    const different = assessOrderWeight([line('Duchess Drape Iris White Tablecloth 245cm x 300cm (96" x 118")', 4, 1)], testCatalog)
    expect(different.lines[0].disposition).toBe('missing')
  })
})

const REAL_CONFIRMED = [
  ['Prima Dinner Plate', 30, 'box', 15, '9'],
  ['Lily Water / Grand Vin Glass', 30, 'crate', 15, '6.9'],
  ['Lily Flute Glass', 28, 'crate', 28, '9.2'],
  ['Lily Red Wine Glass', 24, 'crate', 24, '8.1'],
  ['Tulip Water Glass - Dusty Rose', 30, 'crate', 15, '5'],
  ['Perlette Napkin - Cream', 20, 'box', 70, '4.7'],
]

const REAL_ALTERNATIVES = [
  ['Piccadilly Polished Dessert Spoon', 20, [['spoon-50', 50, '4.1'], ['spoon-100', 100, '7.9']]],
  ['Piccadilly Polished Dinner Fork', 20, [['fork-50', 50, '4.7'], ['fork-90', 90, '8.4']]],
  ['Piccadilly Polished Dinner Knife', 20, [['knife-50', 50, '3.9'], ['knife-90', 90, '7.4']]],
  ['Piccadilly Polished Starter Knife', 20, [['starter-50', 50, '3.5'], ['starter-100', 100, '6.2']]],
  ['Piccadilly Polished Starter/ Dessert Fork', 40, [['starter-fork-50', 50, '3.8'], ['starter-fork-100', 100, '7.2']]],
  ['Piccadilly Polished Tea Spoon', 20, [['tea-80', 80, '3.6'], ['tea-150', 150, '6.4']]],
  ['Prima Dessert Plate', 30, [['dessert-15', 15, '6.3'], ['dessert-30', 30, '16.1']]],
]

describe('Katrina QDB08128 read-only ATA figures', () => {
  test('five exact catalog rules total 59.1 kg and the partial napkin box is not the old 63.8 kg load', () => {
    const items = REAL_CONFIRMED.map(([name, quantity], idx) => line(name, quantity, idx))
    const catalog = REAL_CONFIRMED.map(([name, , unit, pieces, weight]) => ({
      name, unit_name: unit, pieces_per_unit: pieces, weight_per_unit: weight, active: true,
    }))
    const assessed = assessOrderWeight(items, catalog)
    const view = presentOrderWeight(assessed)
    expect(assessed.calculated).toBe(5)
    expect(assessed.status).toBe('PARTIAL')
    expect(assessed.lines.find((entry) => entry.name === 'Perlette Napkin - Cream').disposition).toBe('partial_box')
    expect(view.knownKg).toBe('59.1')
    expect(view.knownKg).not.toBe('63.8')
    expect(view.estimateVehicles).toBeNull()
  })

  test('seven ambiguous packs stay pending until the heavier recorded box is chosen', () => {
    const items = REAL_ALTERNATIVES.map(([name, quantity], idx) => line(name, quantity, idx))
    const catalog = REAL_ALTERNATIVES.flatMap(([name, , packs]) => packs.map(([id, pieces, weight]) => ({
      id, name, unit_name: 'box', pieces_per_unit: pieces, weight_per_unit: weight, active: true,
    })))
    const pending = assessOrderWeight(items, catalog)
    expect(pending.status).toBe('PARTIAL')
    expect(pending.calculated).toBe(1)
    expect(pending.missing).toBe(6)
    expect(formatKilograms(pending.knownMicro)).toBe('16.1')
    expect(pending.lines.filter((entry) => entry.disposition === 'partial_box')).toHaveLength(6)
    expect(pending.lines.find((entry) => entry.name === 'Prima Dessert Plate').disposition).toBe('calculated')
    expect(pending.lines.map((entry) => entry.alternatives.map((alternative) => (
      `${alternative.piecesPerUnit}:${formatKilograms(alternative.weightMicro)}`
    )))).toEqual([
      ['50:4.1', '100:7.9'],
      ['50:4.7', '90:8.4'],
      ['50:3.9', '90:7.4'],
      ['50:3.5', '100:6.2'],
      ['50:3.8', '100:7.2'],
      ['80:3.6', '150:6.4'],
      ['15:6.3', '30:16.1'],
    ])
    const selections = {
      'KAT-0': 'spoon-100',
      'KAT-1': 'fork-90',
      'KAT-2': 'knife-90',
      'KAT-3': 'starter-100',
      'KAT-4': 'starter-fork-100',
      'KAT-5': 'tea-150',
      'KAT-6': 'dessert-30',
    }
    const preview = assessOrderWeight(items, catalog, selections)
    const view = presentOrderWeight(preview)
    expect(preview.status).toBe('PARTIAL')
    expect(preview.lines.every((entry) => entry.disposition === 'preview')).toBe(true)
    expect(preview.lines.map((entry) => entry.piecesPerUnit)).toEqual([100, 90, 90, 100, 100, 150, 30])
    expect(view.knownKg).toBeNull()
    expect(view.estimateVehicles).toBeNull()
    expect(view.previewKg).toBe('16.1')
    expect(preview.lines.filter((entry) => entry.plan && !entry.plan.exact)).toHaveLength(6)
    expect(measurementRequest(pending.lines[0])).toContain('not a confirmed weight')
    expect(pending.lines[0].disposition).not.toBe('preview')
  })
})

describe('Dali chair verified ATA mapping', () => {
  const item = {
    id: 'KATRINA-DALI',
    item_name: 'Dali Dining Chair',
    quantity: 18,
    opportunity_item_type_name: 'Principal',
    transaction_type_name: 'Rental',
  }

  const ata = {
    id: '525089d2-f4f8-49dc-98bd-63ac8e2f225d',
    name: 'Dali Black and White Boucle Chair',
    unit_name: 'individual',
    pieces_per_unit: 1,
    weight_per_unit: '7.000',
    active: true,
  }

  test('calculates 18 chairs at 7 kg each', () => {
    const result = assessOrderWeight([item], [ata])
    expect(result.status).toBe('COMPLETE')
    expect(result.calculated).toBe(1)
    expect(formatKilograms(result.knownMicro)).toBe('126')
  })

  test('refuses blank unit, container unit and wrong capacity', () => {
    const invalid = [
      { ...ata, unit_name: '' },
      { ...ata, unit_name: 'box' },
      { ...ata, pieces_per_unit: 2 },
      { ...ata, active: false },
      { ...ata, weight_per_unit: '0' },
    ]

    for (const row of invalid) {
      const result = assessOrderWeight([item], [row])
      expect(result.calculated).toBe(0)
      expect(result.knownMicro).toBe(0n)
      expect(result.status).toBe('PARTIAL')
    }
  })

  test('does not match another Dali variant', () => {
    const other = {
      ...item,
      item_name: 'Dali Dining Chair Different Model',
    }
    const result = assessOrderWeight([other], [ata])
    expect(result.calculated).toBe(0)
  })

  test('direct ATA name match takes precedence', () => {
    const direct = {
      ...ata,
      id: 'DIRECT-DALI',
      name: 'Dali Dining Chair',
      weight_per_unit: '8.000',
    }
    const result = assessOrderWeight([item], [ata, direct])
    expect(formatKilograms(result.knownMicro)).toBe('144')
  })

  test('Katrina known subtotal becomes 185.1 kg', () => {
    const five = REAL_CONFIRMED.filter(
      ([name]) => name !== 'Perlette Napkin - Cream'
    )
    const items = five.map(
      ([name, quantity], index) => line(name, quantity, index)
    )
    const catalog = five.map(
      ([name, , unit, pieces, weight]) => ({
        name,
        unit_name: unit,
        pieces_per_unit: pieces,
        weight_per_unit: weight,
        active: true,
      })
    )

    const result = assessOrderWeight(
      [
        ...items,
        item,
        line('Perlette Napkin - Cream', 20, 99),
      ],
      [
        ...catalog,
        ata,
        {
          name: 'Perlette Napkin - Cream',
          unit_name: 'box',
          pieces_per_unit: 70,
          weight_per_unit: '4.7',
          active: true,
        },
      ]
    )

    expect(result.status).toBe('PARTIAL')
    expect(result.calculated).toBe(6)
    expect(result.missing).toBe(1)
    expect(formatKilograms(result.knownMicro)).toBe('185.1')
  })
})

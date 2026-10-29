import { assessOrderWeight, presentOrderWeight } from './orderWeight'

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

const positiveNames = [
  'Prima Dinner Plate', 'Lily Water / Grand Vin Glass', 'Lily Flute Glass',
  'Lily Red Wine Glass', 'Tulip Water Glass - Dusty Rose', 'Perlette Napkin - Cream',
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
  ...positiveNames.map(name => ({ name, unit_name: 'box', pieces_per_unit: 10, weight_per_unit: '1', active: true })),
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
  })

  test('only the verified Delivery & Collection Sale line is excluded', () => {
    const items = [
      line('Delivery & Collection', 1, 1),
      { ...line('Delivery & Collection', 1, 2), transaction_type_name: null },
      { ...line('Prima Dinner Plate', 3, 3), transaction_type_name: 'Sale' },
    ]
    const assessed = assessOrderWeight(items, testCatalog)
    expect(assessed.lines.map(l => l.disposition)).toEqual(['not_physical', 'missing', 'calculated'])
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

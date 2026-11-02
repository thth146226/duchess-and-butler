import {
  buildAtaCapacityMap,
  generateLabelsForQuantity,
  resolveJobItemRule,
} from './labelGenerator'

test('printed labels still use the largest capacity and the existing remainder split', () => {
  const map = buildAtaCapacityMap([
    { id: 'small', name: 'Prima Dessert Plate', active: true, pieces_per_unit: 15, unit_name: 'box' },
    { id: 'large', name: 'Prima Dessert Plate', active: true, pieces_per_unit: 30, unit_name: 'box' },
  ])
  const resolved = resolveJobItemRule({ item_name: 'Prima Dessert Plate' }, map)
  expect(resolved.matchedBy).toBe('exact')
  expect(resolved.rule.selectedCapacity).toBe(30)
  expect(resolved.rule.capacityOptions).toEqual([30, 15])
  expect(generateLabelsForQuantity(30, 30)).toEqual([30])
  expect(generateLabelsForQuantity(30, 15)).toEqual([15, 15])
  expect(generateLabelsForQuantity(16, 15)).toEqual([15, 1])
})

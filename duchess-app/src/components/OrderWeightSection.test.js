import { createRoot } from 'react-dom/client'
import { act } from 'react'
import OrderWeightSection from './OrderWeightSection'
import { supabase } from '../lib/supabase'
import { resetAtaCatalogCache } from '../lib/orderWeight'

jest.mock('../lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
  },
}))

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true
  resetAtaCatalogCache()
  supabase.from.mockReset()
})

function render(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return new Promise((resolve) => {
    act(() => {
      root.render(element)
    })
    resolve({
      container,
      text() {
        return container.textContent
      },
      async settle() {
        await act(async () => {
          await new Promise((done) => setTimeout(done, 0))
        })
      },
      rerender(next) {
        act(() => {
          root.render(next)
        })
      },
      unmount() {
        act(() => {
          root.unmount()
        })
        container.remove()
      },
    })
  })
}

function mockCatalog(result) {
  supabase.from.mockImplementation(() => ({
    select() {
      return this
    },
    eq() {
      return this
    },
    range() {
      return Promise.resolve(result)
    },
  }))
}

const physicalItem = {
  id: 'line-1',
  item_name: 'Pearl Oval Platter — 40cm',
  quantity: 3,
  opportunity_item_type_name: 'Principal',
  transaction_type_name: 'Rental',
}

describe('OrderWeightSection', () => {
  test('an item-list failure does not show 0 kg and names the failed query', async () => {
    const view = await render(<OrderWeightSection jobId="job-1" items={[]} itemsError />)
    await view.settle()
    expect(view.text()).toContain('The item list could not be loaded. The order weight is not shown.')
    expect(view.text()).not.toContain('The weight catalog could not be loaded.')
    expect(view.text()).not.toMatch(/(^|\D)0 kg/)
    view.unmount()
  })

  test('a weight-catalog failure does not show 0 kg and names the failed query', async () => {
    mockCatalog({ data: null, error: { message: 'catalog offline' } })
    const view = await render(<OrderWeightSection jobId="job-1" items={[physicalItem]} itemsError={false} />)
    await view.settle()
    expect(view.text()).toContain('The weight catalog could not be loaded. The order weight is not shown.')
    expect(view.text()).not.toContain('The item list could not be loaded.')
    expect(view.text()).not.toMatch(/(^|\D)0 kg/)
    expect(view.text()).not.toContain('Remaining capacity')
    view.unmount()
  })

  test('a physical order with no confirmed weight stays partial and does not show 0 kg', async () => {
    mockCatalog({
      data: [{
        name: 'Pearl Oval Platter 40cm',
        unit_name: 'box',
        pieces_per_unit: 3,
        weight_per_unit: '0',
        active: true,
      }],
      error: null,
    })
    const view = await render(<OrderWeightSection jobId="job-1" items={[physicalItem]} itemsError={false} />)
    await view.settle()
    expect(view.text()).toContain('Weight not confirmed')
    expect(view.text()).toContain('No confirmed weight yet. The order total is not available.')
    expect(view.text()).toContain('Weight missing')
    expect(view.text()).not.toMatch(/(^|\D)0 kg/)
    expect(view.text()).not.toContain('Remaining capacity')
    expect(view.text()).not.toContain('Calculated weight')
    view.unmount()
  })

  test('a known partial weight is shown as known so far, not as a finished total', async () => {
    mockCatalog({
      data: [{
        name: 'Pearl Oval Platter 40cm',
        unit_name: 'box',
        pieces_per_unit: 3,
        weight_per_unit: '4.5',
        active: true,
      }],
      error: null,
    })
    const view = await render(
      <OrderWeightSection
        jobId="job-1"
        items={[physicalItem, { ...physicalItem, id: 'line-2', item_name: 'Unlisted Bowl' }]}
        itemsError={false}
      />,
    )
    await view.settle()
    expect(view.text()).toContain('4.5 kg')
    expect(view.text()).toContain('ATA total so far')
    expect(view.text()).toContain('Some physical lines still need a weight.')
    expect(view.text()).not.toContain('Remaining capacity')
    expect(view.text()).not.toContain('Calculated weight')
    view.unmount()
  })

  test('an ambiguous pack stays pending until that order chooses one, and the choice does not follow another order', async () => {
    mockCatalog({
      data: [
        { id: 'light', name: 'Piccadilly Polished Dessert Spoon', unit_name: 'box', pieces_per_unit: 50, weight_per_unit: '4.1', active: true },
        { id: 'heavy', name: 'Piccadilly Polished Dessert Spoon', unit_name: 'box', pieces_per_unit: 100, weight_per_unit: '7.9', active: true },
      ],
      error: null,
    })
    const spoon = {
      id: 'spoon',
      item_name: 'Piccadilly Polished Dessert Spoon',
      quantity: 20,
      opportunity_item_type_name: 'Principal',
      transaction_type_name: 'Rental',
    }
    const view = await render(<OrderWeightSection jobId="job-1" items={[spoon]} itemsError={false} />)
    await view.settle()
    expect(view.text()).toContain('50 per box · 4.1 kg')
    expect(view.text()).toContain('100 per box · 7.9 kg')
    expect(view.text()).toContain('Needs verification')
    expect(view.text()).toContain('Labels / ATA')
    expect(view.text()).not.toContain('Packaging preview: 7.9 kg')
    const buttons = [...view.container.querySelectorAll('button')]
    expect(buttons[0].style.minHeight).toBe('44px')
    expect(buttons[0].style.width).toBe('100%')
    const heavy = buttons.find((button) => button.textContent.includes('box of 100'))
    await act(async () => {
      heavy.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('partly filled')
    expect(view.text()).toContain('not the weight of 20 pieces')
    expect(view.text()).not.toContain('Packaging preview: 7.9 kg')
    expect(view.text()).not.toContain('Calculated weight')
    expect(view.text()).not.toContain('Remaining capacity')
    view.rerender(<OrderWeightSection jobId="job-2" items={[spoon]} itemsError={false} />)
    await view.settle()
    expect(view.text()).toContain('Needs verification')
    expect(view.text()).not.toContain('Packaging preview: 7.9 kg')
    view.unmount()
  })

  test('a dessert-plate suggestion can be confirmed without becoming a vehicle recommendation', async () => {
    mockCatalog({
      data: [
        { id: 'small', name: 'Prima Dessert Plate', unit_name: 'box', pieces_per_unit: 15, weight_per_unit: '6.3', active: true },
        { id: 'large', name: 'Prima Dessert Plate', unit_name: 'box', pieces_per_unit: 30, weight_per_unit: '16.1', active: true },
      ],
      error: null,
    })
    const plate = {
      id: 'plate',
      item_name: 'Prima Dessert Plate',
      quantity: 30,
      opportunity_item_type_name: 'Principal',
      transaction_type_name: 'Rental',
    }
    const view = await render(
      <OrderWeightSection
        jobId="job-1"
        items={[plate, { ...plate, id: 'gap', item_name: 'Unlisted Bowl', quantity: 4 }]}
        itemsError={false}
      />,
    )
    await view.settle()
    expect(view.text()).toContain('Select Labels packing')
    expect(view.text()).not.toContain('Confirm Labels suggestion')
    expect(view.text()).toContain('1 box of 30')
    expect(view.text()).toContain('2 boxes of 15')
    expect(view.text()).toContain('Other packing options')
    expect(view.text()).toContain('not confirmed')
    expect(view.text()).not.toContain('Remaining capacity')
    const otherOptions = [...view.container.querySelectorAll('summary')].find((summary) => summary.textContent.includes('Other packing options'))
    expect(otherOptions.style.minHeight).toBe('44px')
    expect(otherOptions.parentElement.open).toBe(false)
    const suggestion = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('1 box of 30'))
    expect(suggestion.style.minHeight).toBe('44px')
    expect(suggestion.style.width).toBe('100%')
    await act(async () => {
      suggestion.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('Include ATA full-pack total')
    expect(view.text()).toContain('ATA full-pack total: not included')
    expect(view.text()).not.toContain('Confirmed weight: 16.1 kg')
    expect(view.text()).not.toContain('Remaining capacity')
    const confirm = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('Include ATA full-pack total'))
    await act(async () => {
      confirm.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('ATA full-pack total included: 16.1 kg')
    expect(view.text()).toContain('It is not a scale measurement of this order.')
    expect(view.text()).not.toContain('Confirmed weight: 12.6 kg')
    expect(view.text()).not.toContain('Remaining capacity')
    const clear = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('Clear packing'))
    await act(async () => {
      clear.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('ATA full-pack total: not included')
    expect(view.text()).not.toContain('Remaining capacity')
    view.unmount()
  })

  test('70 dinner knives show two different allowances and neither one confirms the weight', async () => {
    mockCatalog({
      data: [
        { id: 'knife-50', name: 'Piccadilly Polished Dinner Knife', unit_name: 'box', pieces_per_unit: 50, weight_per_unit: '3.8', active: true },
        { id: 'knife-90', name: 'Piccadilly Polished Dinner Knife', unit_name: 'box', pieces_per_unit: 90, weight_per_unit: '7.4', active: true },
      ],
      error: null,
    })
    const knife = {
      id: 'knife',
      item_name: 'Piccadilly Polished Dinner Knife',
      quantity: 70,
      opportunity_item_type_name: 'Principal',
      transaction_type_name: 'Rental',
    }
    const view = await render(<OrderWeightSection jobId="job-1" items={[knife]} itemsError={false} />)
    await view.settle()
    expect(view.text()).toContain('Select Labels packing')
    expect(view.text()).toContain('70 in a box of 90, 20 empty')
    expect(view.text()).toContain('Planning allowance: 7.4 kg')
    expect(view.text()).toContain('Other packing options')
    expect(view.text()).toContain('7.6 kg')
    expect(view.text()).toContain('does not divide that weight by the number of pieces')
    expect(view.text()).toContain('Planning allowance: not selected')
    expect(view.text()).not.toContain('Confirmed weight: 7.4 kg')
    expect(view.text()).not.toContain('Confirmed weight: 7.6 kg')
    expect(view.text()).not.toContain('Remaining capacity')
    const suggestion = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('box of 90'))
    await act(async () => {
      suggestion.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('Planning allowance: 7.4 kg. Provisional full-box gross weight.')
    expect(view.text()).toContain('ATA full-pack total: not included')
    expect(view.text()).not.toContain('Calculated weight')
    const alternative = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('box of 50'))
    await act(async () => {
      alternative.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('Planning allowance: 7.6 kg. Provisional full-box gross weight.')
    expect(view.text()).toContain('ATA full-pack total: not included')
    expect(view.text()).not.toContain('Planning allowance: 7.4 kg. Provisional full-box gross weight.')
    view.unmount()
  })

  test('Eclipse plate combinations share one verified weight and stay out of the Luton recommendation', async () => {
    mockCatalog({
      data: [
        { id: 'fifteen', name: 'Eclipse Dessert Plate', unit_name: 'box', pieces_per_unit: 15, weight_per_unit: '10.7', active: true },
        { id: 'thirty', name: 'Eclipse Dessert Plate', unit_name: 'box', pieces_per_unit: 30, weight_per_unit: '21.4', active: true },
      ],
      error: null,
    })
    const plate = {
      id: 'plate',
      item_name: 'Eclipse Dessert Plate',
      quantity: 150,
      opportunity_item_type_name: 'Principal',
      transaction_type_name: 'Rental',
    }
    const view = await render(
      <OrderWeightSection
        jobId="job-1"
        items={[plate, { ...plate, id: 'gap', item_name: 'Unlisted Bowl', quantity: 1 }]}
        itemsError={false}
      />,
    )
    await view.settle()
    expect(view.text().match(/107 kg/g)).toHaveLength(2)
    expect(view.text()).toContain('Same ATA full-pack total: 107 kg')
    expect(view.text()).toContain('5 boxes of 30')
    expect(view.text()).toContain('4 boxes of 30')
    expect(view.text()).toContain('2 boxes of 15')
    expect(view.text()).toContain('ATA full-pack total: not included')
    expect(view.text()).not.toContain('Remaining capacity')
    const other = [...view.container.querySelectorAll('summary')].find((summary) => summary.textContent.includes('Other packing options'))
    expect(other.parentElement.open).toBe(false)
    const alternate = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('4 boxes of 30'))
    await act(async () => {
      alternate.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).not.toContain('Confirmed weight: 107 kg')
    const confirm = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('Include ATA full-pack total'))
    await act(async () => {
      confirm.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('ATA full-pack total included: 107 kg')
    expect(view.text()).toContain('It is not a scale measurement of this order.')
    expect(view.text()).not.toContain('Confirmed weight: 214 kg')
    expect(view.text()).not.toContain('Remaining capacity')
    view.rerender(
      <OrderWeightSection
        jobId="job-1"
        items={[{ ...plate, quantity: 20 }, { ...plate, id: 'gap', item_name: 'Unlisted Bowl', quantity: 1 }]}
        itemsError={false}
      />,
    )
    await view.settle()
    expect(view.text()).not.toContain('Confirmed weight: 107 kg')
    expect(view.text()).toContain('Planning allowance: 21.4 kg')
    expect(view.text()).not.toContain('14.267')
    view.unmount()
  })
})

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
    expect(view.text()).toContain('Weight estimate unavailable')
    expect(view.text()).toContain('No weight recorded in ATA Carnet.')
    expect(view.text()).not.toContain('Weight missing')
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
    expect(view.text()).toContain('Partial weight estimate · 1 item excluded')
    expect(view.text()).toContain('Unlisted Bowl — Not found in ATA Carnet.')
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
    expect(view.text()).toContain('Automatic packing')
    expect(view.text()).toContain('Proportional estimate: 1.64 kg')
    expect(view.text()).toContain('Full-box limit: 4.1 kg')
    expect(view.text()).not.toContain('Packaging preview: 7.9 kg')
    const buttons = [...view.container.querySelectorAll('button')]
    expect(buttons[0].style.minHeight).toBe('44px')
    expect(buttons[0].style.width).toBe('100%')
    const heavy = buttons.find((button) => button.textContent.includes('box of 100'))
    await act(async () => {
      heavy.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('Proportional estimate: 1.58 kg')
    expect(view.text()).toContain('Full-box limit: 7.9 kg')
    expect(view.text()).not.toContain('Packaging preview: 7.9 kg')
    expect(view.text()).not.toContain('Calculated weight')
    expect(view.text()).not.toContain('Remaining capacity')
    view.rerender(<OrderWeightSection jobId="job-2" items={[spoon]} itemsError={false} />)
    await view.settle()
    expect(view.text()).toContain('Automatic packing')
    expect(view.text()).toContain('Proportional estimate: 1.64 kg')
    expect(view.text()).not.toContain('Selected packing')
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
    expect(view.text()).toContain('Automatic packing')
    expect(view.text()).not.toContain('Confirm Labels suggestion')
    expect(view.text()).toContain('1 box of 30')
    expect(view.text()).toContain('2 boxes of 15')
    expect(view.text()).toContain('Change packing')
    expect(view.text()).toContain('ATA full-pack total included: 16.1 kg')
    expect(view.text()).toContain('It is not a scale measurement of this order.')
    expect(view.text()).not.toContain('Remaining capacity')
    const otherOptions = [...view.container.querySelectorAll('summary')].find((summary) => summary.textContent.includes('Change packing'))
    expect(otherOptions.style.minHeight).toBe('44px')
    expect(otherOptions.parentElement.open).toBe(false)
    const alternative = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('2 boxes of 15'))
    expect(alternative.style.minHeight).toBe('44px')
    expect(alternative.style.width).toBe('100%')
    await act(async () => {
      alternative.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('ATA full-pack total included: 12.6 kg')
    expect(view.text()).not.toContain('Confirmed weight: 16.1 kg')
    expect(view.text()).not.toContain('Remaining capacity')
    const restore = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('Use automatic packing'))
    await act(async () => {
      restore.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('ATA full-pack total included: 16.1 kg')
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
    expect(view.text()).toContain('Automatic packing')
    expect(view.text()).toContain('70 in a box of 90, 20 empty')
    expect(view.text()).toContain('Proportional estimate: 5.756 kg')
    expect(view.text()).toContain('Full-box limit: 7.4 kg')
    expect(view.text()).toContain('Change packing')
    expect(view.text()).toContain('7.6 kg')
    expect(view.text()).not.toContain('Needs empty-box tare')
    expect(view.text()).not.toContain('does not divide that weight by the number of pieces')
    expect(view.text()).not.toContain('Confirmed weight: 7.4 kg')
    expect(view.text()).not.toContain('Confirmed weight: 7.6 kg')
    expect(view.text()).not.toContain('Remaining capacity')
    expect(view.text()).toContain('ATA full-pack total: not included')
    expect(view.text()).toContain('Automatically estimated from ATA Carnet')
    expect(view.text()).not.toContain('One Luton')
    expect(headlineKg(view)).toBe('≈ 6 kg')
    expect(calculationDetails(view).open).toBe(false)
    const alternative = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('box of 50'))
    await act(async () => {
      alternative.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).toContain('Proportional estimate: 5.32 kg')
    expect(headlineKg(view)).toBe('≈ 5 kg')
    expect(view.text()).toContain('Full-box limit: 7.6 kg')
    expect(view.text()).toContain('ATA full-pack total: 3.8 kg')
    expect(view.text()).not.toContain('One Luton')
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
    expect(view.text()).toContain('ATA full-pack total included: 107 kg')
    expect(view.text()).toContain('Same ATA full-pack total: 107 kg')
    expect(view.text()).toContain('5 boxes of 30')
    expect(view.text()).toContain('4 boxes of 30')
    expect(view.text()).toContain('2 boxes of 15')
    expect(view.text()).toContain('ATA full-pack total: 107 kg')
    expect(view.text()).toContain('Partial weight estimate · 1 item excluded')
    expect(view.text()).toContain('Unlisted Bowl — Not found in ATA Carnet.')
    expect(headlineKg(view)).toBe('107 kg')
    expect(view.text()).not.toContain('Remaining capacity')
    expect(narrowStack(view).style.flexDirection).toBe('column')
    expect(narrowStack(view).style.minWidth).toBe('0px')
    const other = [...view.container.querySelectorAll('summary')].find((summary) => summary.textContent.includes('Change packing'))
    expect(other.parentElement.open).toBe(false)
    const alternate = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('4 boxes of 30'))
    await act(async () => {
      alternate.click()
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(view.text()).not.toContain('Confirmed weight: 107 kg')
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
    expect(view.text()).toContain('Full-box limit: 21.4 kg')
    expect(view.text()).toContain('Partial weight estimate · 1 item excluded')
    expect(headlineKg(view)).toBe('≈ 14 kg')
    expect(view.text()).toContain('Unlisted Bowl — Not found in ATA Carnet.')
    expect(view.text()).not.toContain('One Luton')
    view.unmount()
  })

  test('the Royal Academy mix shows the planning total instead of the ATA full-pack alone', async () => {
    const cutlery = [
      ['Piccadilly Polished Dinner Knife', '3.9', '7.4', 50, 90],
      ['Piccadilly Polished Dinner Fork', '4.7', '8.4', 50, 90],
      ['Piccadilly Polished Dessert Spoon', '4.1', '7.9', 50, 100],
      ['Piccadilly Polished Starter Knife', '3.5', '6.2', 50, 100],
      ['Piccadilly Polished Starter/ Dessert Fork', '3.8', '7.2', 50, 100],
      ['Piccadilly Polished Tea Spoon', '3.6', '6.4', 80, 150],
    ]
    mockCatalog({
      data: [
        { id: 'dinner', name: 'Eclipse Dinner Plate', unit_name: 'box', pieces_per_unit: 15, weight_per_unit: '15.1', active: true },
        { id: 'dessert-15', name: 'Eclipse Dessert Plate', unit_name: 'box', pieces_per_unit: 15, weight_per_unit: '10.7', active: true },
        { id: 'dessert-30', name: 'Eclipse Dessert Plate', unit_name: 'box', pieces_per_unit: 30, weight_per_unit: '21.4', active: true },
        ...cutlery.flatMap(([name, light, heavy, small, large]) => [
          { id: `${name}-small`, name, unit_name: 'box', pieces_per_unit: small, weight_per_unit: light, active: true },
          { id: `${name}-large`, name, unit_name: 'box', pieces_per_unit: large, weight_per_unit: heavy, active: true },
        ]),
      ],
      error: null,
    })
    const items = [
      { id: 'dinner', item_name: 'Eclipse Dinner Plate', quantity: 75, opportunity_item_type_name: 'Principal', transaction_type_name: 'Rental' },
      { id: 'dessert', item_name: 'Eclipse Dessert Plate', quantity: 150, opportunity_item_type_name: 'Principal', transaction_type_name: 'Rental' },
      ...cutlery.map(([name], index) => ({
        id: `cutlery-${index}`,
        item_name: name,
        quantity: 70,
        opportunity_item_type_name: 'Principal',
        transaction_type_name: 'Rental',
      })),
    ]
    const view = await render(<OrderWeightSection jobId="job-1" items={items} itemsError={false} />)
    await view.settle()
    expect(headlineKg(view)).toBe('≈ 213 kg')
    expect(view.text()).toContain('Operational total: 212.849 kg')
    expect(view.text()).toContain('Automatically estimated from ATA Carnet')
    expect(view.text()).toContain('ATA full-pack total: 182.5 kg')
    expect(view.text()).toContain('Full-box limit: 40.7 kg')
    expect(view.text()).not.toContain('without a usable weight')
    expect(view.text()).not.toContain('Measured weight')
    expect(view.text()).not.toContain('One Luton')
    expect(calculationDetails(view).open).toBe(false)
    expect(view.container.querySelector('section div').style.background).not.toBe('rgb(250, 238, 218)')
    expect(narrowStack(view).style.flexDirection).toBe('column')
    expect(narrowStack(view).style.minWidth).toBe('0px')
    view.unmount()
  })

  test('three excluded products show two names and keep the card neutral', async () => {
    mockCatalog({ data: [], error: null })
    const longName = 'Duchess Drape Iris White Tablecloth 245cm x 350cm (96 inch by 137 inch) Special Hem'
    const items = [longName, 'Second Missing Bowl', 'Third Missing Plate'].map((name, index) => ({
      id: `missing-${index}`,
      item_name: name,
      quantity: 1,
      opportunity_item_type_name: 'Principal',
      transaction_type_name: 'Rental',
    }))
    const view = await render(<OrderWeightSection jobId="job-1" items={items} itemsError={false} />)
    await view.settle()
    expect(view.text()).toContain('Weight estimate unavailable')
    expect(view.text()).not.toContain('Partial weight estimate')
    expect(view.text()).toContain(`${longName} — Not found in ATA Carnet.`)
    expect(view.text()).toContain('Second Missing Bowl — Not found in ATA Carnet.')
    expect(view.text()).toContain('1 more item is listed in Calculation details.')
    const summary = view.container.querySelector('section').children[1].textContent
    expect(summary).not.toContain('Third Missing Plate')
    expect(view.text()).toContain('Third Missing Plate — Not found in ATA Carnet.')
    const card = view.container.querySelector('section').children[1]
    expect(card.style.background).toBe('rgb(247, 243, 238)')
    expect(calculationDetails(view).open).toBe(false)
    view.unmount()
  })
})

function headlineKg(view) {
  return [...view.container.querySelectorAll('div')].find((node) => node.style.fontSize === '20px').textContent
}

function calculationDetails(view) {
  return [...view.container.querySelectorAll('details')].find((node) => node.querySelector('summary').textContent.includes('Calculation details'))
}

function narrowStack(view) {
  return [...view.container.querySelectorAll('div')].find((node) => node.style.flexDirection === 'column' && node.style.gap === '8px')
}

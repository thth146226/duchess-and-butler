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
    expect(view.text()).toContain('Known weight so far')
    expect(view.text()).toContain('Some physical lines still need a weight.')
    expect(view.text()).not.toContain('Remaining capacity')
    expect(view.text()).not.toContain('Calculated weight')
    view.unmount()
  })
})

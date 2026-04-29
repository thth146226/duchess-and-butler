import { isDbLinenStudioItem, isNonLabelJobItem } from './labelGenerator'

export function isFurnitureOrLargeHireItem(jobItem) {
  const itemName = (jobItem?.item_name || '').toLowerCase()
  const category = (jobItem?.category || '').toLowerCase()

  // Guardrail: never exclude known operational label items.
  const operationalSignals = [
    'charger plate',
    'dinner plate',
    'side plate',
    'starter plate',
    'glass',
    'cutlery',
    'fork',
    'knife',
    'spoon',
    'candle sleeve',
    'hurricane candle sleeve',
    'table lamp',
    'lamp',
  ]
  if (operationalSignals.some(signal => itemName.includes(signal))) return false

  const furnitureCategorySignals = [
    'furniture',
    'seating',
    'parasol',
    'large hire',
    'large_hire',
    'lounge',
  ]
  if (furnitureCategorySignals.some(signal => category.includes(signal))) return true

  const furnitureNameSignals = [
    'sofa',
    'seater',
    'individual seat',
    ' seat ',
    ' seat,',
    ' seat.',
    ' chair',
    'armchair',
    'furniture',
    'coffee table',
    'side table',
    'dining table',
    'console table',
    'parasol',
    'parasol base',
    'cushion',
    'chusion',
    'bench',
    'stool',
    'lounge',
    'ottoman',
    'pouf',
  ]
  const normalizedWithPadding = ` ${itemName.replace(/\s+/g, ' ').trim()} `
  return furnitureNameSignals.some(signal => normalizedWithPadding.includes(signal))
}

export function isServiceOrFeeNonPhysicalItem(jobItem) {
  const itemName = (jobItem?.item_name || '').toLowerCase()
  const category = (jobItem?.category || '').toLowerCase()
  const normalizedWithPadding = ` ${itemName.replace(/\s+/g, ' ').trim()} `

  // Guardrail: keep clearly physical operational/furniture items out of this exclusion.
  const physicalGuardrails = [
    'cake stand',
    'stand',
    'table lamp',
    'lamp',
    'sleeve',
    'charger',
    'plate',
    'glass',
    'cutlery',
    'fork',
    'knife',
    'spoon',
    'chair',
    'sofa',
    'parasol',
  ]
  if (physicalGuardrails.some(signal => normalizedWithPadding.includes(` ${signal} `))) return false

  const serviceCategorySignals = [
    'service',
    'admin',
    'fee',
    'surcharge',
    'supplement',
    'labour',
    'labor',
    'transport',
    'carnet',
    'non-physical',
    'non physical',
  ]
  if (serviceCategorySignals.some(signal => category.includes(signal))) return true

  const serviceNameSignals = [
    'production service',
    'art direction',
    'event design',
    'service',
    'minimum hire surcharge',
    'surcharge',
    'timed collection fee',
    'collection fee',
    'delivery fee',
    'admin fee',
    'date change admin fee',
    'setup fee',
    'set up fee',
    'install fee',
    'installation fee',
    'transport fee',
    'transport supplement',
    'extended hire period supplement',
    'hire period supplement',
    'supplement',
    'labour',
    'labor',
    'carnet',
  ]

  return serviceNameSignals.some(signal => normalizedWithPadding.includes(` ${signal} `))
}

export function isDisplayOrPropItem(jobItem) {
  const itemName = (jobItem?.item_name || '').toLowerCase()
  const category = (jobItem?.category || '').toLowerCase()
  const normalizedWithPadding = ` ${itemName.replace(/\s+/g, ' ').trim()} `

  // Guardrail: never exclude known operational label items via display/prop logic.
  const operationalSignals = [
    'charger plate',
    'dinner plate',
    'side plate',
    'starter plate',
    'dessert plate',
    'glass',
    'cutlery',
    'fork',
    'knife',
    'spoon',
    'candle sleeve',
    'hurricane candle sleeve',
    'table lamp',
    'lamp',
  ]
  if (operationalSignals.some(signal => normalizedWithPadding.includes(` ${signal} `))) return false

  const displayCategorySignals = ['display', 'prop', 'props', 'styling prop', 'event prop']
  if (displayCategorySignals.some(signal => category.includes(signal))) return true

  const displayNameSignals = [
    'acrylic easel',
    'floor standing acrylic easel',
    'display easel',
    'display stand',
    'menu stand',
    'sign stand',
    'plinth',
    'pedestal',
    'backdrop stand',
    'cake stand',
    'three tiered cake stand',
    'tiered cake stand',
    ' prop ',
    ' props ',
  ]
  return displayNameSignals.some(signal => normalizedWithPadding.includes(signal))
}

export function classifyJobItemWorkflow(jobItem) {
  const qty = Number.parseInt(jobItem?.quantity, 10)
  if (isNonLabelJobItem(jobItem?.item_name, qty)) {
    return { workflowType: 'ignored', reason: 'non-label-or-invalid-quantity', label: 'Ignored' }
  }
  if (isDbLinenStudioItem(jobItem)) {
    return { workflowType: 'linen', reason: 'db-linen-studio', label: 'DB Linen Studio' }
  }
  if (isFurnitureOrLargeHireItem(jobItem)) {
    return { workflowType: 'furniture_large_hire', reason: 'furniture-large-hire', label: 'Furniture / Large Hire' }
  }
  if (isServiceOrFeeNonPhysicalItem(jobItem)) {
    return { workflowType: 'service_fee', reason: 'service-fee-non-physical', label: 'Service / Fee' }
  }
  if (isDisplayOrPropItem(jobItem)) {
    return { workflowType: 'display_prop', reason: 'display-prop-non-label', label: 'Display / Prop' }
  }
  return { workflowType: 'operational_candidate', reason: 'candidate-for-ata-matching', label: 'Operational Candidate' }
}

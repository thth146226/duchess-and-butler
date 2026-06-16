// Server-only operational item change event helpers.
// Never import from frontend/src code.

const ALLOWED_SOURCES = new Set([
  'manual_rms_refresh',
  'global_sync',
  'backfill',
  'system',
])

const SEVERITY_BY_CHANGE_TYPE = {
  item_added: 'high',
  item_quantity_changed: 'high',
  item_removed: 'high',
  item_changed: 'medium',
}

function normText(value) {
  return String(value ?? '').trim()
}

function normQty(value) {
  const qty = Number.parseInt(value, 10)
  return Number.isFinite(qty) ? qty : 0
}

export function isOperationalChangeEventsEnabled() {
  return process.env.OPERATIONAL_CHANGE_EVENTS_ENABLED === 'true'
}

export function isAllowedOperationalEventSource(source) {
  return ALLOWED_SOURCES.has(source)
}

export function buildIdempotencyKey({
  source,
  jobId,
  changeType,
  itemKey,
  oldQuantity = null,
  newQuantity = null,
  oldValue = '',
  newValue = '',
}) {
  const jobPart = normText(jobId) || 'unknown-job'
  const itemPart = normText(itemKey) || 'unknown-item'
  const oldQtyPart = oldQuantity == null ? 'null' : String(oldQuantity)
  const newQtyPart = newQuantity == null ? 'null' : String(newQuantity)
  const oldValPart = normText(oldValue)
  const newValPart = normText(newValue)

  return [
    normText(source) || 'unknown-source',
    jobPart,
    normText(changeType) || 'unknown-type',
    itemPart,
    oldQtyPart,
    newQtyPart,
    oldValPart,
    newValPart,
  ].join(':')
}

function classifyChangedRow(changeRow) {
  const local = changeRow?.local || {}
  const rms = changeRow?.rms || {}
  const oldQty = normQty(local.quantity)
  const newQty = normQty(rms.quantity)
  const oldName = normText(local.item_name)
  const newName = normText(rms.item_name)
  const oldCategory = normText(local.category)
  const newCategory = normText(rms.category)

  if (oldQty !== newQty) {
    return {
      change_type: 'item_quantity_changed',
      severity: SEVERITY_BY_CHANGE_TYPE.item_quantity_changed,
      item_key: normText(changeRow.crms_item_id),
      item_name: newName || oldName,
      item_category: newCategory || oldCategory,
      old_value: String(oldQty),
      new_value: String(newQty),
      old_quantity: oldQty,
      new_quantity: newQty,
      quantity_delta: newQty - oldQty,
      payload: {
        crms_item_id: changeRow.crms_item_id,
        old_item_name: oldName,
        new_item_name: newName,
        old_category: oldCategory,
        new_category: newCategory,
      },
    }
  }

  return {
    change_type: 'item_changed',
    severity: SEVERITY_BY_CHANGE_TYPE.item_changed,
    item_key: normText(changeRow.crms_item_id),
    item_name: newName || oldName,
    item_category: newCategory || oldCategory,
    old_value: [oldName, oldCategory].filter(Boolean).join(' / ') || null,
    new_value: [newName, newCategory].filter(Boolean).join(' / ') || null,
    old_quantity: oldQty,
    new_quantity: newQty,
    quantity_delta: 0,
    payload: {
      crms_item_id: changeRow.crms_item_id,
      old_item_name: oldName,
      new_item_name: newName,
      old_category: oldCategory,
      new_category: newCategory,
    },
  }
}

function buildAddedEventRow({ job, row, source }) {
  const newQty = normQty(row.quantity)
  const itemKey = normText(row.crms_item_id)
  const itemName = normText(row.item_name)
  const itemCategory = normText(row.category)

  return {
    job_id: job?.id || null,
    crms_id: job?.crms_id ? String(job.crms_id) : null,
    job_ref: job?.crms_ref ? String(job.crms_ref) : null,
    event_name: job?.event_name ? String(job.event_name) : null,
    change_type: 'item_added',
    severity: SEVERITY_BY_CHANGE_TYPE.item_added,
    source,
    item_key: itemKey || null,
    item_name: itemName || null,
    item_category: itemCategory || null,
    old_value: null,
    new_value: itemName ? `${itemName} x${newQty}` : String(newQty),
    old_quantity: null,
    new_quantity: newQty,
    quantity_delta: newQty,
    payload: {
      crms_item_id: itemKey || null,
      item_name: itemName || null,
      category: itemCategory || null,
    },
    idempotency_key: buildIdempotencyKey({
      source,
      jobId: job?.id,
      changeType: 'item_added',
      itemKey,
      oldQuantity: null,
      newQuantity: newQty,
      oldValue: '',
      newValue: itemName,
    }),
  }
}

function buildChangedEventRow({ job, changeRow, source }) {
  const classified = classifyChangedRow(changeRow)

  return {
    job_id: job?.id || null,
    crms_id: job?.crms_id ? String(job.crms_id) : null,
    job_ref: job?.crms_ref ? String(job.crms_ref) : null,
    event_name: job?.event_name ? String(job.event_name) : null,
    change_type: classified.change_type,
    severity: classified.severity,
    source,
    item_key: classified.item_key || null,
    item_name: classified.item_name || null,
    item_category: classified.item_category || null,
    old_value: classified.old_value,
    new_value: classified.new_value,
    old_quantity: classified.old_quantity,
    new_quantity: classified.new_quantity,
    quantity_delta: classified.quantity_delta,
    payload: classified.payload,
    idempotency_key: buildIdempotencyKey({
      source,
      jobId: job?.id,
      changeType: classified.change_type,
      itemKey: classified.item_key,
      oldQuantity: classified.old_quantity,
      newQuantity: classified.new_quantity,
      oldValue: classified.old_value,
      newValue: classified.new_value,
    }),
  }
}

function buildRemovedEventRow({ job, row, source }) {
  const oldQty = normQty(row.quantity)
  const itemKey = normText(row.crms_item_id)
  const itemName = normText(row.item_name)
  const itemCategory = normText(row.category)

  return {
    job_id: job?.id || null,
    crms_id: job?.crms_id ? String(job.crms_id) : null,
    job_ref: job?.crms_ref ? String(job.crms_ref) : null,
    event_name: job?.event_name ? String(job.event_name) : null,
    change_type: 'item_removed',
    severity: SEVERITY_BY_CHANGE_TYPE.item_removed,
    source,
    item_key: itemKey || null,
    item_name: itemName || null,
    item_category: itemCategory || null,
    old_value: itemName ? `${itemName} x${oldQty}` : String(oldQty),
    new_value: null,
    old_quantity: oldQty,
    new_quantity: null,
    quantity_delta: -oldQty,
    payload: {
      crms_item_id: itemKey || null,
      item_name: itemName || null,
      category: itemCategory || null,
    },
    idempotency_key: buildIdempotencyKey({
      source,
      jobId: job?.id,
      changeType: 'item_removed',
      itemKey,
      oldQuantity: oldQty,
      newQuantity: null,
      oldValue: itemName,
      newValue: '',
    }),
  }
}

export function buildOperationalItemChangeEventRows({ job, diff, source = 'manual_rms_refresh' }) {
  if (!job || !diff || !ALLOWED_SOURCES.has(source)) {
    return []
  }

  const rows = []

  for (const addedRow of diff.added || []) {
    rows.push(buildAddedEventRow({ job, row: addedRow, source }))
  }

  for (const changeRow of diff.changed || []) {
    rows.push(buildChangedEventRow({ job, changeRow, source }))
  }

  for (const staleRow of diff.stale || []) {
    rows.push(buildRemovedEventRow({ job, row: staleRow, source }))
  }

  return rows
}

function emptyResult(enabled) {
  return {
    enabled,
    attempted: 0,
    insertedOrUpserted: 0,
    skipped: 0,
    errors: [],
    insertedRows: [],
  }
}

const INSERTED_ROW_SELECT = [
  'id',
  'job_id',
  'crms_id',
  'job_ref',
  'event_name',
  'change_type',
  'severity',
  'source',
  'item_key',
  'item_name',
  'item_category',
  'old_value',
  'new_value',
  'old_quantity',
  'new_quantity',
  'quantity_delta',
  'payload',
  'detected_at',
  'idempotency_key',
].join(', ')

export async function createOperationalItemChangeEvents({
  supabase,
  job,
  diff,
  source = 'manual_rms_refresh',
}) {
  const enabled = isOperationalChangeEventsEnabled()
  if (!enabled) {
    return emptyResult(false)
  }

  if (!supabase) {
    return {
      ...emptyResult(true),
      errors: ['Supabase client is required to persist operational change events.'],
    }
  }

  if (!ALLOWED_SOURCES.has(source)) {
    return {
      ...emptyResult(true),
      errors: [`Unsupported operational event source: ${source}`],
    }
  }

  const rows = buildOperationalItemChangeEventRows({ job, diff, source })
  if (rows.length === 0) {
    return emptyResult(true)
  }

  try {
    const { data, error } = await supabase
      .from('operational_change_events')
      .upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      .select(INSERTED_ROW_SELECT)

    if (error) {
      return {
        enabled: true,
        attempted: rows.length,
        insertedOrUpserted: 0,
        skipped: 0,
        errors: [error.message],
        insertedRows: [],
      }
    }

    const insertedRows = Array.isArray(data) ? data : []
    const insertedOrUpserted = insertedRows.length
    const skipped = Math.max(0, rows.length - insertedOrUpserted)

    return {
      enabled: true,
      attempted: rows.length,
      insertedOrUpserted,
      skipped,
      errors: [],
      insertedRows,
    }
  } catch (err) {
    return {
      enabled: true,
      attempted: rows.length,
      insertedOrUpserted: 0,
      skipped: 0,
      errors: [err?.message || 'Failed to persist operational change events.'],
      insertedRows: [],
    }
  }
}

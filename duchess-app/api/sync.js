// Duchess & Butler — Current RMS Sync Engine v8
// ONE-WAY ONLY: Current RMS → Supabase (never the reverse)
//
// FIXES in v8:
//   - Issue 3: Only imports CONFIRMED orders — quotes/drafts/open are excluded
//   - Issue 4: Captures full venue address (street, city, postcode)
//   - Issue 4: Syncs order items for ALL jobs (not just new ones)
//   - Delivery/collection dates read from deliver_starts_at / collect_starts_at

import { createClient } from '@supabase/supabase-js'

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY   = process.env.CRMS_API_KEY
const SUPABASE_URL   = process.env.SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY

const CRMS_BASE = `https://api.current-rms.com/api/v1`

// TEMP DEBUG: classify ORDER vs QUOTATION for Schedule correctness.
// Enable with:
//   DEBUG_CRMS_CLASSIFICATION=1
// Optionally narrow to specific RMS ids/refs:
//   DEBUG_CRMS_IDS="7723,7720"
const DEBUG_CRMS_CLASSIFICATION = process.env.DEBUG_CRMS_CLASSIFICATION === '1'
const DEBUG_CRMS_IDS = (process.env.DEBUG_CRMS_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// ── helpers ───────────────────────────────────────────────────────────────────

function crmsHeaders() {
  return {
    'X-AUTH-TOKEN': CRMS_API_KEY,
    'X-SUBDOMAIN':  CRMS_SUBDOMAIN,
    'Content-Type': 'application/json',
  }
}

async function crmsGet(path, params = {}) {
  const url = new URL(`${CRMS_BASE}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url.toString(), { headers: crmsHeaders() })
  if (!res.ok) throw new Error(`Current RMS ${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

async function fetchAllPages(path, key, params = {}) {
  let page = 1, all = []
  while (true) {
    const data = await crmsGet(path, { ...params, page, per_page: 50 })
    const items = data[key] || []
    console.log(`Page ${page}: ${items.length} items, total so far: ${all.length + items.length}`)
    all = all.concat(items)
    if (items.length < 50) break
    page++
  }
  return all
}

function toDate(iso) { return iso ? iso.slice(0, 10) : null }
function toTime(iso) { return iso ? iso.slice(11, 16) : null }

// ── ISSUE 3: Status filter ────────────────────────────────────────────────────
//
// Current RMS opportunity_status_name values confirmed from the API:
//   "Confirmed"  → import ✅
//   "Booked"     → import ✅
//   "Prepared"   → import ✅  (prepared = confirmed in CRMS workflow)
//   "Open"       → SKIP ❌   (open = quote/unconfirmed)
//   "Draft"      → SKIP ❌
//   "Quote"      → SKIP ❌
//   "Cancelled"  → SKIP ❌
//   "Invoiced"   → import ✅  (already happened, keep for records)
//   "Completed"  → import ✅

function shouldImport(o) {
  const state = o.state == null ? null : Number(o.state)
  if (state === 1) return false  // Draft only
  const s = (o.opportunity_status_name || '').toLowerCase()
  if (s === 'cancelled' || s === 'lost') return false
  return true
}

function mapStatus(crmsStatus) {
  const s = (crmsStatus || '').toLowerCase()
  if (s.includes('cancel'))                                           return 'cancelled'
  if (s.includes('confirm'))                                          return 'confirmed'
  if (s.includes('prepared') || s.includes('booked'))                return 'confirmed'
  if (s.includes('provisional'))                                      return 'confirmed'
  if (s.includes('dispatch'))                                         return 'dispatched'
  if (s.includes('complet') || s.includes('invoic'))                 return 'completed'
  return 'confirmed'  // default for anything that passed shouldImport
}

// ── ORDER vs QUOTATION detection ─────────────────────────────────────────────
//
// Current RMS uses the 'state' numeric field:
//   1 = Quote / Opportunity (not confirmed)
//   2 = Provisional         (not confirmed)  
//   3 = Order               (confirmed — appears in Schedule)
//   4 = Completed / Invoiced (keep for records)
//
// Also check state_name as fallback text matching

function isConfirmedOrder(o) {
  const stateNum = o?.state == null ? null : Number(o.state)
  const orderedAt = o?.ordered_at || null

  // Single binary discriminator for Schedule:
  // Use Current RMS `state` as primary truth:
  // - state 3/4 = Order/confirmed → Schedule
  // - state 1/2 = Quote/quotation/provisional → never Schedule
  //
  // ordered_at is NOT a reliable discriminator by itself (it can be present for quotations).
  if (stateNum === 3 || stateNum === 4) {
    const is_order = true
    if (DEBUG_CRMS_CLASSIFICATION && (DEBUG_CRMS_IDS.length === 0 || DEBUG_CRMS_IDS.includes(String(o.id)) || DEBUG_CRMS_IDS.includes(String(o.number)) || DEBUG_CRMS_IDS.includes(String(o.reference)))) {
      console.log('[crms_classify]', JSON.stringify({
        crms_id: String(o.id),
        crms_ref: o.number || o.reference || null,
        candidates: {
          ordered_at: orderedAt,
          state: o.state,
          state_name: o.state_name,
          opportunity_status_name: o.opportunity_status_name || o.status_name || null,
        },
        is_order,
        include_in_schedule: is_order,
        reason: `state=${stateNum} implies order`
      }))
    }
    return is_order
  }
  if (stateNum === 1 || stateNum === 2) {
    const is_order = false
    if (DEBUG_CRMS_CLASSIFICATION && (DEBUG_CRMS_IDS.length === 0 || DEBUG_CRMS_IDS.includes(String(o.id)) || DEBUG_CRMS_IDS.includes(String(o.number)) || DEBUG_CRMS_IDS.includes(String(o.reference)))) {
      console.log('[crms_classify]', JSON.stringify({
        crms_id: String(o.id),
        crms_ref: o.number || o.reference || null,
        candidates: {
          ordered_at: orderedAt,
          state: o.state,
          state_name: o.state_name,
          opportunity_status_name: o.opportunity_status_name || o.status_name || null,
        },
        is_order,
        include_in_schedule: is_order,
        reason: `state=${stateNum} implies quotation/draft`
      }))
    }
    return is_order
  }

  // Unknown / unparseable state: fail closed for Schedule correctness.
  const is_order = false
  if (DEBUG_CRMS_CLASSIFICATION && (DEBUG_CRMS_IDS.length === 0 || DEBUG_CRMS_IDS.includes(String(o.id)) || DEBUG_CRMS_IDS.includes(String(o.number)) || DEBUG_CRMS_IDS.includes(String(o.reference)))) {
    console.log('[crms_classify]', JSON.stringify({
      crms_id: String(o.id),
      crms_ref: o.number || o.reference || null,
      candidates: {
        ordered_at: orderedAt,
        state: o.state,
        state_name: o.state_name,
        opportunity_status_name: o.opportunity_status_name || o.status_name || null,
      },
      is_order,
      include_in_schedule: is_order,
      reason: 'state not in {1,2,3,4} (fail closed)'
    }))
  }
  return false
}


//
// Current RMS nests venue/destination as an object on the opportunity.
// Fields available: name, address1, address2, town_city, county, postcode, country_name

function extractVenueName(o) {
  // venue_name is a flat field; destination/venue is the nested object
  return (
    o.venue_name ||
    o.destination?.name ||
    o.venue?.name ||
    o.location ||
    ''
  )
}

function extractVenueAddress(o) {
  // Current RMS confirmed field structure from debug:
  // destination: { id, name, street, postcode, city, county, country: { name } }
  // billing_address: { id, name, street, postcode, city, county, country_id, country_name }
  // Both are OBJECTS — must extract individual fields, not pass object as string

  const dest = o.destination || o.billing_address || null

  if (dest && typeof dest === 'object') {
    const parts = [
      dest.street    || dest.address1 || dest.address,
      dest.city      || dest.town_city,
      dest.county,
      dest.postcode,
    ].filter(v => v && typeof v === 'string' && v.trim())

    if (parts.length > 0) {
      // Clean \r\n that sometimes appears inside street field
      return parts.join(', ').replace(/\r\n/g, ', ').replace(/,\s*,/g, ',').trim()
    }
  }

  // Fallback: flat string fields
  if (o.delivery_address && typeof o.delivery_address === 'string') return o.delivery_address
  return null
}

// ── field mapper ──────────────────────────────────────────────────────────────

function mapOpportunity(o) {
  // Delivery dates — read directly from scheduling fields
  const deliveryISO    = o.deliver_starts_at || o.load_starts_at    || null
  const collectionISO  = o.collect_starts_at || o.unload_starts_at  || null
  const eventDateISO   = o.starts_at         || o.deliver_starts_at || null

  return {
    crms_id:          String(o.id),
    crms_ref:         o.number || o.reference || String(o.id),
    event_name:       o.name   || o.subject   || '',
    client_name:      o.member?.name || o.member?.full_name || o.company_name || o.member_name || '',
    client_id:        o.member_id ? String(o.member_id) : null,

    // Venue — name + full address separately
    venue:            extractVenueName(o),
    venue_address:    extractVenueAddress(o),

    // Event dates
    event_date:       toDate(eventDateISO),
    event_ends_at:    toDate(o.ends_at),

    // Delivery
    delivery_date:    toDate(deliveryISO),
    delivery_time:    toTime(deliveryISO),
    delivery_end_time: toTime(o.deliver_ends_at),

    // Collection
    collection_date:  toDate(collectionISO),
    collection_time:  toTime(collectionISO),
    collection_end_time: toTime(o.collect_ends_at),

    // Status
    status:           mapStatus(o.opportunity_status_name || o.status_name || ''),
    crms_status:      o.opportunity_status_name || o.status_name || '',

    // ORDER vs QUOTATION
    // ordered_at = timestamp when converted to Order (RED) in Current RMS
    // null = still a Quotation (ORANGE)
    is_order:         isConfirmedOrder(o),
    ordered_at:       o.ordered_at || null,
    crms_state:       o.state      || null,
    crms_state_name:  o.state_name || null,

    // Content
    notes:                o.description         || o.notes || '',
    special_instructions: o.special_instructions || '',
    total_value:          parseFloat(o.grand_total || o.total || 0),

    // Audit
    crms_raw:         o,
    last_synced_at:   new Date().toISOString(),
    crms_updated_at:  o.updated_at || null,
  }
}

function mapItem(item, crmsOpportunityId, jobId) {
  return {
    job_id:              jobId ? String(jobId) : null,
    crms_opportunity_id: String(crmsOpportunityId),
    crms_item_id:        String(item.id),
    item_name:           item.product_name || item.name || '',
    category:            item.product_group_name || item.category || 'other',
    quantity:            parseInt(item.quantity || item.quantity_reserved || 0),
    unit:                item.rental_price_name || 'unit',
    item_type:           item.type_name || 'rental',
    crms_raw:            item,
  }
}

// ── change detection ──────────────────────────────────────────────────────────

function detectChanges(existing, incoming) {
  const changes = []
  const fields = [
    'event_name', 'client_name', 'venue', 'venue_address', 'event_date',
    'delivery_date', 'delivery_time', 'collection_date', 'collection_time',
    // Keep schedule correctness in sync with classification:
    // when an RMS Quotation becomes an Order (or vice versa) we must update is_order.
    'is_order', 'ordered_at',
    'status', 'notes', 'special_instructions', 'total_value',
  ]
  for (const f of fields) {
    const oldVal = existing[f]
    const newVal = incoming[f]
    if (String(oldVal ?? '') !== String(newVal ?? '')) {
      changes.push({
        field:            f,
        old_value:        String(oldVal ?? ''),
        new_value:        String(newVal ?? ''),
        affects_schedule: ['delivery_date','delivery_time','collection_date','collection_time'].includes(f),
        is_urgent:        f === 'delivery_date' || f === 'delivery_time',
      })
    }
  }
  return changes
}

// ── sync items for a job ──────────────────────────────────────────────────────

async function syncItems(supabase, oppId, jobUuid) {
  try {
    // Current RMS items endpoint
    const data = await crmsGet(`/opportunities/${oppId}/opportunity_items`)
    const items = (data.opportunity_items || data.items || [])
    if (items.length === 0) return { count: 0, error: null }

    const rows = items.map(i => mapItem(i, oppId, jobUuid))

    const { error } = await supabase
      .from('crms_job_items')
      .upsert(rows, { onConflict: 'crms_opportunity_id,crms_item_id', ignoreDuplicates: false })

    if (error) return { count: 0, error: error.message }
    return { count: rows.length, error: null }
  } catch (e) {
    return { count: 0, error: e.message }
  }
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY)
  const startedAt = new Date().toISOString()
  const stats     = {
    fetched: 0, skipped_quotes: 0,
    created: 0, updated: 0, unchanged: 0,
    changes_logged: 0, items_synced: 0,
    item_errors: [],
    errors: [],
  }

  try {
    // ── 1. Fetch ALL opportunities from Current RMS ──────────────────────────
    // No date filter — fetch everything so we don't miss confirmed orders
    // The shouldImport filter handles what gets saved
    // Fetch all opportunities from list
    const allOpportunities = await fetchAllPages('/opportunities', 'opportunities', {})

    // Enrich each with detail endpoint to get state field
    const enriched = await Promise.all(
      allOpportunities.map(async (o) => {
        try {
          const detail = await crmsGet(`/opportunities/${o.id}`)
          return detail.opportunity || o
        } catch {
          return o
        }
      })
    )
    const opportunities = enriched.filter(o => shouldImport(o))
    stats.fetched = enriched.length
    stats.skipped_quotes = enriched.length - opportunities.length

    // ── 2. Load existing Supabase records ────────────────────────────────────
    const { data: existingRecords } = await supabase
      .from('crms_jobs')
      .select('id, crms_id, delivery_date, delivery_time, delivery_end_time, collection_date, collection_time, collection_end_time, status, event_name, client_name, venue, venue_address, notes, special_instructions, total_value, event_date, sync_change_count')

    const existingMap = {}
    for (const r of (existingRecords || [])) existingMap[r.crms_id] = r

    // ── 3. Process each confirmed opportunity ────────────────────────────────
    for (const opp of opportunities) {
      try {
        const mapped   = mapOpportunity(opp)
        const existing = existingMap[mapped.crms_id]

        if (!existing) {
          // ── NEW job ────────────────────────────────────────────────────────
          const { data: inserted, error: insertErr } = await supabase
            .from('crms_jobs')
            .insert(mapped)
            .select('id')
            .single()

          if (insertErr) throw insertErr

          // Sync items immediately for new jobs
          const itemResult = await syncItems(supabase, opp.id, inserted?.id)
          stats.items_synced += itemResult.count
          if (itemResult.error) stats.item_errors.push({ crms_id: opp.id, error: itemResult.error })

          await supabase.from('sync_log').insert({
            crms_id:     mapped.crms_id,
            event_type:  'job_created',
            description: `New: ${mapped.event_name} (${mapped.crms_ref}) · ${itemResult.count} items${itemResult.error ? ' [item error: ' + itemResult.error + ']' : ''}`,
            synced_at:   new Date().toISOString(),
          })

          stats.created++

        } else {
          // ── EXISTING job ───────────────────────────────────────────────────
          const changes = detectChanges(existing, mapped)

          if (changes.length > 0) {
            await supabase
              .from('crms_jobs')
              .update({ ...mapped, sync_change_count: (existing.sync_change_count || 0) + 1 })
              .eq('crms_id', mapped.crms_id)

            for (const change of changes) {
              await supabase.from('change_log').insert({
                crms_id:          mapped.crms_id,
                job_ref:          mapped.crms_ref,
                event_name:       mapped.event_name,
                field_changed:    change.field,
                old_value:        change.old_value,
                new_value:        change.new_value,
                affects_schedule: change.affects_schedule,
                is_urgent:        change.is_urgent,
                detected_at:      new Date().toISOString(),
                source:           'current_rms_sync',
              })
              stats.changes_logged++
            }

            await supabase.from('sync_log').insert({
              crms_id:    mapped.crms_id,
              event_type: 'job_updated',
              description: `${changes.length} change(s): ${changes.map(c => c.field).join(', ')}`,
              synced_at:  new Date().toISOString(),
            })

            stats.updated++
          } else {
            await supabase
              .from('crms_jobs')
              .update({ last_synced_at: new Date().toISOString() })
              .eq('crms_id', mapped.crms_id)
            stats.unchanged++
          }

          // ── Sync items for ALL existing jobs (upsert is idempotent) ──────
          const itemResult = await syncItems(supabase, opp.id, existing.id)
          stats.items_synced += itemResult.count
          if (itemResult.error) stats.item_errors.push({ crms_id: opp.id, error: itemResult.error })
        }

      } catch (jobErr) {
        stats.errors.push({ crms_id: opp.id, error: jobErr.message })
      }
    }

    // ── 4. Record sync run ───────────────────────────────────────────────────
    await supabase.from('sync_runs').insert({
      started_at:     startedAt,
      completed_at:   new Date().toISOString(),
      jobs_fetched:   stats.fetched,
      jobs_created:   stats.created,
      jobs_updated:   stats.updated,
      jobs_unchanged: stats.unchanged,
      changes_logged: stats.changes_logged,
      errors:         stats.errors.length,
      status:         stats.errors.length > 0 ? 'partial' : 'success',
    })

    return res.status(200).json({
      success: true,
      stats,
      summary: {
        total_from_crms:  stats.fetched,
        skipped_quotes:   stats.skipped_quotes,
        imported:         opportunities.length,
        with_delivery:    opportunities.filter(o => o.deliver_starts_at).length,
        with_collection:  opportunities.filter(o => o.collect_starts_at).length,
        items_synced:     stats.items_synced,
        item_errors:      stats.item_errors,
      },
    })

  } catch (err) {
    await supabase.from('sync_runs').insert({
      started_at:    startedAt,
      completed_at:  new Date().toISOString(),
      status:        'failed',
      error_message: err.message,
    }).catch(() => {})

    return res.status(500).json({ error: err.message, stats })
  }
}

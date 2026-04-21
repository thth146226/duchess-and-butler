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
    const data = await crmsGet(path, { ...params, page, per_page: 25 })
    const items = data[key] || []
    const meta = data.meta || {}
    const totalCount = meta.total_row_count || 0
    console.log(`Page ${page}: ${items.length} items, total so far: ${all.length + items.length} of ${totalCount}`)
    all = all.concat(items)
    if (all.length >= totalCount || items.length === 0) break
    page++
  }
  return all
}

function toDate(iso) { return iso ? iso.slice(0, 10) : null }
function toTime(iso) {
  if (!iso) return null
  const date = new Date(iso)
  // Convert UTC to UK local time (handles both GMT and BST automatically)
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  })
}

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
  // state_name is the ONLY reliable field to distinguish Orders from Quotations
  // state=3 / state_name="Order" = confirmed (red in Current RMS UI)
  // state=2 / state_name="Quotation" = not confirmed (orange in Current RMS UI)
  // state=1 / state_name="Draft" = draft
  
  const stateName = (o.state_name || '').toLowerCase()
  const state = o.state == null ? null : Number(o.state)

  // Must be a confirmed Order
  if (stateName === 'order') return true
  if (state === 3) return true

  // Exclude everything else — Quotations, Drafts, Cancelled, Lost
  return false
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
  // All opportunities fetched already have state=3 (confirmed Order)
  // This function is now a safety net only
  const state = o.state
  if (state === 1 || state === 2) return false
  return true
}


//
// Current RMS nests venue/destination as an object on the opportunity.
// Fields available: name, address1, address2, town_city, county, postcode, country_name

function extractVenueName(o) {
  return (
    o.destination?.address?.name ||
    o.destination?.name ||
    o.venue_name ||
    o.location ||
    ''
  )
}

function extractVenueAddress(o) {
  const addr = o.destination?.address
  if (!addr) return null
  const parts = [
    addr.street?.replace(/\r\n/g, ', ').replace(/,\s*,/g, ',').trim(),
    addr.city,
    addr.county,
    addr.postcode,
  ].filter(v => v && v.trim())
  if (parts.length === 0) return null
  return parts.join(', ')
}

// ── field mapper ──────────────────────────────────────────────────────────────

function mapOpportunity(o) {
  console.log(`[MAP] ${o.number} id=${o.id} state=${o.state} state_name=${o.state_name} is_order=${isConfirmedOrder(o)}`)
  // Delivery dates — read directly from scheduling fields
  const deliveryISO    = o.deliver_starts_at || o.load_starts_at    || null
  const collectionISO  = o.collect_starts_at || o.unload_starts_at  || null
  const eventDateISO   = o.starts_at         || o.deliver_starts_at || null
  const deliverySourceField = o.deliver_starts_at ? 'deliver_starts_at' : (o.load_starts_at ? 'load_starts_at' : null)
  const collectionSourceField = o.collect_starts_at ? 'collect_starts_at' : (o.unload_starts_at ? 'unload_starts_at' : null)

  const mapped = {
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
    delivery_time:     toTime(o.deliver_starts_at),
    delivery_end_time: toTime(o.deliver_ends_at),
    delivery_instructions: o.delivery_instructions || null,

    // Collection
    collection_date:  toDate(collectionISO),
    collection_time:   toTime(o.collect_starts_at),
    collection_end_time: toTime(o.collect_ends_at),
    collection_instructions: o.collection_instructions || null,

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
    crms_description: o.description || null,
    special_instructions: o.special_instructions || '',
    total_value:          parseFloat(o.grand_total || o.total || 0),

    // Audit
    crms_raw:         o,
    last_synced_at:   new Date().toISOString(),
    crms_updated_at:  o.updated_at || null,
  }

  console.log('[sync-diag] field mapping', {
    crms_ref: mapped.crms_ref,
    chosen_delivery_source_field: deliverySourceField,
    chosen_delivery_value: mapped.delivery_date,
    chosen_collection_source_field: collectionSourceField,
    chosen_collection_value: mapped.collection_date,
  })

  return mapped
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
    'crms_state', 'crms_state_name',
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
  const forceHeader = req.headers['x-force-sync']
  const isManual = typeof forceHeader === 'string' && forceHeader.toLowerCase() === 'manual'
  const userAgent = req.headers['user-agent'] || ''
  const cronHeader = req.headers['x-vercel-cron-signature'] || req.headers['x-vercel-cron']
  const authHeader = req.headers.authorization || ''
  const cronSecret = process.env.CRON_SECRET
  const hasValidCronSecret = !!(cronSecret && authHeader === `Bearer ${cronSecret}`)
  const isCron = !!cronHeader || userAgent.includes('vercel-cron') || hasValidCronSecret

  if (!isManual && !isCron) {
    return res.status(401).json({ error: 'Unauthorized sync trigger' })
  }

  const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY)
  const startedAt = new Date().toISOString()
  const stats     = {
    fetched: 0, skipped_quotes: 0,
    created: 0, updated: 0, unchanged: 0,
    changes_logged: 0, items_synced: 0,
    item_errors: [],
    errors: [],
  }
  const changedJobIds = []
  const changedJobsToSync = []

  try {
    // ── 1. Fetch ALL opportunities from Current RMS ──────────────────────────
    // Fetch by starts_at window; confirm Orders client-side via shouldImport()
    // Use starts_at filter — deliver_starts_at is not supported as query param
    const until = new Date()
    until.setFullYear(until.getFullYear() + 2)

    const allOpportunities = await fetchAllPages('/opportunities', 'opportunities', {
      'q[starts_at_gteq]': '2026-01-01',
      'q[starts_at_lteq]': until.toISOString().split('T')[0],
      'q[s]': 'starts_at asc',
    })

    // Remove any existing Supabase records that are NOT in the current API results
    const validCrmsIds = allOpportunities.map(o => String(o.id))
    if (validCrmsIds.length > 0) {
      await supabase
        .from('crms_jobs')
        .delete()
        .not('crms_id', 'in', `(${validCrmsIds.join(',')})`)
    }

    const opportunities = allOpportunities.filter(o => shouldImport(o))
    stats.fetched = allOpportunities.length
    stats.skipped_quotes = allOpportunities.length - opportunities.length

    // Run once per sync process to inspect exact CRMS date/time keys and values.
    if (!global.__syncFieldsDumped) {
      const sample = opportunities?.[0] || {}
      console.log('[sync-diag] CRMS raw opportunity field map', {
        keys: Object.keys(sample).filter(k =>
          k.includes('date') || k.includes('time') ||
          k.includes('start') || k.includes('end') ||
          k.includes('deliver') || k.includes('collect')
        ),
        sample_values: Object.fromEntries(
          Object.entries(sample).filter(([k]) =>
            k.includes('date') || k.includes('time') ||
            k.includes('start') || k.includes('end')
          )
        ),
      })
      global.__syncFieldsDumped = true
    }

    // ── 2. Load existing Supabase records ────────────────────────────────────
    const { data: existingRecords } = await supabase
      .from('crms_jobs')
      .select('id, crms_id, delivery_date, delivery_time, delivery_end_time, collection_date, collection_time, collection_end_time, status, event_name, client_name, venue, venue_address, notes, special_instructions, total_value, event_date, sync_change_count')

    const existingMap = {}
    for (const r of (existingRecords || [])) existingMap[r.crms_id] = r

    console.log('Sample opportunity states:', 
      allOpportunities.slice(0, 5).map(o => ({
        number: o.number,
        state: o.state,
        state_name: o.state_name,
        shouldImport: shouldImport(o)
      }))
    )

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

          if (inserted?.id) {
            changedJobIds.push(inserted.id)
            changedJobsToSync.push({ oppId: opp.id, jobId: inserted.id })
          }

          stats.created++

        } else {
          // ── EXISTING job ───────────────────────────────────────────────────
          // Log date comparison outcome to diagnose detection vs update path.
          const dateChanged =
            existing.delivery_date !== mapped.delivery_date ||
            existing.collection_date !== mapped.collection_date

          if (dateChanged) {
            console.log('[sync-diag] DATE CHANGE DETECTED', {
              crms_ref: mapped.crms_ref,
              existing_delivery: existing.delivery_date,
              new_delivery: mapped.delivery_date,
              existing_collection: existing.collection_date,
              new_collection: mapped.collection_date,
              existingRaw: typeof existing.delivery_date,
              newRaw: typeof mapped.delivery_date,
            })
          }

          // Only update if data actually changed
          const hasChanged = !existing ||
            existing.status !== mapped.status ||
            existing.delivery_date !== mapped.delivery_date ||
            existing.collection_date !== mapped.collection_date ||
            existing.delivery_time !== mapped.delivery_time ||
            existing.collection_time !== mapped.collection_time ||
            existing.delivery_end_time !== mapped.delivery_end_time ||
            existing.collection_end_time !== mapped.collection_end_time ||
            existing.event_name !== mapped.event_name ||
            existing.client_name !== mapped.client_name ||
            existing.venue !== mapped.venue ||
            existing.venue_address !== mapped.venue_address ||
            existing.notes !== mapped.notes ||
            existing.special_instructions !== mapped.special_instructions

          if (hasChanged) {
          const changes = detectChanges(existing, mapped)

          if (changes.length > 0) {
            // Preserve manual overrides — never overwrite them with RMS data
            const overrideFields = {}
            if (existing.has_manual_override) {
              if (existing.manual_delivery_date) overrideFields.delivery_date = existing.manual_delivery_date
              if (existing.manual_delivery_time) overrideFields.delivery_time = existing.manual_delivery_time
              if (existing.manual_collection_date) overrideFields.collection_date = existing.manual_collection_date
              if (existing.manual_collection_time) overrideFields.collection_time = existing.manual_collection_time
              if (existing.manual_venue) overrideFields.venue = existing.manual_venue
            }
            const updatePayload = {
              ...mapped,
              ...overrideFields,
              // Explicitly pin classification fields to avoid accidental omissions
              crms_state: mapped.crms_state,
              crms_state_name: mapped.crms_state_name,
              is_order: mapped.is_order,
              ordered_at: mapped.ordered_at,
              sync_change_count: (existing.sync_change_count || 0) + 1,
            }
            await supabase
              .from('crms_jobs')
              .update(updatePayload)
              .eq('crms_id', mapped.crms_id)

            changedJobIds.push(existing.id)
            changedJobsToSync.push({ oppId: opp.id, jobId: existing.id })
            stats.updated++
          } else {
            stats.unchanged++
          }
          } else {
            stats.unchanged++
          }

        }

      } catch (jobErr) {
        stats.errors.push({ crms_id: opp.id, error: jobErr.message })
      }
    }

    // Only re-sync items for jobs that actually changed
    if (changedJobIds.length > 0) {
      for (const changed of changedJobsToSync) {
        const itemResult = await syncItems(supabase, changed.oppId, changed.jobId)
        stats.items_synced += itemResult.count
        if (itemResult.error) stats.item_errors.push({ crms_id: changed.oppId, error: itemResult.error })
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
    try {
      await supabase.from('sync_runs').insert({
        started_at:    startedAt,
        completed_at:  new Date().toISOString(),
        status:        'failed',
        error_message: err.message,
      })
    } catch (e) {}

    return res.status(500).json({ error: err.message, stats })
  }
}

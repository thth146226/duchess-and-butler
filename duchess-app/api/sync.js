// Duchess & Butler — Current RMS Sync Engine v7
// ONE-WAY ONLY: Current RMS → Supabase (never the reverse)
// FIX: reads deliver_starts_at / collect_starts_at directly from opportunity object

import { createClient } from '@supabase/supabase-js'

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY   = process.env.CRMS_API_KEY
const SUPABASE_URL   = process.env.SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY

const CRMS_BASE = `https://api.current-rms.com/api/v1`

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
    const data = await crmsGet(path, { ...params, page, per_page: 100 })
    const items = data[key] || []
    all = all.concat(items)
    if (items.length < 100) break
    page++
  }
  return all
}

// Extrai YYYY-MM-DD de um ISO timestamp do Current RMS
// ex: "2026-03-20T09:00:00.000+00:00" → "2026-03-20"
function toDate(iso) {
  if (!iso) return null
  try { return iso.slice(0, 10) } catch { return null }
}

// Extrai HH:MM de um ISO timestamp do Current RMS
// ex: "2026-03-20T09:00:00.000+00:00" → "09:00"
function toTime(iso) {
  if (!iso) return null
  try { return iso.slice(11, 16) } catch { return null }
}

// ── field mapper ──────────────────────────────────────────────────────────────
//
// Current RMS opportunity fields confirmed from scheduling form (photos):
//   deliver_starts_at  → Delivery start  (e.g. "2026-03-20T09:00:00.000+00:00")
//   deliver_ends_at    → Delivery end    (e.g. "2026-03-20T18:00:00.000+00:00")
//   collect_starts_at  → Collection start (e.g. "2026-03-23T09:00:00.000+00:00")
//   collect_ends_at    → Collection end   (e.g. "2026-03-23T18:00:00.000+00:00")
//   starts_at          → Event start date (always present)
//   ends_at            → Event end date   (always present)
//   prep_starts_at / load_starts_at / setup_starts_at / takedown_starts_at / unload_starts_at
//   opportunity_status_name → "Prepared", "Confirmed", "Cancelled", etc.

function mapOpportunity(o) {
  // ── Delivery ──────────────────────────────────────────────────────────────
  // Primary:  deliver_starts_at (filled when scheduling is done in CRMS)
  // Fallback: load_starts_at   (sometimes used as proxy)
  // Fallback: null             (order not yet scheduled — normal for Prepared/Open)
  const deliveryISO   = o.deliver_starts_at || o.load_starts_at || null
  const deliveryEndISO = o.deliver_ends_at  || null

  // ── Collection ────────────────────────────────────────────────────────────
  const collectionISO    = o.collect_starts_at || o.unload_starts_at || null
  const collectionEndISO = o.collect_ends_at   || null

  // ── Event date ────────────────────────────────────────────────────────────
  // starts_at is always present; use as the canonical event date
  const eventDateISO = o.starts_at || null

  // ── Venue / address ───────────────────────────────────────────────────────
  // Current RMS nests venue in opportunity.venue or opportunity.destination
  const venue = o.venue_name
    || o.destination?.name
    || o.venue?.name
    || o.location
    || ''

  // ── Client ────────────────────────────────────────────────────────────────
  const clientName = o.member?.name
    || o.member?.full_name
    || o.company_name
    || o.member_name
    || ''

  return {
    crms_id:          String(o.id),
    crms_ref:         o.number || o.reference || String(o.id),
    event_name:       o.name   || o.subject   || '',
    client_name:      clientName,
    client_id:        o.member_id ? String(o.member_id) : null,
    venue:            venue,

    // Event dates
    event_date:       toDate(eventDateISO),
    event_ends_at:    toDate(o.ends_at),

    // Delivery — populated only after scheduling in Current RMS
    delivery_date:    toDate(deliveryISO),
    delivery_time:    toTime(deliveryISO),
    delivery_end_time: toTime(deliveryEndISO),

    // Collection — populated only after scheduling in Current RMS
    collection_date:  toDate(collectionISO),
    collection_time:  toTime(collectionISO),
    collection_end_time: toTime(collectionEndISO),

    // Status
    status:           mapStatus(o.opportunity_status_name || o.status_name || ''),
    crms_status:      o.opportunity_status_name || o.status_name || '',

    // Other fields
    notes:                o.description        || o.notes || '',
    special_instructions: o.special_instructions || '',
    total_value:          parseFloat(o.grand_total || o.total || 0),

    // Raw data for debug (full object stored in jsonb)
    crms_raw:         o,
    last_synced_at:   new Date().toISOString(),
    crms_updated_at:  o.updated_at || null,
  }
}

function mapStatus(crmsStatus) {
  const s = (crmsStatus || '').toLowerCase()
  if (s.includes('cancel'))                                    return 'cancelled'
  if (s.includes('confirm'))                                   return 'confirmed'
  if (s.includes('dispatch'))                                  return 'dispatched'
  if (s.includes('complet'))                                   return 'completed'
  if (s.includes('draft') || s.includes('quote')
    || s.includes('prospect') || s.includes('prepared')
    || s.includes('open'))                                     return 'pending'
  return 'pending'
}

function mapItem(item, crmsOpportunityId) {
  return {
    crms_opportunity_id: String(crmsOpportunityId),
    crms_item_id:        String(item.id),
    item_name:           item.product_name || item.name || '',
    category:            item.product_group_name || item.category || 'other',
    quantity:            parseInt(item.quantity || 0),
    unit:                item.rental_price_name || 'unit',
    item_type:           item.type_name || 'rental',
    crms_raw:            item,
  }
}

// ── change detection ──────────────────────────────────────────────────────────

function detectChanges(existing, incoming) {
  const changes = []
  const fields = [
    'event_name', 'client_name', 'venue', 'event_date',
    'delivery_date', 'delivery_time', 'delivery_end_time',
    'collection_date', 'collection_time', 'collection_end_time',
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

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY)
  const startedAt = new Date().toISOString()
  const stats     = { fetched: 0, created: 0, updated: 0, unchanged: 0, changes_logged: 0, errors: [] }

  try {
    // 1. Fetch opportunities from Current RMS
    // Window: 30 days back → 365 days forward (catches all upcoming jobs)
    const since = new Date(); since.setDate(since.getDate() - 30)
    const until = new Date(); until.setDate(until.getDate() + 365)

    const opportunities = await fetchAllPages('/opportunities', 'opportunities', {
      'q[starts_at_gteq]': since.toISOString().split('T')[0],
      'q[starts_at_lteq]': until.toISOString().split('T')[0],
    })

    stats.fetched = opportunities.length

    // 2. Load existing records from Supabase (for change detection)
    const { data: existingRecords } = await supabase
      .from('crms_jobs')
      .select('id, crms_id, delivery_date, delivery_time, delivery_end_time, collection_date, collection_time, collection_end_time, status, event_name, client_name, venue, notes, special_instructions, total_value, event_date, sync_change_count')

    const existingMap = {}
    for (const r of (existingRecords || [])) existingMap[r.crms_id] = r

    // 3. Process each opportunity
    for (const opp of opportunities) {
      try {
        const mapped   = mapOpportunity(opp)
        const existing = existingMap[mapped.crms_id]

        if (!existing) {
          // ── NEW job ───────────────────────────────────────────────────────
          const { data: inserted } = await supabase
            .from('crms_jobs')
            .insert(mapped)
            .select('id')
            .single()

          // Fetch & insert items (best-effort)
          try {
            const itemsData = await crmsGet(`/opportunities/${opp.id}/opportunity_items`)
            const items = (itemsData.opportunity_items || []).map(i => mapItem(i, opp.id))
            if (items.length > 0 && inserted?.id) {
              await supabase.from('crms_job_items').insert(
                items.map(i => ({ ...i, job_id: inserted.id }))
              )
            }
          } catch { /* items optional */ }

          await supabase.from('sync_log').insert({
            crms_id:    mapped.crms_id,
            event_type: 'job_created',
            description: `New: ${mapped.event_name} (${mapped.crms_ref}) · delivery ${mapped.delivery_date || 'TBC'} · collection ${mapped.collection_date || 'TBC'}`,
            synced_at:  new Date().toISOString(),
          })

          stats.created++

        } else {
          // ── EXISTING job — check for changes ──────────────────────────────
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
            // No changes — just touch last_synced_at
            await supabase
              .from('crms_jobs')
              .update({ last_synced_at: new Date().toISOString() })
              .eq('crms_id', mapped.crms_id)
            stats.unchanged++
          }
        }
      } catch (jobErr) {
        stats.errors.push({ crms_id: opp.id, error: jobErr.message })
      }
    }

    // 4. Record sync run
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

    // 5. Summary for manual trigger response
    const withDelivery   = opportunities.filter(o => o.deliver_starts_at).length
    const withCollection = opportunities.filter(o => o.collect_starts_at).length

    return res.status(200).json({
      success: true,
      stats,
      summary: {
        total:          stats.fetched,
        with_delivery:  withDelivery,
        with_collection: withCollection,
        without_dates:  stats.fetched - withDelivery,
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

// Duchess & Butler — Current RMS Sync Engine
// ONE-WAY ONLY: Current RMS → Supabase (never the reverse)

const { createClient } = require('@supabase/supabase-js')

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY   = process.env.CRMS_API_KEY
const SUPABASE_URL   = process.env.SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY

const CRMS_BASE = `https://api.current-rms.com/api/v1`

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

function mapOpportunity(o) {
  const dates = o.opportunity_dates || []
  const delivery   = dates.find(d => d.date_type_name?.toLowerCase().includes('delivery'))
  const collection = dates.find(d => 
    d.date_type_name?.toLowerCase().includes('collection') || 
    d.date_type_name?.toLowerCase().includes('collect')
  )

  // Also check starts_at/ends_at as fallback for delivery/collection
  const deliveryDate = delivery?.starts_at 
    ? delivery.starts_at.split('T')[0] 
    : (o.delivery_date || null)
  const collectionDate = collection?.starts_at 
    ? collection.starts_at.split('T')[0] 
    : (o.collection_date || null)

  return {
    crms_id:          String(o.id),
    crms_ref:         o.number || o.reference || String(o.id),
    event_name:       o.name || o.subject || '',
    client_name:      o.member?.name || o.company_name || '',
    client_id:        o.member_id ? String(o.member_id) : null,
    venue:            o.venue_name || o.location || '',
    event_date:       o.starts_at ? o.starts_at.split('T')[0] : null,
    event_ends_at:    o.ends_at   ? o.ends_at.split('T')[0]   : null,
    delivery_date:    deliveryDate,
    delivery_time:    delivery?.starts_at ? delivery.starts_at.split('T')[1]?.slice(0,5) : null,
    collection_date:  collectionDate,
    collection_time:  collection?.starts_at ? collection.starts_at.split('T')[1]?.slice(0,5) : null,
    status:           mapStatus(o.opportunity_status_name || o.status_name || ''),
    crms_status:      o.opportunity_status_name || o.status_name || '',
    notes:            o.description || o.notes || '',
    special_instructions: o.special_instructions || '',
    total_value:      parseFloat(o.grand_total || o.total || 0),
    crms_raw:         o,
    last_synced_at:   new Date().toISOString(),
    crms_updated_at:  o.updated_at || null,
  }
}

function mapStatus(crmsStatus) {
  const s = crmsStatus.toLowerCase()
  if (s.includes('cancel'))   return 'cancelled'
  if (s.includes('confirm'))  return 'confirmed'
  if (s.includes('draft') || s.includes('quote') || s.includes('prospect')) return 'pending'
  if (s.includes('dispatch')) return 'dispatched'
  if (s.includes('complete')) return 'completed'
  return 'pending'
}

function detectChanges(existing, incoming) {
  const changes = []
  const fields = [
    'event_name','client_name','venue','event_date',
    'delivery_date','delivery_time','collection_date','collection_time',
    'status','notes','special_instructions'
  ]
  for (const f of fields) {
    const oldVal = existing[f]
    const newVal = incoming[f]
    if (String(oldVal ?? '') !== String(newVal ?? '')) {
      changes.push({
        field: f,
        old_value: String(oldVal ?? ''),
        new_value: String(newVal ?? ''),
        affects_schedule: ['delivery_date','delivery_time','collection_date','collection_time'].includes(f),
        is_urgent: f === 'delivery_date' || f === 'delivery_time',
      })
    }
  }
  return changes
}

module.exports = async function handler(req, res) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const startedAt = new Date().toISOString()
  const stats = { fetched: 0, created: 0, updated: 0, unchanged: 0, changes_logged: 0, errors: [] }

  try {
    // Fetch opportunities from Current RMS — last 30 days to next 180 days
    const since = new Date()
    since.setDate(since.getDate() - 30)
    const until = new Date()
    until.setDate(until.getDate() + 180)

    const opportunities = await fetchAllPages('/opportunities', 'opportunities', {
      'q[starts_at_gteq]': since.toISOString().split('T')[0],
      'q[starts_at_lteq]': until.toISOString().split('T')[0],
    })

    stats.fetched = opportunities.length

    // Load existing records
    const { data: existingRecords } = await supabase
      .from('crms_jobs')
      .select('id, crms_id, delivery_date, delivery_time, collection_date, collection_time, status, event_name, client_name, venue, notes, special_instructions, total_value, event_date, sync_change_count')

    const existingMap = {}
    for (const r of (existingRecords || [])) existingMap[r.crms_id] = r

    // Process each opportunity
    for (const opp of opportunities) {
      try {
        const mapped = mapOpportunity(opp)
        const existing = existingMap[mapped.crms_id]

        if (!existing) {
          // NEW — insert
          await supabase.from('crms_jobs').insert(mapped)
          await supabase.from('sync_log').insert({
            crms_id: mapped.crms_id,
            event_type: 'job_created',
            description: `New job: ${mapped.event_name} (${mapped.crms_ref})`,
            synced_at: new Date().toISOString(),
          })
          stats.created++
        } else {
          const changes = detectChanges(existing, mapped)
          if (changes.length > 0) {
            await supabase.from('crms_jobs')
              .update({ ...mapped, sync_change_count: (existing.sync_change_count || 0) + 1, is_amended: true })
              .eq('crms_id', mapped.crms_id)

            for (const change of changes) {
              await supabase.from('change_log').insert({
                crms_id: mapped.crms_id,
                job_ref: mapped.crms_ref,
                event_name: mapped.event_name,
                field_changed: change.field,
                old_value: change.old_value,
                new_value: change.new_value,
                affects_schedule: change.affects_schedule,
                is_urgent: change.is_urgent,
                detected_at: new Date().toISOString(),
                source: 'current_rms_sync',
              })
              stats.changes_logged++
            }
            stats.updated++
          } else {
            await supabase.from('crms_jobs')
              .update({ last_synced_at: new Date().toISOString() })
              .eq('crms_id', mapped.crms_id)
            stats.unchanged++
          }
        }
      } catch (jobErr) {
        stats.errors.push({ crms_id: opp.id, error: jobErr.message })
      }
    }

    // Record sync run
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

    return res.status(200).json({ success: true, stats })

  } catch (err) {
    console.error('Sync error:', err.message)
    await supabase.from('sync_runs').insert({
      started_at:    startedAt,
      completed_at:  new Date().toISOString(),
      status:        'failed',
      error_message: err.message,
    }).catch(() => {})
    return res.status(500).json({ error: err.message })
  }
}

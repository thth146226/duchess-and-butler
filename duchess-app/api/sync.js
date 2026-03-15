// Duchess & Butler — Current RMS Sync Engine v5
// Uses correct field names: deliver_starts_at, collect_starts_at

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

function crmsHeaders() {
  return {
    'X-AUTH-TOKEN': CRMS_API_KEY,
    'X-SUBDOMAIN': CRMS_SUBDOMAIN,
    'Content-Type': 'application/json',
  }
}

async function supabaseUpsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(data)
  })
  return res.ok
}

function extractDate(dateStr) {
  if (!dateStr) return null
  return dateStr.split('T')[0]
}

function extractTime(dateStr) {
  if (!dateStr) return null
  const t = dateStr.split('T')[1]
  if (!t) return null
  return t.slice(0, 5)
}

function mapStatus(s = '') {
  s = s.toLowerCase()
  if (s.includes('cancel')) return 'cancelled'
  if (s.includes('confirm')) return 'confirmed'
  if (s.includes('dispatch')) return 'dispatched'
  if (s.includes('complete')) return 'completed'
  return 'pending'
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing env vars' })
  }

  const startedAt = new Date().toISOString()
  const stats = { fetched: 0, processed: 0, errors: [] }

  try {
    const since = new Date(); since.setDate(since.getDate() - 30)
    const until = new Date(); until.setDate(until.getDate() + 365)

    const listRes = await fetch(
      `https://api.current-rms.com/api/v1/opportunities?per_page=100&q[starts_at_gteq]=${since.toISOString().split('T')[0]}&q[starts_at_lteq]=${until.toISOString().split('T')[0]}`,
      { headers: crmsHeaders() }
    )
    const listData = await listRes.json()
    const opportunities = listData.opportunities || []
    stats.fetched = opportunities.length

    for (const opp of opportunities) {
      try {
        // Fetch full opportunity to get deliver_starts_at and collect_starts_at
        const detailRes = await fetch(
          `https://api.current-rms.com/api/v1/opportunities/${opp.id}`,
          { headers: crmsHeaders() }
        )
        const detailData = await detailRes.json()
        const o = detailData.opportunity || opp

        const job = {
          crms_id:          String(o.id),
          crms_ref:         o.number || String(o.id),
          event_name:       o.name || o.subject || '',
          client_name:      o.member?.name || '',
          venue:            o.venue?.name || o.venue_name || '',
          event_date:       extractDate(o.starts_at),
          // ✅ Correct field names from Current RMS API
          delivery_date:    extractDate(o.deliver_starts_at),
          delivery_time:    extractTime(o.deliver_starts_at),
          collection_date:  extractDate(o.collect_starts_at),
          collection_time:  extractTime(o.collect_starts_at),
          status:           mapStatus(o.status_name || o.state_name || ''),
          crms_status:      o.status_name || o.state_name || '',
          notes:            o.description || '',
          special_instructions: o.delivery_instructions || o.collection_instructions || '',
          last_synced_at:   new Date().toISOString(),
        }

        await supabaseUpsert('crms_jobs', job)
        stats.processed++

      } catch (e) {
        stats.errors.push({ id: opp.id, error: e.message })
      }
    }

    // Log sync run
    await supabaseUpsert('sync_runs', {
      started_at:    startedAt,
      completed_at:  new Date().toISOString(),
      jobs_fetched:  stats.fetched,
      jobs_created:  stats.processed,
      status:        stats.errors.length > 0 ? 'partial' : 'success',
    })

    return res.status(200).json({ success: true, stats })

  } catch (err) {
    console.error('Sync error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

// Duchess & Butler — Current RMS Sync Engine v6
// Uses deliver_starts_at/collect_starts_at with fallback to starts_at/ends_at

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

function crmsHeaders() {
  return { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }
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

function d(str) { return str ? str.split('T')[0] : null }
function t(str) { return str ? str.split('T')[1]?.slice(0,5) || null : null }
function mapStatus(s = '') {
  s = s.toLowerCase()
  if (s.includes('cancel')) return 'cancelled'
  if (s.includes('confirm')) return 'confirmed'
  if (s.includes('dispatch')) return 'dispatched'
  if (s.includes('complete')) return 'completed'
  return 'pending'
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Missing env vars' })

  const startedAt = new Date().toISOString()
  const stats = { fetched: 0, processed: 0, withDates: 0, errors: [] }

  try {
    const since = new Date(); since.setDate(since.getDate() - 30)
    const until = new Date(); until.setDate(until.getDate() + 365)

    const listRes = await fetch(
      `https://api.current-rms.com/api/v1/opportunities?per_page=100&q[starts_at_gteq]=${since.toISOString().split('T')[0]}&q[starts_at_lteq]=${until.toISOString().split('T')[0]}`,
      { headers: crmsHeaders() }
    )
    const listData = await listRes.json()
    const opps = listData.opportunities || []
    stats.fetched = opps.length

    for (const opp of opps) {
      try {
        const detailRes = await fetch(
          `https://api.current-rms.com/api/v1/opportunities/${opp.id}`,
          { headers: crmsHeaders() }
        )
        const detailData = await detailRes.json()
        const o = detailData.opportunity || opp

        // Delivery: prefer deliver_starts_at, fallback to starts_at
        const deliveryRaw = o.deliver_starts_at || o.starts_at
        // Collection: prefer collect_starts_at, fallback to ends_at  
        const collectionRaw = o.collect_starts_at || o.ends_at

        const deliveryDate = d(deliveryRaw)
        const collectionDate = d(collectionRaw)

        if (deliveryDate || collectionDate) stats.withDates++

        const job = {
          crms_id:         String(o.id),
          crms_ref:        o.number || String(o.id),
          event_name:      o.name || o.subject || '',
          client_name:     o.member?.name || '',
          venue:           o.venue?.name || o.venue_name || '',
          event_date:      d(o.starts_at),
          delivery_date:   deliveryDate,
          delivery_time:   t(o.deliver_starts_at), // only set time if explicit
          collection_date: collectionDate,
          collection_time: t(o.collect_starts_at), // only set time if explicit
          status:          mapStatus(o.status_name || o.state_name || ''),
          crms_status:     o.status_name || o.state_name || '',
          notes:           o.description || '',
          special_instructions: o.delivery_instructions || o.collection_instructions || '',
          last_synced_at:  new Date().toISOString(),
        }

        await supabaseUpsert('crms_jobs', job)
        stats.processed++

      } catch (e) {
        stats.errors.push({ id: opp.id, error: e.message })
      }
    }

    await supabaseUpsert('sync_runs', {
      started_at: startedAt, completed_at: new Date().toISOString(),
      jobs_fetched: stats.fetched, jobs_created: stats.processed,
      status: stats.errors.length > 0 ? 'partial' : 'success',
    })

    return res.status(200).json({ success: true, stats })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

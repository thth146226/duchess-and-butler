// Duchess & Butler — Current RMS Sync Engine v4
// Fetches full opportunity details including dates

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

async function crmsGet(path) {
  const res = await fetch(`https://api.current-rms.com/api/v1${path}`, {
    headers: crmsHeaders()
  })
  if (!res.ok) throw new Error(`CRMS ${path} → ${res.status}`)
  return res.json()
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

function mapStatus(s = '') {
  s = s.toLowerCase()
  if (s.includes('cancel')) return 'cancelled'
  if (s.includes('confirm')) return 'confirmed'
  if (s.includes('dispatch')) return 'dispatched'
  if (s.includes('complete')) return 'completed'
  return 'pending'
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

function findDeliveryCollection(opp) {
  // Method 1: opportunity_dates array
  const dates = opp.opportunity_dates || opp.dates || []
  
  let delivery = null
  let collection = null

  for (const d of dates) {
    const name = (d.date_type_name || d.name || '').toLowerCase()
    if (name.includes('deliver') || name.includes('drop')) {
      delivery = d
    } else if (name.includes('collect') || name.includes('pick') || name.includes('return')) {
      collection = d
    }
  }

  // Method 2: use starts_at as delivery, ends_at as collection
  const deliveryDate = delivery?.starts_at 
    ? extractDate(delivery.starts_at)
    : extractDate(opp.delivery_date || opp.starts_at)
    
  const deliveryTime = delivery?.starts_at
    ? extractTime(delivery.starts_at)
    : extractTime(opp.delivery_time || opp.starts_at)

  const collectionDate = collection?.starts_at
    ? extractDate(collection.starts_at)
    : extractDate(opp.collection_date || opp.ends_at)
    
  const collectionTime = collection?.starts_at
    ? extractTime(collection.starts_at)
    : extractTime(opp.collection_time || opp.ends_at)

  return { deliveryDate, deliveryTime, collectionDate, collectionTime }
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing env vars' })
  }

  const startedAt = new Date().toISOString()
  const stats = { fetched: 0, processed: 0, errors: [] }

  try {
    // Fetch list of opportunities
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
        // Fetch full opportunity details to get dates
        let fullOpp = opp
        try {
          const detail = await crmsGet(`/opportunities/${opp.id}`)
          fullOpp = detail.opportunity || opp
        } catch (e) {
          // Use basic opp if detail fails
        }

        const { deliveryDate, deliveryTime, collectionDate, collectionTime } = findDeliveryCollection(fullOpp)

        // Log what we found for debugging
        console.log(`Opp ${opp.id} (${opp.number}): DEL=${deliveryDate} ${deliveryTime}, COL=${collectionDate} ${collectionTime}`)

        const job = {
          crms_id: String(fullOpp.id),
          crms_ref: fullOpp.number || String(fullOpp.id),
          event_name: fullOpp.name || '',
          client_name: fullOpp.member?.name || fullOpp.company_name || '',
          venue: fullOpp.venue_name || fullOpp.location || '',
          event_date: extractDate(fullOpp.starts_at),
          delivery_date: deliveryDate,
          delivery_time: deliveryTime,
          collection_date: collectionDate,
          collection_time: collectionTime,
          status: mapStatus(fullOpp.opportunity_status_name || ''),
          crms_status: fullOpp.opportunity_status_name || '',
          notes: fullOpp.description || fullOpp.notes || '',
          special_instructions: fullOpp.special_instructions || '',
          crms_raw: fullOpp,
          last_synced_at: new Date().toISOString(),
        }

        await supabaseUpsert('crms_jobs', job)
        stats.processed++

      } catch (e) {
        stats.errors.push({ id: opp.id, error: e.message })
      }
    }

    // Log sync run
    await supabaseUpsert('sync_runs', {
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      jobs_fetched: stats.fetched,
      jobs_created: stats.processed,
      status: stats.errors.length > 0 ? 'partial' : 'success',
    })

    return res.status(200).json({ success: true, stats })

  } catch (err) {
    console.error('Sync error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?per_page=5&q[s]=starts_at+asc',
      { headers: HEADERS }
    )
    const d = await r.json()
    const sample = (d.opportunities || []).map(o => ({
      id: o.id,
      number: o.number,
      name: o.name,
      state: o.state,
      state_name: o.state_name,
      opportunity_status_name: o.opportunity_status_name,
      ordered_at: o.ordered_at,
      starts_at: o.starts_at,
      deliver_starts_at: o.deliver_starts_at,
    }))
    return res.status(200).json({ 
      total: d.meta?.total_row_count,
      sample 
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

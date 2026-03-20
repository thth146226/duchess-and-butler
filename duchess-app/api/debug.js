const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?per_page=3&q[starts_at_gteq]=2026-01-01&q[state_eq]=3',
      { headers: HEADERS }
    )
    const d = await r.json()
    const sample = (d.opportunities || []).map(o => ({
      number: o.number,
      state: o.state,
      state_name: o.state_name,
      opportunity_status_name: o.opportunity_status_name,
      status: o.status,
      status_name: o.status_name,
    }))
    return res.status(200).json({ sample })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

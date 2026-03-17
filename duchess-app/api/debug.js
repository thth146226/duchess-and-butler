// Debug v5 - show state field values for all opportunities
const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY   = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(
      `https://api.current-rms.com/api/v1/opportunities?per_page=10`,
      { headers: HEADERS }
    )
    const d = await r.json()
    const opps = (d.opportunities || []).map(o => ({
      number:     o.number,
      name:       (o.name || '').slice(0, 30),
      state:      o.state,
      state_name: o.state_name,
      opp_status: o.opportunity_status_name,
    }))
    return res.status(200).json({ total: opps.length, opportunities: opps })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

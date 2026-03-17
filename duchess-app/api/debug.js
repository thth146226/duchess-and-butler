// Debug v4 - expose state/state_name to identify ORDER vs QUOTATION
const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY   = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    // Fetch first 5 opportunities to see variety of states
    const r = await fetch(
      `https://api.current-rms.com/api/v1/opportunities?per_page=5`,
      { headers: HEADERS }
    )
    const d = await r.json()
    const opps = (d.opportunities || []).map(o => ({
      id:                      o.id,
      number:                  o.number,
      name:                    o.name?.slice(0, 40),
      // The key fields for ORDER vs QUOTATION
      state:                   o.state,
      state_name:              o.state_name,
      status:                  o.status,
      status_name:             o.status_name,
      opportunity_status_name: o.opportunity_status_name,
      source_opportunity_id:   o.source_opportunity_id,
      ordered_at:              o.ordered_at,
    }))
    return res.status(200).json({ opportunities: opps })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

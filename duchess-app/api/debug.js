const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(
      `https://api.current-rms.com/api/v1/opportunities?per_page=5&page=1`,
      { headers: HEADERS }
    )
    const d = await r.json()
    const opps = (d.opportunities || []).map(o => ({
      number: o.number,
      name: (o.name || '').slice(0, 35),
      opportunity_status_name: o.opportunity_status_name,
      state: o.state,
      state_name: o.state_name,
      source_type: o.source_type,
      type: o.type,
      subject: o.subject,
      ordered_at: o.ordered_at,
      invoiced: o.invoiced,
      has_opportunity_deal: o.has_opportunity_deal,
    }))
    return res.status(200).json({ total: d.meta?.total_count, opportunities: opps })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

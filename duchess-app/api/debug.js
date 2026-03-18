const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    // Fetch specific jobs to compare ORDER vs QUOTATION fields
    const ids = ['7723', '7720', '7533', '7586', '7742', '7719']
    const results = []
    for (const id of ids) {
      const r = await fetch(
        `https://api.current-rms.com/api/v1/opportunities?q[number_eq]=QDB${id}`,
        { headers: HEADERS }
      )
      const d = await r.json()
      const o = d.opportunities?.[0]
      if (o) results.push({
        number: o.number,
        state: o.state,
        state_name: o.state_name,
        opportunity_status_name: o.opportunity_status_name,
        ordered_at: o.ordered_at,
        source_opportunity_id: o.source_opportunity_id,
        invoiced: o.invoiced,
      })
    }
    return res.status(200).json({ results })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

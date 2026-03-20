const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    // First get the ID for QDB7723
    const r1 = await fetch(
      `https://api.current-rms.com/api/v1/opportunities?q[number_eq]=QDB7723`,
      { headers: HEADERS }
    )
    const d1 = await r1.json()
    const opp = d1.opportunities?.[0]
    if (!opp) return res.status(200).json({ error: 'QDB7723 not found' })

    // Now get detail by ID
    const r2 = await fetch(
      `https://api.current-rms.com/api/v1/opportunities/${opp.id}`,
      { headers: HEADERS }
    )
    const d2 = await r2.json()

    return res.status(200).json({
      list_endpoint: {
        id: opp.id,
        number: opp.number,
        state: opp.state,
        state_name: opp.state_name,
        top_keys: Object.keys(opp).slice(0, 20),
      },
      detail_endpoint: {
        top_level_keys: Object.keys(d2),
        state: d2.state,
        state_name: d2.state_name,
        opportunity_state: d2.opportunity?.state,
        opportunity_state_name: d2.opportunity?.state_name,
      }
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    // Check total count and what per_page=1 returns in meta
    const r = await fetch(
      `https://api.current-rms.com/api/v1/opportunities?per_page=1`,
      { headers: HEADERS }
    )
    const d = await r.json()
    return res.status(200).json({
      meta: d.meta,
      top_level_keys: Object.keys(d),
      first_opportunity_keys: d.opportunities?.[0] ? Object.keys(d.opportunities[0]).slice(0,10) : [],
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

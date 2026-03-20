const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    // Page 1
    const r1 = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?per_page=25&page=1&q[state_eq]=3&q[starts_at_gteq]=2026-01-01',
      { headers: HEADERS }
    )
    const d1 = await r1.json()

    // Page 2
    const r2 = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?per_page=25&page=2&q[state_eq]=3&q[starts_at_gteq]=2026-01-01',
      { headers: HEADERS }
    )
    const d2 = await r2.json()

    return res.status(200).json({
      total_count: d1.meta?.total_row_count,
      page1_count: (d1.opportunities || []).length,
      page2_count: (d2.opportunities || []).length,
      page1_meta: d1.meta,
      page2_meta: d2.meta,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

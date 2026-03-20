const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    // Test 1: All Orders (state=3) with no date filter
    const r1 = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?per_page=1&q[state_eq]=3',
      { headers: HEADERS }
    )
    const d1 = await r1.json()

    // Test 2: Orders filtered by deliver_starts_at instead of starts_at
    const r2 = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?per_page=1&q[state_eq]=3&q[deliver_starts_at_gteq]=2026-01-01',
      { headers: HEADERS }
    )
    const d2 = await r2.json()

    // Test 3: Current starts_at filter (what sync uses now)
    const r3 = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?per_page=1&q[state_eq]=3&q[starts_at_gteq]=2026-01-01',
      { headers: HEADERS }
    )
    const d3 = await r3.json()

    return res.status(200).json({
      all_orders_no_date_filter: d1.meta?.total_row_count,
      orders_deliver_starts_at_from_2026: d2.meta?.total_row_count,
      orders_starts_at_from_2026: d3.meta?.total_row_count,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

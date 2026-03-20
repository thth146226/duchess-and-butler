const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const since = new Date()
    since.setMonth(since.getMonth() - 3)
    const until = new Date()
    until.setMonth(until.getMonth() + 12)

    const r = await fetch(
      `https://api.current-rms.com/api/v1/opportunities?per_page=1&q[starts_at_gteq]=${since.toISOString().split('T')[0]}&q[starts_at_lteq]=${until.toISOString().split('T')[0]}`,
      { headers: HEADERS }
    )
    const d = await r.json()
    return res.status(200).json({
      date_range: { since: since.toISOString().split('T')[0], until: until.toISOString().split('T')[0] },
      meta: d.meta,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

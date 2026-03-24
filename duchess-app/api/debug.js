const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?q[number_eq]=QDB7371',
      { headers: HEADERS }
    )
    const d = await r.json()
    const o = (d.opportunities || [])[0]
    return res.status(200).json({
      number: o?.number,
      starts_at: o?.starts_at,
      deliver_starts_at: o?.deliver_starts_at,
      deliver_ends_at: o?.deliver_ends_at,
      collect_starts_at: o?.collect_starts_at,
      collect_ends_at: o?.collect_ends_at,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

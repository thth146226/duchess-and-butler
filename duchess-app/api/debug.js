const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(
      'https://api.current-rms.com/api/v1/notes?q[notable_id_eq]=7822&q[notable_type_eq]=Opportunity',
      { headers: HEADERS }
    )
    const d = await r.json()
    return res.status(200).json(d)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

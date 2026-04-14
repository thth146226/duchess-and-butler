const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?q[number_eq]=QDB7748',
      { headers: HEADERS }
    )
    const d = await r.json()
    const o = (d.opportunities || [])[0]
    return res.status(200).json({
      number:       o?.number,
      notes:        o?.notes,
      description:  o?.description,
      custom_notes: o?.custom_fields,
      document_notes: o?.document_notes,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

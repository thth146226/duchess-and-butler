const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const refs = ['QDB7629','QDB7708']
    const results = []
    for (const ref of refs) {
      const r = await fetch(
        `https://api.current-rms.com/api/v1/opportunities?q[number_eq]=${ref}`,
        { headers: HEADERS }
      )
      const d = await r.json()
      const o = d.opportunities?.[0]
      if (o) results.push({
        number: o.number,
        state: o.state,
        state_name: o.state_name,
      })
    }
    return res.status(200).json({ results })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

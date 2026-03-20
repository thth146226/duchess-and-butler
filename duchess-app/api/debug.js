const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    const refs = ['QDB7678','QDB7719','QDB7650','QDB7724','QDB7727','QDB7720','QDB7723','QDB7533','QDB7586','QDB7741','QDB7742','QDB7730','QDB7474','QDB7048','QDB7365','QDB7582','QDB7704']
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
        ordered_at: o.ordered_at ? 'yes' : null,
      })
    }
    return res.status(200).json({ results })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

module.exports = async function handler(req, res) {
  try {
    // Try different endpoints
    const [r1, r2, r3] = await Promise.all([
      fetch('https://api.current-rms.com/api/v1/opportunities/7822/comments', { headers: HEADERS }),
      fetch('https://api.current-rms.com/api/v1/opportunities/7822/activities', { headers: HEADERS }),
      fetch('https://api.current-rms.com/api/v1/activities?q[trackable_id_eq]=7822', { headers: HEADERS }),
    ])
    const [d1, d2, d3] = await Promise.all([r1.json(), r2.json(), r3.json()])
    return res.status(200).json({ comments: d1, activities: d2, activities2: d3 })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

// Debug endpoint — shows raw Current RMS data for one opportunity

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY = process.env.CRMS_API_KEY

module.exports = async function handler(req, res) {
  try {
    // Get first opportunity from list
    const listRes = await fetch(
      'https://api.current-rms.com/api/v1/opportunities?per_page=1',
      {
        headers: {
          'X-AUTH-TOKEN': CRMS_API_KEY,
          'X-SUBDOMAIN': CRMS_SUBDOMAIN,
        }
      }
    )
    const listData = await listRes.json()
    const first = listData.opportunities?.[0]
    if (!first) return res.status(200).json({ error: 'No opportunities found' })

    // Get full detail
    const detailRes = await fetch(
      `https://api.current-rms.com/api/v1/opportunities/${first.id}`,
      {
        headers: {
          'X-AUTH-TOKEN': CRMS_API_KEY,
          'X-SUBDOMAIN': CRMS_SUBDOMAIN,
        }
      }
    )
    const detail = await detailRes.json()
    const opp = detail.opportunity || detail

    // Return key fields only
    return res.status(200).json({
      id: opp.id,
      number: opp.number,
      name: opp.name,
      starts_at: opp.starts_at,
      ends_at: opp.ends_at,
      delivery_date: opp.delivery_date,
      collection_date: opp.collection_date,
      opportunity_dates: opp.opportunity_dates,
      dates: opp.dates,
      all_keys: Object.keys(opp),
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

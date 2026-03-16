// Duchess & Butler — Current RMS Debug Endpoint v2
// GET /api/debug          → first opportunity (raw fields)
// GET /api/debug?id=12345 → specific opportunity

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY   = process.env.CRMS_API_KEY
const HEADERS = { 'X-AUTH-TOKEN': CRMS_API_KEY, 'X-SUBDOMAIN': CRMS_SUBDOMAIN }

function toDate(iso) { return iso ? iso.slice(0, 10) : null }
function toTime(iso) { return iso ? iso.slice(11, 16) : null }

module.exports = async function handler(req, res) {
  try {
    let opp
    if (req.query.id) {
      const r = await fetch(`https://api.current-rms.com/api/v1/opportunities/${req.query.id}`, { headers: HEADERS })
      const d = await r.json()
      opp = d.opportunity || d
    } else {
      const r = await fetch(`https://api.current-rms.com/api/v1/opportunities?per_page=1`, { headers: HEADERS })
      const d = await r.json()
      const first = d.opportunities?.[0]
      if (!first) return res.status(200).json({ error: 'No opportunities found' })
      const r2 = await fetch(`https://api.current-rms.com/api/v1/opportunities/${first.id}`, { headers: HEADERS })
      const d2 = await r2.json()
      opp = d2.opportunity || d2
    }
    return res.status(200).json({
      id:     opp.id,
      number: opp.number,
      name:   opp.name,
      status: opp.opportunity_status_name,
      client: opp.member?.name || opp.company_name,
      scheduling: {
        deliver_starts_at:      opp.deliver_starts_at,
        deliver_ends_at:        opp.deliver_ends_at,
        collect_starts_at:      opp.collect_starts_at,
        collect_ends_at:        opp.collect_ends_at,
        delivery_date_parsed:   toDate(opp.deliver_starts_at),
        collection_date_parsed: toDate(opp.collect_starts_at),
      },
      venue_fields: {
        venue_name:           opp.venue_name,
        venue_id:             opp.venue_id,
        location:             opp.location,
        delivery_address:     opp.delivery_address,
        billing_address:      opp.billing_address,
        destination:          opp.destination,
        venue:                opp.venue,
        delivery_instructions: opp.delivery_instructions,
      },
      all_keys: Object.keys(opp).sort(),
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

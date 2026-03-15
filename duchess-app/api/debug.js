// Duchess & Butler — Current RMS Debug Endpoint
// GET /api/debug          → shows first opportunity (raw + parsed dates)
// GET /api/debug?id=12345 → shows specific opportunity by CRMS id

const CRMS_SUBDOMAIN = process.env.CRMS_SUBDOMAIN
const CRMS_API_KEY   = process.env.CRMS_API_KEY

const HEADERS = {
  'X-AUTH-TOKEN': CRMS_API_KEY,
  'X-SUBDOMAIN':  CRMS_SUBDOMAIN,
}

function toDate(iso) { return iso ? iso.slice(0, 10) : null }
function toTime(iso) { return iso ? iso.slice(11, 16) : null }

module.exports = async function handler(req, res) {
  try {
    let opp

    if (req.query.id) {
      // Fetch specific opportunity
      const r = await fetch(
        `https://api.current-rms.com/api/v1/opportunities/${req.query.id}`,
        { headers: HEADERS }
      )
      const d = await r.json()
      opp = d.opportunity || d
    } else {
      // Fetch most recent opportunity
      const r = await fetch(
        `https://api.current-rms.com/api/v1/opportunities?per_page=1&page=1`,
        { headers: HEADERS }
      )
      const d = await r.json()
      const first = d.opportunities?.[0]
      if (!first) return res.status(200).json({ error: 'No opportunities found', raw: d })

      // Get full detail
      const r2 = await fetch(
        `https://api.current-rms.com/api/v1/opportunities/${first.id}`,
        { headers: HEADERS }
      )
      const d2 = await r2.json()
      opp = d2.opportunity || d2
    }

    // ── Parsed scheduling fields ─────────────────────────────────────────────
    const scheduling = {
      // Event window
      starts_at:             opp.starts_at,
      ends_at:               opp.ends_at,
      event_date_parsed:     toDate(opp.starts_at),

      // Delivery
      deliver_starts_at:     opp.deliver_starts_at,
      deliver_ends_at:       opp.deliver_ends_at,
      delivery_date_parsed:  toDate(opp.deliver_starts_at),
      delivery_time_parsed:  toTime(opp.deliver_starts_at),

      // Collection
      collect_starts_at:     opp.collect_starts_at,
      collect_ends_at:       opp.collect_ends_at,
      collection_date_parsed: toDate(opp.collect_starts_at),
      collection_time_parsed: toTime(opp.collect_starts_at),

      // Other phases
      prep_starts_at:        opp.prep_starts_at,
      load_starts_at:        opp.load_starts_at,
      setup_starts_at:       opp.setup_starts_at,
      takedown_starts_at:    opp.takedown_starts_at,
      unload_starts_at:      opp.unload_starts_at,

      // Legacy / fallback
      opportunity_dates:     opp.opportunity_dates,
    }

    return res.status(200).json({
      id:              opp.id,
      number:          opp.number,
      name:            opp.name,
      status:          opp.opportunity_status_name,
      client:          opp.member?.name || opp.company_name,
      venue:           opp.venue_name || opp.destination?.name,

      // ← This is what matters
      scheduling,

      // All top-level keys (to spot any new fields)
      all_keys:        Object.keys(opp).sort(),
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

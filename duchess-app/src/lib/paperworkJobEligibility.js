/**
 * Paperwork list eligibility — exclude internal fleet van movements, not hire jobs.
 * Uses fleet_vans registrations (source of truth) + the org's RMS naming convention:
 *   "{registration} RSV {nickname} In for …"
 * Does NOT exclude jobs solely because RMS returned zero items (real blocked hires stay visible).
 */

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normaliseTagList(tagList) {
  const tags = []
  if (!Array.isArray(tagList)) return tags

  for (const entry of tagList) {
    if (entry == null) continue
    const raw = String(entry).trim()
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        parsed.forEach((t) => tags.push(String(t).trim().toLowerCase()))
      } else {
        tags.push(String(parsed).trim().toLowerCase())
      }
    } catch {
      tags.push(raw.toLowerCase())
    }
  }

  return tags
}

function hasPaperworkExclusionTag(job) {
  const raw = job?.crms_raw
  if (!raw || typeof raw !== 'object') return false

  const tags = normaliseTagList(raw.tag_list)
  return tags.some((tag) =>
    tag === 'fleet'
    || tag === 'internal'
    || tag === 'vehicle movement'
    || tag === 'non-hire'
    || tag === 'non hire',
  )
}

/**
 * Fleet van movement booked in RMS as an opportunity with no hire line items.
 * Matches only when event_name starts with a known fleet registration and contains "In for".
 */
export function isFleetVanPaperworkMovement(job, fleetVans = []) {
  if (!job?.crms_id) return false
  if (hasPaperworkExclusionTag(job)) return true

  const eventName = String(job.event_name || '').trim()
  if (!eventName || !/\bin for\b/i.test(eventName)) return false

  for (const van of fleetVans) {
    const registration = String(van?.registration || '').trim()
    if (registration.length < 4) continue

    const pattern = new RegExp(`^${escapeRegExp(registration)}\\s+(?:RSV\\s+)?`, 'i')
    if (pattern.test(eventName)) return true
  }

  return false
}

export function isPaperworkEligibleJob(job, fleetVans = []) {
  if (!job) return false
  return !isFleetVanPaperworkMovement(job, fleetVans)
}

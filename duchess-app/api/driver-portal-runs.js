// GET /api/driver-portal-runs?token=...
// Driver Portal listing — service role, token auth (no RLS loosening).

const { HttpError, getDriverPortalRuns } = require('../server-lib/driverPortalRuns')

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const token = typeof req.query?.token === 'string' ? req.query.token : ''

  try {
    const result = await getDriverPortalRuns(token)
    return res.status(200).json(result)
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({ error: err.message })
    }

    const message = err?.message || 'Failed to load driver portal runs.'
    const isConfig = message.includes('credentials are not configured')
    return res.status(isConfig ? 500 : 502).json({ error: message })
  }
}

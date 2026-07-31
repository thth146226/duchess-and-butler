// GET  /api/driver-portal-runs?token=...
// PATCH /api/driver-portal-runs  { token, jobId, type }
// Driver Portal — service role, token auth (no RLS loosening).

const {
  HttpError,
  getDriverPortalRuns,
  markDriverPortalRunDone,
} = require('../server-lib/driverPortalRuns')

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    if (req.method === 'GET') {
      const token = typeof req.query?.token === 'string' ? req.query.token : ''
      const result = await getDriverPortalRuns(token)
      return res.status(200).json(result)
    }

    const result = await markDriverPortalRunDone(req.body || {})
    return res.status(200).json(result)
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({ error: err.message })
    }

    // Safe operational signal only — never log token, body, query URL, or secrets.
    console.error(
      req.method === 'PATCH'
        ? 'driver-portal-runs PATCH failed'
        : 'driver-portal-runs GET failed',
    )

    const isConfig =
      typeof err?.message === 'string' &&
      err.message.includes('credentials are not configured')

    if (req.method === 'PATCH') {
      return res.status(isConfig ? 500 : 502).json({
        error: 'Failed to complete driver portal run.',
      })
    }

    return res.status(isConfig ? 500 : 502).json({
      error: 'Failed to load driver portal runs.',
    })
  }
}

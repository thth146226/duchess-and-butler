// POST /api/operational-change-events — acknowledge operational change events.
// Auth: Supabase user JWT via requireAdminOrOperations (admin/operations only).

import { HttpError, requireAdminOrOperations } from '../server-lib/adminAuth.js'
import {
  acknowledgeOperationalChangeEvents,
  parseAcknowledgeBody,
} from '../server-lib/operationalChangeAcknowledge.js'

function parseRequestBody(req) {
  try {
    if (!req.body) return {}
    if (typeof req.body === 'string') return JSON.parse(req.body)
    return req.body
  } catch {
    throw new HttpError('Invalid JSON body.', 400)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { supabase, user } = await requireAdminOrOperations(req)
    const body = parseRequestBody(req)
    const { eventIds } = parseAcknowledgeBody(body)

    const result = await acknowledgeOperationalChangeEvents({
      supabase,
      userId: user.id,
      eventIds,
    })

    return res.status(200).json(result)
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({ error: err.message })
    }

    return res.status(500).json({
      error: err.message || 'Failed to acknowledge operational change events.',
    })
  }
}

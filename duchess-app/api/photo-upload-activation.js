import { createRequire } from 'module'
import { getSupabaseAdminClient } from '../server-lib/adminAuth.js'
import {
  evaluatePhotoUploadActivation,
  loadPhotoUploadPilotAllowlist,
  loadPhotoUploadRecoveryContingency,
  selectPhotoUploadIdentity,
} from '../src/lib/photoUploadActivationDecision.js'

const require = createRequire(import.meta.url)
const { resolveDriverByToken } = require('../server-lib/driverPortalRuns')

function requestedPurpose(body) {
  return body && body.purpose === 'recovery' ? 'recovery' : 'upload'
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ state: 'DENIED', purpose: 'upload' })
    return
  }

  const header = req.headers.authorization || req.headers.Authorization || ''
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    res.status(200).json({ state: 'DENIED', purpose: requestedPurpose(req.body) })
    return
  }
  const token = header.slice('Bearer '.length).trim()
  const purpose = requestedPurpose(req.body)
  if (!token) {
    res.status(200).json({ state: 'DENIED', purpose })
    return
  }

  let supabase
  try {
    supabase = getSupabaseAdminClient()
  } catch (_error) {
    res.status(503).json({ state: 'UNKNOWN', purpose })
    return
  }

  let officeUserId = null
  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (!error && data && data.user && typeof data.user.id === 'string' && data.user.id.length > 0) {
      officeUserId = data.user.id
    }
  } catch (_error) {
    officeUserId = null
  }

  let driverId = null
  if (!officeUserId) {
    try {
      const driver = await resolveDriverByToken(supabase, token)
      driverId = driver && typeof driver.id === 'string' ? driver.id : null
    } catch (error) {
      if (error && (error.statusCode === 400 || error.statusCode === 401 || error.statusCode === 403)) {
        res.status(200).json({ state: 'DENIED', purpose })
        return
      }
      res.status(503).json({ state: 'UNKNOWN', purpose })
      return
    }
  }

  const identity = selectPhotoUploadIdentity({ officeUserId, driverId })
  res.status(200).json(evaluatePhotoUploadActivation(identity, {
    allowlist: loadPhotoUploadPilotAllowlist(),
    purpose,
    recoveryContingency: loadPhotoUploadRecoveryContingency(),
  }))
}

export const PHOTO_UPLOAD_AUTHORIZED_ACTORS = Object.freeze([])
export const PHOTO_UPLOAD_PILOT_ACTOR_ENV = 'PHOTO_UPLOAD_PILOT_ACTOR'
export const PHOTO_UPLOAD_RECOVERY_CONTINGENCY_ENV = 'PHOTO_UPLOAD_RECOVERY_CONTINGENCY'

const ACTOR_TYPES = new Set(['office_user', 'driver_portal'])
const GRANT_TTL_MS = 60 * 1000
const PILOT_ACTOR_PATTERN = /^(office_user|driver_portal):([^\s:]+)$/

function validIdentity(identity) {
  return Boolean(
    identity
    && ACTOR_TYPES.has(identity.actorScopeType)
    && typeof identity.actorScopeId === 'string'
    && identity.actorScopeId.length > 0
  )
}

export function selectPhotoUploadIdentity(sources = {}) {
  if (typeof sources.officeUserId === 'string' && sources.officeUserId.length > 0) {
    return { actorScopeType: 'office_user', actorScopeId: sources.officeUserId }
  }
  if (typeof sources.driverId === 'string' && sources.driverId.length > 0) {
    return { actorScopeType: 'driver_portal', actorScopeId: sources.driverId }
  }
  return null
}

export function loadPhotoUploadPilotAllowlist(env = process.env) {
  const raw = env && typeof env[PHOTO_UPLOAD_PILOT_ACTOR_ENV] === 'string'
    ? env[PHOTO_UPLOAD_PILOT_ACTOR_ENV].trim()
    : ''
  if (!raw) {
    return PHOTO_UPLOAD_AUTHORIZED_ACTORS
  }
  const match = PILOT_ACTOR_PATTERN.exec(raw)
  if (!match) {
    return PHOTO_UPLOAD_AUTHORIZED_ACTORS
  }
  return Object.freeze([{
    actorScopeType: match[1],
    actorScopeId: match[2],
  }])
}

export function loadPhotoUploadRecoveryContingency(env = process.env) {
  return Boolean(env && env[PHOTO_UPLOAD_RECOVERY_CONTINGENCY_ENV] === '1')
}

export function evaluatePhotoUploadActivation(identity, options = {}) {
  const purpose = options.purpose === 'recovery' ? 'recovery' : 'upload'
  const now = typeof options.now === 'function' ? options.now() : Date.now()
  if (!validIdentity(identity)) {
    return { state: 'DENIED', purpose }
  }
  if (purpose === 'recovery') {
    if (options.recoveryContingency !== true || identity.actorScopeType !== 'office_user') {
      return { state: 'DENIED', purpose: 'recovery' }
    }
    return {
      state: 'AUTHORIZED',
      purpose: 'recovery',
      uploadsEnabled: false,
      actorScopeType: identity.actorScopeType,
      actorScopeId: identity.actorScopeId,
      expiresAt: now + GRANT_TTL_MS,
    }
  }
  const allowlist = options.allowlist || PHOTO_UPLOAD_AUTHORIZED_ACTORS
  const allowed = allowlist.some((entry) => (
    entry
    && entry.actorScopeType === identity.actorScopeType
    && entry.actorScopeId === identity.actorScopeId
  ))
  if (!allowed) {
    return { state: 'DENIED', purpose: 'upload' }
  }
  return {
    state: 'AUTHORIZED',
    purpose: 'upload',
    uploadsEnabled: true,
    actorScopeType: identity.actorScopeType,
    actorScopeId: identity.actorScopeId,
    expiresAt: now + GRANT_TTL_MS,
  }
}

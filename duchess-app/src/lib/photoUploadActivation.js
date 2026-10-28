const PRODUCTION_DATABASE_NAME = 'duchess-photo-upload-v1'

export const PHOTO_UPLOAD_ACTIVATION = 'DISABLED'
export const PHOTO_UPLOAD_ACTIVATION_BLOCKED = 'PHOTO_UPLOAD_ACTIVATION_BLOCKED'
export const PHOTO_UPLOAD_BLOCKED_MESSAGE = 'Photo upload is not enabled for this account. Nothing new is saved or sent.'

const listeners = new Set()
let state = PHOTO_UPLOAD_ACTIVATION
let grant = null
let generation = 0
let openContext = null
let guardedFactory = null

function snapshot() {
  return {
    state,
    grant: grant
      ? {
        actorScopeType: grant.actorScopeType,
        actorScopeId: grant.actorScopeId,
        expiresAt: grant.expiresAt,
        purpose: grant.purpose === 'recovery' ? 'recovery' : 'upload',
      }
      : null,
  }
}

function emit() {
  const current = snapshot()
  listeners.forEach((listener) => {
    listener(current)
  })
}

function expireGrant(now) {
  if (state === 'AUTHORIZED' && grant && grant.expiresAt <= now) {
    state = 'DENIED'
    grant = null
  }
}

export function getPhotoUploadActivation(now = Date.now()) {
  expireGrant(now)
  return snapshot()
}

export function subscribePhotoUploadActivation(listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetPhotoUploadActivationForTests() {
  generation += 1
  state = PHOTO_UPLOAD_ACTIVATION
  grant = null
  openContext = null
  emit()
}

export function grantPhotoUploadActivationForTests(actor, expiresAt = Date.now() + 60 * 1000, purpose = 'upload') {
  generation += 1
  state = 'AUTHORIZED'
  grant = {
    actorScopeType: actor.actorScopeType,
    actorScopeId: actor.actorScopeId,
    expiresAt,
    purpose: purpose === 'recovery' ? 'recovery' : 'upload',
  }
  emit()
}

export function revokePhotoUploadActivation() {
  generation += 1
  state = PHOTO_UPLOAD_ACTIVATION
  grant = null
  emit()
}

function productionOpenAllowed(actor) {
  expireGrant(Date.now())
  if (state !== 'AUTHORIZED' || !grant || !actor) {
    return false
  }
  if (grant.purpose === 'recovery') {
    return actor.purpose === 'recovery'
  }
  return actor.purpose !== 'recovery'
    && actor.actorScopeType === grant.actorScopeType
    && actor.actorScopeId === grant.actorScopeId
}

function blockedError() {
  const error = new Error(PHOTO_UPLOAD_ACTIVATION_BLOCKED)
  error.name = 'PhotoUploadActivationBlocked'
  error.code = PHOTO_UPLOAD_ACTIVATION_BLOCKED
  error.activation = state
  return error
}

export function assertProductionDatabaseOpen(dbName, actor) {
  ensureIndexedDbGuard()
  if (dbName !== PRODUCTION_DATABASE_NAME) {
    return
  }
  if (!productionOpenAllowed(actor)) {
    throw blockedError()
  }
}

export function withProductionOpenContext(actor, fn) {
  const previous = openContext
  openContext = actor || null
  try {
    return fn()
  } finally {
    openContext = previous
  }
}

export function installPhotoUploadIndexedDbGuard() {
  if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.open !== 'function') {
    return
  }
  if (guardedFactory === indexedDB) {
    return
  }
  const nativeOpen = indexedDB.open.bind(indexedDB)
  const factory = indexedDB
  factory.open = function openGuarded(name, version) {
    if (name === PRODUCTION_DATABASE_NAME) {
      if (!productionOpenAllowed(openContext)) {
        throw blockedError()
      }
    }
    if (arguments.length < 2) {
      return nativeOpen(name)
    }
    return nativeOpen(name, version)
  }
  guardedFactory = factory
}

function ensureIndexedDbGuard() {
  installPhotoUploadIndexedDbGuard()
}

async function defaultFetcher(token, requestedPurpose) {
  const recovery = requestedPurpose === 'recovery'
  const response = await fetch('/api/photo-upload-activation', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(recovery ? { 'Content-Type': 'application/json' } : {}),
    },
    body: recovery ? JSON.stringify({ purpose: 'recovery' }) : undefined,
  })
  if (!response.ok) {
    throw new Error('PHOTO_UPLOAD_ACTIVATION_UNAVAILABLE')
  }
  return response.json()
}

export async function refreshPhotoUploadActivation(options = {}) {
  const requestGeneration = generation + 1
  generation = requestGeneration
  state = 'UNKNOWN'
  grant = null
  emit()
  const now = typeof options.now === 'function' ? options.now : Date.now
  const requestedPurpose = options.purpose === 'recovery' ? 'recovery' : 'upload'
  const fetcher = typeof options.fetcher === 'function' ? options.fetcher : defaultFetcher
  try {
    const token = typeof options.getAccessToken === 'function' ? await options.getAccessToken() : null
    if (requestGeneration !== generation) {
      return getPhotoUploadActivation(now())
    }
    if (typeof token !== 'string' || token.length === 0) {
      state = 'DENIED'
      grant = null
      emit()
      return getPhotoUploadActivation(now())
    }
    const body = await fetcher(token, requestedPurpose)
    if (requestGeneration !== generation) {
      return getPhotoUploadActivation(now())
    }
    const expiresAt = body && Number.isInteger(body.expiresAt) ? body.expiresAt : 0
    const receivedPurpose = body && body.purpose === 'recovery' ? 'recovery' : 'upload'
    const allowedType = body && (body.actorScopeType === 'office_user' || body.actorScopeType === 'driver_portal')
    const allowed = Boolean(
      body
      && body.state === 'AUTHORIZED'
      && receivedPurpose === requestedPurpose
      && allowedType
      && typeof body.actorScopeId === 'string'
      && body.actorScopeId.length > 0
      && expiresAt > now()
    )
    if (!allowed) {
      state = body && body.state === 'UNKNOWN' ? 'UNKNOWN' : 'DENIED'
      grant = null
      emit()
      return getPhotoUploadActivation(now())
    }
    state = 'AUTHORIZED'
    grant = {
      actorScopeType: body.actorScopeType,
      actorScopeId: body.actorScopeId,
      expiresAt,
      purpose: receivedPurpose,
    }
    emit()
    return getPhotoUploadActivation(now())
  } catch (_error) {
    if (requestGeneration !== generation) {
      return getPhotoUploadActivation(now())
    }
    state = 'UNKNOWN'
    grant = null
    emit()
    return getPhotoUploadActivation(now())
  }
}

installPhotoUploadIndexedDbGuard()

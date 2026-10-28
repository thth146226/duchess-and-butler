import { PHOTO_UPLOAD_ACTOR_SCOPE_TYPES } from './photoUploadDb'
import {
  acquirePhotoUploadRuntime,
  releasePhotoUploadRuntime,
} from './photoUploadRuntime'

const releaseTimers = new Map()
const heldCounts = new Map()

export function retainDriverUploadRuntime(driverId, options = {}) {
  const pending = releaseTimers.get(driverId)
  if (pending) {
    clearTimeout(pending)
    releaseTimers.delete(driverId)
    heldCounts.set(driverId, (heldCounts.get(driverId) || 0) + 1)
    return
  }
  const count = heldCounts.get(driverId) || 0
  if (count === 0) {
    acquirePhotoUploadRuntime({
      ...options,
      actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL,
      actorScopeId: driverId,
    })
  }
  heldCounts.set(driverId, count + 1)
}

export function scheduleDriverUploadRuntimeRelease(driverId) {
  const count = (heldCounts.get(driverId) || 0) - 1
  if (count > 0) {
    heldCounts.set(driverId, count)
    return
  }
  heldCounts.set(driverId, 0)
  const existing = releaseTimers.get(driverId)
  if (existing) {
    clearTimeout(existing)
  }
  const timer = setTimeout(() => {
    releaseTimers.delete(driverId)
    if ((heldCounts.get(driverId) || 0) > 0) {
      return
    }
    heldCounts.delete(driverId)
    void releasePhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, driverId)
  }, 0)
  releaseTimers.set(driverId, timer)
}

export function resetDriverUploadSessionForTests() {
  for (const timer of releaseTimers.values()) {
    clearTimeout(timer)
  }
  releaseTimers.clear()
  heldCounts.clear()
}

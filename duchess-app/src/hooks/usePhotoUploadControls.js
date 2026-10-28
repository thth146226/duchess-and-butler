import { useEffect, useState } from 'react'
import {
  PHOTO_UPLOAD_BLOCKED_MESSAGE,
  getPhotoUploadActivation,
  subscribePhotoUploadActivation,
} from '../lib/photoUploadActivation'

export { PHOTO_UPLOAD_BLOCKED_MESSAGE }

export function usePhotoUploadControls() {
  const [activation, setActivation] = useState(() => getPhotoUploadActivation())

  useEffect(() => subscribePhotoUploadActivation(setActivation), [])

  const expired = Boolean(activation.grant && activation.grant.expiresAt <= Date.now())
  const blocked = activation.state !== 'AUTHORIZED' || expired
  return {
    blocked,
    message: PHOTO_UPLOAD_BLOCKED_MESSAGE,
    state: expired ? 'DENIED' : activation.state,
  }
}

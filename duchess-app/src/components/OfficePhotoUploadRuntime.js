import { useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { PHOTO_UPLOAD_ACTOR_SCOPE_TYPES } from '../lib/photoUploadDb'
import { acquirePhotoUploadRuntime, releasePhotoUploadRuntime } from '../lib/photoUploadRuntime'
import { supabase } from '../lib/supabase'

export default function OfficePhotoUploadRuntime() {
  const { user } = useAuth()
  const userId = user && user.id

  useEffect(() => {
    if (!userId) {
      return undefined
    }
    acquirePhotoUploadRuntime({
      actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
      actorScopeId: userId,
      supabaseClient: supabase,
    })
    return () => {
      releasePhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER, userId)
    }
  }, [userId])

  return null
}

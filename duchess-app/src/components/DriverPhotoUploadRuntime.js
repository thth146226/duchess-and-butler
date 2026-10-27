import { useEffect } from 'react'
import { driverPortalSupabase } from '../lib/driverPortalSupabase'
import {
  retainDriverUploadRuntime,
  scheduleDriverUploadRuntimeRelease,
} from '../lib/driverUploadSession'
import { resolveDriverSupabaseBearer } from '../hooks/useDriverPhotoUploadQueue'

export default function DriverPhotoUploadRuntime({ driverId }) {
  useEffect(() => {
    if (typeof driverId !== 'string' || driverId.length === 0) {
      return undefined
    }
    retainDriverUploadRuntime(driverId, {
      supabaseClient: driverPortalSupabase,
      getAccessToken: () => resolveDriverSupabaseBearer(driverPortalSupabase),
    })
    return () => {
      scheduleDriverUploadRuntimeRelease(driverId)
    }
  }, [driverId])

  return null
}

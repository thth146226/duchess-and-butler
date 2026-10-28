import { useEffect } from 'react'
import { driverPortalSupabase } from '../lib/driverPortalSupabase'
import {
  retainDriverUploadRuntime,
  scheduleDriverUploadRuntimeRelease,
} from '../lib/driverUploadSession'
export default function DriverPhotoUploadRuntime({ driverId, portalToken }) {
  useEffect(() => {
    if (typeof driverId !== 'string' || driverId.length === 0) {
      return undefined
    }
    const token = typeof portalToken === 'string' ? portalToken : ''
    retainDriverUploadRuntime(driverId, {
      supabaseClient: driverPortalSupabase,
      getAccessToken: () => Promise.resolve(token.length > 0 ? token : null),
    })
    return () => {
      scheduleDriverUploadRuntimeRelease(driverId)
    }
  }, [driverId, portalToken])

  return null
}

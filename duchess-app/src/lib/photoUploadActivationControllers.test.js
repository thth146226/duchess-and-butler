require('fake-indexeddb/auto')

import { createPhotoUploadQueueController } from '../hooks/usePhotoUploadQueue'
import { createDriverPhotoUploadQueueController } from '../hooks/useDriverPhotoUploadQueue'
import {
  DRIVER_REPORT_SOURCE_SURFACES,
  createDriverReportPhotoUploadQueueController,
} from '../hooks/useDriverReportPhotoUploadQueue'
import {
  OFFICE_REPORT_SOURCE_SURFACES,
  createOfficeReportPhotoUploadQueueController,
} from '../hooks/useOfficeReportPhotoUploadQueue'
import {
  installPhotoUploadIndexedDbGuard,
  resetPhotoUploadActivationForTests,
} from './photoUploadActivation'
import { PHOTO_UPLOAD_DB_NAME } from './photoUploadDb'
import {
  acquirePhotoUploadRuntime,
  releasePhotoUploadRuntime,
  resetPhotoUploadRuntimeRegistryForTests,
} from './photoUploadRuntime'

let productionOpens = 0
let guardedOpen = null

function sessionClient(userId) {
  return {
    auth: {
      async getSession() {
        return { data: { session: { access_token: 'token', user: { id: userId } } } }
      },
    },
  }
}

function imageFile() {
  return new File([Uint8Array.from([9, 8, 7, 6])], 'gate.jpg', { type: 'image/jpeg' })
}

describe('photo upload controllers stay closed without authorization', () => {
  beforeEach(() => {
    productionOpens = 0
    resetPhotoUploadActivationForTests()
    installPhotoUploadIndexedDbGuard()
    guardedOpen = indexedDB.open.bind(indexedDB)
    indexedDB.open = function openCounted(name, version) {
      const request = arguments.length < 2 ? guardedOpen(name) : guardedOpen(name, version)
      if (name === PHOTO_UPLOAD_DB_NAME) {
        productionOpens += 1
      }
      return request
    }
  })

  afterEach(async () => {
    indexedDB.open = guardedOpen
    resetPhotoUploadActivationForTests()
    await resetPhotoUploadRuntimeRegistryForTests()
  })

  test('enqueue, boot, retry, and runtime start do not open the production database', async () => {
    const file = imageFile()
    const office = createPhotoUploadQueueController({
      supabaseClient: sessionClient('actor-a'),
      randomUUID: () => 'office-q',
      createLeaseOwner: () => 'lease-office',
    })
    const driver = createDriverPhotoUploadQueueController({
      randomUUID: () => 'driver-q',
      createLeaseOwner: () => 'lease-driver',
    })
    const driverReport = createDriverReportPhotoUploadQueueController({
      sourceSurface: DRIVER_REPORT_SOURCE_SURFACES.DRIVER_REPORT_MODE,
      randomUUID: () => 'driver-report-q',
      createLeaseOwner: () => 'lease-driver-report',
    })
    const officeReport = createOfficeReportPhotoUploadQueueController({
      sourceSurface: OFFICE_REPORT_SOURCE_SURFACES.OFFICE_REPORTS,
      supabaseClient: sessionClient('actor-a'),
      randomUUID: () => 'office-report-q',
      createLeaseOwner: () => 'lease-office-report',
    })

    await office.boot()
    await driver.boot({ driverId: 'driver-a' })
    await driverReport.boot({ driverId: 'driver-a' })
    await officeReport.boot()

    const officeResult = await office.enqueueFiles({
      files: [file],
      jobId: 'job-1',
      runType: 'after_del',
      profile: { id: 'actor-a', name: 'Alex' },
    })
    const driverResult = await driver.enqueueFiles({
      files: [file],
      driverId: 'driver-a',
      jobId: 'job-1',
      runType: 'after_del',
      driverName: 'Sam',
    })
    const driverReportResult = await driverReport.enqueueFiles({
      files: [file],
      driverId: 'driver-a',
      provisionalId: 'prov-1',
      driverName: 'Sam',
    })
    const officeReportResult = await officeReport.enqueueFiles({
      files: [file],
      reportId: 'report-1',
      profile: { id: 'actor-a', name: 'Alex' },
    })

    expect(await office.manualUploadRetry({ queueId: 'office-q' })).toMatchObject({ ok: false })
    expect(await driver.manualUploadRetry({ queueId: 'driver-q' })).toMatchObject({ ok: false })
    expect(await driverReport.manualUploadRetry({ queueId: 'driver-report-q' })).toMatchObject({ ok: false })
    expect(await officeReport.manualDbRetry({ queueId: 'office-report-q' })).toMatchObject({ ok: false })
    expect(officeResult.accepted).toEqual([])
    expect(driverResult.accepted).toEqual([])
    expect(driverReportResult.accepted).toEqual([])
    expect(officeReportResult.accepted).toEqual([])

    const runtime = acquirePhotoUploadRuntime({
      actorScopeType: 'office_user',
      actorScopeId: 'actor-a',
      getAccessToken: async () => null,
      windowTarget: null,
      documentTarget: null,
      createTransport() {
        return { startUpload() { throw new Error('UPLOAD_API_CALLED') } }
      },
      createReconciler() {
        return {
          async inspectRemoteObject() { return { kind: 'REMOTE_INCOMPLETE' } },
          async reconcileEvidencePhotoRow() { return { kind: 'DB_ROW_FOUND' } },
        }
      },
    })
    await runtime.ready
    await releasePhotoUploadRuntime('office_user', 'actor-a')

    expect(productionOpens).toBe(0)
    await office.dispose()
    await driver.dispose()
    await driverReport.dispose()
    await officeReport.dispose()
  })
})

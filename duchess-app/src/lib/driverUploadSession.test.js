/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
import { PHOTO_UPLOAD_ACTOR_SCOPE_TYPES } from './photoUploadDb'
import {
  acquirePhotoUploadRuntime,
  getPhotoUploadRuntime,
  releasePhotoUploadRuntime,
  resetPhotoUploadRuntimeRegistryForTests,
} from './photoUploadRuntime'
import {
  resetDriverUploadSessionForTests,
  retainDriverUploadRuntime,
  scheduleDriverUploadRuntimeRelease,
} from './driverUploadSession'

function flushRelease() {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

function stubs(events, label) {
  return {
    createDb: () => ({
      async close() {
        events.push(`${label}:db-close`)
      },
    }),
    createTransport: () => ({
      startUpload() {
        return { abort() {}, done: new Promise(() => {}) }
      },
    }),
    createReconciler: () => ({
      async inspectRemoteObject() {
        return { kind: 'REMOTE_INCOMPLETE' }
      },
      async reconcileEvidencePhotoRow() {
        return { kind: 'DB_INSERT_SUCCEEDED', id: 'local' }
      },
    }),
    createStore: () => {
      events.push(`${label}:store`)
      return {
        async wake() {
          return { woke: true, resumed: 0 }
        },
        async stop() {
          events.push(`${label}:stop`)
        },
      }
    },
    getAccessToken: async () => 'synthetic-token',
    supabaseClient: {
      auth: {
        async getSession() {
          return { data: { session: null } }
        },
        onAuthStateChange() {
          return { data: { subscription: { unsubscribe() {} } } }
        },
      },
    },
  }
}

describe('driver upload session ownership', () => {
  afterEach(async () => {
    resetDriverUploadSessionForTests()
    await resetPhotoUploadRuntimeRegistryForTests()
  })

  test('screen changes do not stop the runtime and rapid remounts do not create another', async () => {
    const events = []
    retainDriverUploadRuntime('driver-a', stubs(events, 'driver-a'))
    expect(events.filter((item) => item === 'driver-a:store')).toHaveLength(1)
    expect(getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, 'driver-a')).not.toBeNull()

    retainDriverUploadRuntime('driver-a', stubs(events, 'driver-a'))
    expect(events.filter((item) => item === 'driver-a:store')).toHaveLength(1)

    scheduleDriverUploadRuntimeRelease('driver-a')
    scheduleDriverUploadRuntimeRelease('driver-a')
    retainDriverUploadRuntime('driver-a', stubs(events, 'driver-a'))
    await flushRelease()
    expect(events).not.toContain('driver-a:stop')
    expect(events.filter((item) => item === 'driver-a:store')).toHaveLength(1)
    expect(getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, 'driver-a')).not.toBeNull()
  })

  test('logout and explicit release stop only after the session is gone', async () => {
    const events = []
    retainDriverUploadRuntime('driver-a', stubs(events, 'driver-a'))
    scheduleDriverUploadRuntimeRelease('driver-a')
    await flushRelease()
    expect(events).toContain('driver-a:stop')
    expect(getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, 'driver-a')).toBeNull()
  })

  test('identity change stops the previous driver and keeps one runtime for the new one', async () => {
    const events = []
    retainDriverUploadRuntime('driver-a', stubs(events, 'driver-a'))
    scheduleDriverUploadRuntimeRelease('driver-a')
    retainDriverUploadRuntime('driver-b', stubs(events, 'driver-b'))
    await flushRelease()
    expect(events).toContain('driver-a:stop')
    expect(events).not.toContain('driver-b:stop')
    expect(getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, 'driver-a')).toBeNull()
    expect(getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, 'driver-b')).not.toBeNull()
    expect(events.filter((item) => item === 'driver-b:store')).toHaveLength(1)
  })

  test('a driver session release does not stop the office runtime', async () => {
    const events = []
    const office = acquirePhotoUploadRuntime({
      actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER,
      actorScopeId: 'office-user-1',
      ...stubs(events, 'office'),
    })
    retainDriverUploadRuntime('driver-a', stubs(events, 'driver-a'))
    retainDriverUploadRuntime('driver-a', stubs(events, 'driver-a'))
    scheduleDriverUploadRuntimeRelease('driver-a')
    await flushRelease()
    expect(getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER, 'office-user-1')).toBe(office)
    expect(events).not.toContain('office:stop')
    expect(getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, 'driver-a')).not.toBeNull()
    scheduleDriverUploadRuntimeRelease('driver-a')
    await flushRelease()
    expect(events).toContain('driver-a:stop')
    expect(getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER, 'office-user-1')).toBe(office)
    await releasePhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER, 'office-user-1')
    expect(events).toContain('office:stop')
  })
})

import { PHOTO_UPLOAD_ACTOR_SCOPE_TYPES, createPhotoUploadDb } from './photoUploadDb'
import { createPhotoUploadStore } from './photoUploadStore'
import { createPhotoUploadTransport } from './photoUploadTransport'

function createDefaultReconciler(options) {
  // Loaded on demand so node-environment tests that inject a reconciler
  // do not pull the browser Supabase client at module evaluation.
  const { createPhotoUploadReconciler } = require('./photoUploadReconciler')
  return createPhotoUploadReconciler(options)
}

const registry = new Map()

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function runtimeKey(actorScopeType, actorScopeId) {
  return `${actorScopeType}:${actorScopeId}`
}

function defaultWindow() {
  return typeof window !== 'undefined' ? window : null
}

function defaultDocument() {
  return typeof document !== 'undefined' ? document : null
}

export function getPhotoUploadRuntime(actorScopeType, actorScopeId) {
  if (!isNonEmptyString(actorScopeType) || !isNonEmptyString(actorScopeId)) {
    return null
  }
  const entry = registry.get(runtimeKey(actorScopeType, actorScopeId))
  return entry ? entry.publicApi : null
}

export function resolvePhotoUploadRuntime(actorScopeType, actorScopeId, getRuntime) {
  if (typeof getRuntime === 'function') {
    return getRuntime(actorScopeId)
  }
  return getPhotoUploadRuntime(actorScopeType, actorScopeId)
}

export async function wakePhotoUploadRuntime(actorScopeType, actorScopeId, getRuntime) {
  const runtime = resolvePhotoUploadRuntime(actorScopeType, actorScopeId, getRuntime)
  if (!runtime || typeof runtime.wake !== 'function') {
    return null
  }
  try {
    return await runtime.wake({ hiddenDuration: 0 })
  } catch (_error) {
    return null
  }
}

export function getPhotoUploadRuntimeStore(actorScopeType, actorScopeId, getRuntime) {
  const runtime = resolvePhotoUploadRuntime(actorScopeType, actorScopeId, getRuntime)
  if (!runtime || typeof runtime.getStore !== 'function') {
    return null
  }
  return runtime.getStore()
}

function createRuntimeEntry(options) {
  const actorScopeType = options.actorScopeType
  const actorScopeId = options.actorScopeId
  const now = typeof options.now === 'function' ? options.now : Date.now
  const createDb = options.createDb || createPhotoUploadDb
  const createTransport = options.createTransport || createPhotoUploadTransport
  const createReconciler = options.createReconciler || createDefaultReconciler
  const createStore = options.createStore || createPhotoUploadStore
  const windowTarget = options.windowTarget || defaultWindow()
  const documentTarget = options.documentTarget || defaultDocument()
  const supabaseClient = options.supabaseClient

  const db = createDb()
  const transport = createTransport()
  const reconciler = createReconciler({ supabaseClient })
  const getAccessToken = typeof options.getAccessToken === 'function'
    ? options.getAccessToken
    : async function readSessionAccessToken() {
      if (!supabaseClient || !supabaseClient.auth || typeof supabaseClient.auth.getSession !== 'function') {
        return null
      }
      const result = await supabaseClient.auth.getSession()
      const session = result && result.data ? result.data.session : null
      return session && isNonEmptyString(session.access_token) ? session.access_token : null
    }
  const isOnline = typeof options.isOnline === 'function'
    ? options.isOnline
    : () => (typeof navigator === 'undefined' || navigator.onLine !== false)

  const store = createStore({
    db,
    transport,
    reconciler,
    actorScopeType,
    actorScopeId,
    leaseOwner: options.leaseOwner,
    managerFactory: options.managerFactory,
    getAccessToken,
    isOnline,
    now,
    random: options.random,
    setTimeoutImpl: options.setTimeoutImpl,
    clearTimeoutImpl: options.clearTimeoutImpl,
  })

  const publicApi = {
    actorScopeType,
    actorScopeId,
    ready: Promise.resolve(),
    wake(context) {
      return store.wake(context)
    },
    getStore() {
      return store
    },
  }

  const detachFns = []
  let hiddenSince = null

  function hiddenDurationNow() {
    if (hiddenSince == null) {
      return 0
    }
    return now() - hiddenSince
  }

  function onVisibility() {
    if (!documentTarget) {
      return
    }
    if (documentTarget.visibilityState === 'hidden') {
      hiddenSince = now()
      return
    }
    if (documentTarget.visibilityState === 'visible') {
      const hiddenDuration = hiddenDurationNow()
      hiddenSince = null
      void publicApi.wake({ hiddenDuration })
    }
  }

  function onPageShow(event) {
    const hiddenDuration = hiddenDurationNow()
    hiddenSince = null
    void publicApi.wake({
      hiddenDuration,
      persisted: Boolean(event && event.persisted),
    })
  }

  function onOnline() {
    void publicApi.wake({ hiddenDuration: 0 })
  }

  if (documentTarget && typeof documentTarget.addEventListener === 'function') {
    documentTarget.addEventListener('visibilitychange', onVisibility)
    detachFns.push(() => {
      documentTarget.removeEventListener('visibilitychange', onVisibility)
    })
  }
  if (windowTarget && typeof windowTarget.addEventListener === 'function') {
    windowTarget.addEventListener('pageshow', onPageShow)
    windowTarget.addEventListener('online', onOnline)
    detachFns.push(() => {
      windowTarget.removeEventListener('pageshow', onPageShow)
      windowTarget.removeEventListener('online', onOnline)
    })
  }

  const auth = supabaseClient && supabaseClient.auth
  if (auth && typeof auth.onAuthStateChange === 'function') {
    try {
      const result = auth.onAuthStateChange((_event, session) => {
        if (actorScopeType === PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.OFFICE_USER) {
          const nextId = session && session.user ? session.user.id : null
          if (nextId !== actorScopeId) {
            return
          }
        }
        void publicApi.wake({ hiddenDuration: 0 })
      })
      const subscription = result && result.data ? result.data.subscription : null
      if (subscription && typeof subscription.unsubscribe === 'function') {
        detachFns.push(() => {
          subscription.unsubscribe()
        })
      }
    } catch (_error) {
      // Auth wake is additive. Lifecycle listeners still recover the queue.
    }
  }

  publicApi.ready = publicApi.wake({ hiddenDuration: 0 })

  return {
    refs: 1,
    publicApi,
    detach() {
      for (const fn of detachFns) {
        try {
          fn()
        } catch (_error) {
          // Listener removal is best-effort during teardown.
        }
      }
      detachFns.length = 0
    },
    async stop() {
      if (store && typeof store.stop === 'function') {
        await store.stop()
      }
      if (db && typeof db.close === 'function') {
        await db.close()
      }
    },
  }
}

export function acquirePhotoUploadRuntime(options = {}) {
  const actorScopeType = options.actorScopeType
  const actorScopeId = options.actorScopeId
  if (!isNonEmptyString(actorScopeType) || !isNonEmptyString(actorScopeId)) {
    throw new Error('actor scope is required')
  }
  const key = runtimeKey(actorScopeType, actorScopeId)
  const existing = registry.get(key)
  if (existing) {
    existing.refs += 1
    return existing.publicApi
  }
  const entry = createRuntimeEntry(options)
  registry.set(key, entry)
  return entry.publicApi
}

export function releasePhotoUploadRuntime(actorScopeType, actorScopeId) {
  if (!isNonEmptyString(actorScopeType) || !isNonEmptyString(actorScopeId)) {
    return Promise.resolve()
  }
  const key = runtimeKey(actorScopeType, actorScopeId)
  const entry = registry.get(key)
  if (!entry) {
    return Promise.resolve()
  }
  entry.refs -= 1
  if (entry.refs > 0) {
    return Promise.resolve()
  }
  registry.delete(key)
  entry.detach()
  return entry.stop()
}

export async function resetPhotoUploadRuntimeRegistryForTests() {
  const entries = [...registry.values()]
  registry.clear()
  await Promise.all(entries.map(async (entry) => {
    entry.detach()
    try {
      await entry.stop()
    } catch (_error) {
      return
    }
  }))
}

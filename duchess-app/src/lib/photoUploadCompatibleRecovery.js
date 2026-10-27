import {
  PHOTO_UPLOAD_DB_NAME,
  PHOTO_UPLOAD_DB_VERSION,
  PHOTO_UPLOAD_PAYLOAD_STORE,
  PHOTO_UPLOAD_QUEUE_STORE,
} from './photoUploadDb'

export const RAW_V1_OPEN_PROHIBITED = 'RAW_V1_OPEN_PROHIBITED'
export const PHOTO_UPLOAD_RECOVERY_MODE = 'compatible-v2'

export function prohibitRawVersionRequest(currentVersion, requestedVersion) {
  if (!Number.isInteger(currentVersion) || !Number.isInteger(requestedVersion) || requestedVersion < currentVersion) {
    const error = new Error(RAW_V1_OPEN_PROHIBITED)
    error.name = 'VersionError'
    error.code = RAW_V1_OPEN_PROHIBITED
    throw error
  }
}

function readMatchingRows(queueStore, payloadStore, actorScopeType, actorScopeId) {
  return new Promise((resolve, reject) => {
    const request = queueStore.getAll()
    request.onerror = () => reject(request.error || new Error('PHOTO_UPLOAD_RECOVERY_REQUEST_FAILED'))
    request.onsuccess = () => {
      const matched = (request.result || []).filter((row) => (
        row && row.actor_scope_type === actorScopeType && row.actor_scope_id === actorScopeId
      ))
      if (!payloadStore || matched.length === 0) {
        resolve(matched.map((row) => ({ row, payload: null })))
        return
      }
      const paired = new Array(matched.length)
      let pending = matched.length
      matched.forEach((row, index) => {
        const payloadId = typeof row.payload_id === 'string' && row.payload_id.length > 0
          ? row.payload_id
          : row.queue_id
        const getRequest = payloadStore.get(payloadId)
        getRequest.onerror = () => reject(getRequest.error || new Error('PHOTO_UPLOAD_RECOVERY_REQUEST_FAILED'))
        getRequest.onsuccess = () => {
          let payload = getRequest.result || null
          if (payload && (payload.actor_scope_type !== row.actor_scope_type || payload.actor_scope_id !== row.actor_scope_id)) {
            payload = null
          }
          paired[index] = { row, payload }
          pending -= 1
          if (pending === 0) {
            resolve(paired)
          }
        }
      })
    }
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('PHOTO_UPLOAD_RECOVERY_TRANSACTION_FAILED'))
    transaction.onabort = () => reject(transaction.error || new Error('PHOTO_UPLOAD_RECOVERY_TRANSACTION_ABORTED'))
  })
}

function openExisting(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onupgradeneeded = () => {
      const transaction = request.transaction
      if (transaction && typeof transaction.abort === 'function') {
        transaction.abort()
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('PHOTO_UPLOAD_RECOVERY_OPEN_FAILED'))
  })
}

async function bytesOf(blob) {
  if (!(blob instanceof Blob)) {
    return null
  }
  return new Uint8Array(await blob.arrayBuffer())
}

function classify(version, inlineBytes, payloadBytes) {
  const inline = inlineBytes != null
  const payload = payloadBytes != null
  if (version < PHOTO_UPLOAD_DB_VERSION && inline) {
    return 'v1-inline'
  }
  if (inline && payload) {
    return 'v2-unmigrated-with-copy'
  }
  if (inline) {
    return 'v2-unmigrated-inline'
  }
  if (payload) {
    return 'v2-payload'
  }
  return 'metadata-only'
}

export function createPhotoUploadRecoveryDb(options = {}) {
  const dbName = options.dbName || PHOTO_UPLOAD_DB_NAME
  if (options.requestedVersion != null) {
    prohibitRawVersionRequest(PHOTO_UPLOAD_DB_VERSION, options.requestedVersion)
  }
  let database = null
  let closed = false

  async function connection() {
    if (closed) {
      throw new Error('PHOTO_UPLOAD_RECOVERY_CLOSED')
    }
    if (!database) {
      database = await openExisting(dbName)
    }
    return database
  }

  async function readStoredRecords(actor) {
    const actorScopeType = actor && actor.actorScopeType
    const actorScopeId = actor && actor.actorScopeId
    const db = await connection()
    const storeNames = [PHOTO_UPLOAD_QUEUE_STORE]
    const hasPayloadStore = db.objectStoreNames.contains(PHOTO_UPLOAD_PAYLOAD_STORE)
    if (hasPayloadStore) {
      storeNames.push(PHOTO_UPLOAD_PAYLOAD_STORE)
    }
    const tx = db.transaction(storeNames, 'readonly')
    const done = transactionDone(tx)
    const queueStore = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
    const payloadStore = hasPayloadStore ? tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE) : null
    const paired = await readMatchingRows(queueStore, payloadStore, actorScopeType, actorScopeId)
    const staged = paired.map(({ row, payload }) => ({
      queueId: row.queue_id,
      status: row.status,
      leaseOwner: row.lease_owner,
      leaseGeneration: row.lease_generation,
      inlineBlob: row.blob instanceof Blob ? row.blob : null,
      payloadBlob: payload && payload.blob instanceof Blob ? payload.blob : null,
    }))
    await done
    const records = []
    for (const row of staged) {
      const inlineBytes = await bytesOf(row.inlineBlob)
      const payloadBytes = await bytesOf(row.payloadBlob)
      records.push({
        queueId: row.queueId,
        status: row.status,
        leaseOwner: row.leaseOwner,
        leaseGeneration: row.leaseGeneration,
        inlineBytes,
        payloadBytes,
        storage: classify(db.version, inlineBytes, payloadBytes),
      })
    }
    return {
      name: db.name,
      version: db.version,
      stores: Array.from(db.objectStoreNames),
      records,
    }
  }

  return {
    mode: PHOTO_UPLOAD_RECOVERY_MODE,
    uploadsEnabled: false,
    async inspect() {
      const db = await connection()
      return {
        name: db.name,
        version: db.version,
        stores: Array.from(db.objectStoreNames),
        uploadsEnabled: false,
        rawV1Rollback: 'prohibited',
      }
    },
    readActorRecords: readStoredRecords,
    async close() {
      closed = true
      if (database && typeof database.close === 'function') {
        database.close()
      }
      database = null
    },
  }
}

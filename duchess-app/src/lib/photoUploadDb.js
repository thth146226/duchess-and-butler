import { openDB as idbOpenDB } from 'idb'
import { PHOTO_UPLOAD_STATUSES, isPhotoUploadStatus } from './photoUploadDomain'

export const PHOTO_UPLOAD_DB_NAME = 'duchess-photo-upload-v1'
export const PHOTO_UPLOAD_DB_VERSION = 1
export const PHOTO_UPLOAD_QUEUE_STORE = 'photo_upload_queue'
export const PHOTO_UPLOAD_RECORD_SCHEMA_VERSION = 1

export const PHOTO_UPLOAD_DB_ERROR_CODES = Object.freeze({
  INVALID_RECORD: 'INVALID_RECORD',
  ACTOR_SCOPE_CONFLICT: 'ACTOR_SCOPE_CONFLICT',
  BLOB_CLEANUP_FORBIDDEN: 'BLOB_CLEANUP_FORBIDDEN',
  DATABASE_ERROR: 'DATABASE_ERROR',
})

export const PHOTO_UPLOAD_ACTOR_SCOPE_TYPES = Object.freeze({
  OFFICE_USER: 'office_user',
  DRIVER_PORTAL: 'driver_portal',
})

export const PHOTO_UPLOAD_RECORD_FIELDS = Object.freeze([
  'schema_version',
  'queue_id',
  'blob',
  'file_name',
  'mime_type',
  'file_size',
  'source_surface',
  'entity_type',
  'entity_id',
  'provisional_id',
  'actor_scope_type',
  'actor_scope_id',
  'run_type',
  'storage_path',
  'status',
  'upload_attempt_count',
  'db_attempt_count',
  'next_retry_at',
  'retry_phase',
  'discard_requested',
  'discard_requested_at',
  'failure_stage',
  'last_error',
  'last_http_status',
  'tus_upload_url',
  'tus_created_at',
  'bytes_uploaded',
  'bytes_total',
  'remote_public_url',
  'db_row_id',
  'metadata_payload',
  'lease_owner',
  'lease_generation',
  'lease_expires_at',
  'remote_reconciliation_status',
  'remote_cleanup_attempt_count',
  'remote_cleanup_last_error',
  'created_at',
  'updated_at',
  'completed_at',
])

const ALLOWED_FIELDS = new Set(PHOTO_UPLOAD_RECORD_FIELDS)

const ACTOR_TYPES = new Set(Object.values(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES))

const DRAFT_STATUSES = new Set([
  PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED,
  PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN,
])

const SENSITIVE_KEYS = new Set([
  'access_token',
  'refresh_token',
  'portal_token',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'service_role',
  'apikey',
  'api_key',
  'credential',
  'credentials',
])

const TIMESTAMP_FIELDS = new Set([
  'created_at',
  'updated_at',
  'completed_at',
  'next_retry_at',
  'discard_requested_at',
  'tus_created_at',
  'lease_expires_at',
])

export class PhotoUploadDbError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'PhotoUploadDbError'
    this.code = code
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

function invalidRecord(message) {
  return new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.INVALID_RECORD, message)
}

function actorConflict(message) {
  return new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.ACTOR_SCOPE_CONFLICT, message)
}

function blobCleanupForbidden(message) {
  return new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.BLOB_CLEANUP_FORBIDDEN, message)
}

function wrapDatabaseError(error) {
  if (error instanceof PhotoUploadDbError) {
    return error
  }
  const wrapped = new PhotoUploadDbError(
    PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR,
    error && error.message ? String(error.message) : 'DATABASE_ERROR',
    error
  )
  if (error && error.name === 'QuotaExceededError') {
    wrapped.name = 'QuotaExceededError'
  }
  return wrapped
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isNullableNonEmptyString(value) {
  return value === null || isNonEmptyString(value)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob)
}

function assertSanitizedError(value, fieldName) {
  if (value === null) {
    return
  }
  if (value instanceof Error) {
    throw invalidRecord(`${fieldName} must not be a raw Error`)
  }
  if (!isPlainObject(value)) {
    throw invalidRecord(`${fieldName} must be null or a sanitized error object`)
  }
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('code') || !keys.includes('message')) {
    throw invalidRecord(`${fieldName} must contain only code and message`)
  }
  if (value.code !== null && typeof value.code !== 'string') {
    throw invalidRecord(`${fieldName}.code must be a string or null`)
  }
  if (typeof value.message !== 'string') {
    throw invalidRecord(`${fieldName}.message must be a string`)
  }
}

function assertNoSensitiveKeys(value) {
  if (value === null || value === undefined) {
    return
  }
  if (value instanceof Blob) {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveKeys(item)
    }
    return
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
        throw invalidRecord(`Sensitive metadata key rejected: ${key}`)
      }
      assertNoSensitiveKeys(value[key])
    }
  }
}

function sameActor(record, actorScopeType, actorScopeId) {
  return record.actor_scope_type === actorScopeType && record.actor_scope_id === actorScopeId
}

function copyRecord(record) {
  const copy = {}
  for (const field of PHOTO_UPLOAD_RECORD_FIELDS) {
    copy[field] = record[field]
  }
  return copy
}

function requireActorScope(actorScopeType, actorScopeId) {
  if (!ACTOR_TYPES.has(actorScopeType) || !isNonEmptyString(actorScopeId)) {
    throw invalidRecord('actor scope is required')
  }
}

function validateRecord(record) {
  if (!isPlainObject(record)) {
    throw invalidRecord('record must be a plain object')
  }

  const keys = Object.keys(record)
  for (const key of keys) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw invalidRecord(`Unknown top-level field: ${key}`)
    }
  }
  for (const field of PHOTO_UPLOAD_RECORD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw invalidRecord(`Missing top-level field: ${field}`)
    }
  }

  if (record.schema_version !== PHOTO_UPLOAD_RECORD_SCHEMA_VERSION) {
    throw invalidRecord('schema_version must be 1')
  }
  if (!isNonEmptyString(record.queue_id)) {
    throw invalidRecord('queue_id must be a non-empty string')
  }
  if (!isNonEmptyString(record.file_name)) {
    throw invalidRecord('file_name must be a non-empty string')
  }
  if (!isNonEmptyString(record.mime_type)) {
    throw invalidRecord('mime_type must be a non-empty string')
  }
  if (!isNonNegativeInteger(record.file_size)) {
    throw invalidRecord('file_size must be an integer >= 0')
  }
  if (!isNonNegativeInteger(record.bytes_total) || record.bytes_total !== record.file_size) {
    throw invalidRecord('bytes_total must equal file_size')
  }
  if (!isNonNegativeInteger(record.bytes_uploaded) || record.bytes_uploaded > record.bytes_total) {
    throw invalidRecord('bytes_uploaded must be an integer >= 0 and <= bytes_total')
  }
  if (!isNonNegativeInteger(record.upload_attempt_count)) {
    throw invalidRecord('upload_attempt_count must be an integer >= 0')
  }
  if (!isNonNegativeInteger(record.db_attempt_count)) {
    throw invalidRecord('db_attempt_count must be an integer >= 0')
  }
  if (!isNonNegativeInteger(record.lease_generation)) {
    throw invalidRecord('lease_generation must be an integer >= 0')
  }
  if (!isNonNegativeInteger(record.remote_cleanup_attempt_count)) {
    throw invalidRecord('remote_cleanup_attempt_count must be an integer >= 0')
  }
  if (!isPhotoUploadStatus(record.status)) {
    throw invalidRecord('status is not a frozen photo upload status')
  }
  if (!ACTOR_TYPES.has(record.actor_scope_type)) {
    throw invalidRecord('actor_scope_type is invalid')
  }
  if (!isNonEmptyString(record.actor_scope_id)) {
    throw invalidRecord('actor_scope_id must be a non-empty string')
  }
  if (!isNonEmptyString(record.source_surface)) {
    throw invalidRecord('source_surface must be a non-empty string')
  }
  if (!isNonEmptyString(record.entity_type)) {
    throw invalidRecord('entity_type must be a non-empty string')
  }
  if (!isNullableNonEmptyString(record.provisional_id)) {
    throw invalidRecord('provisional_id must be a non-empty string or null')
  }
  if (!isNullableNonEmptyString(record.run_type)) {
    throw invalidRecord('run_type must be a non-empty string or null')
  }

  const draft = DRAFT_STATUSES.has(record.status)
  if (draft) {
    if (record.entity_id !== null && !isNonEmptyString(record.entity_id)) {
      throw invalidRecord('entity_id must be a non-empty string or null for draft statuses')
    }
    if (record.storage_path !== null && !isNonEmptyString(record.storage_path)) {
      throw invalidRecord('storage_path must be a non-empty string or null for draft statuses')
    }
  } else {
    if (!isNonEmptyString(record.entity_id)) {
      throw invalidRecord('entity_id must be a non-empty string')
    }
    if (!isNonEmptyString(record.storage_path)) {
      throw invalidRecord('storage_path must be a non-empty string')
    }
  }

  if (record.status === PHOTO_UPLOAD_STATUSES.DONE) {
    if (record.blob !== null && !(record.blob instanceof Blob)) {
      throw invalidRecord('blob must be a Blob or null when status is DONE')
    }
  } else if (!(record.blob instanceof Blob)) {
    throw invalidRecord('blob must be retained as a Blob until DONE cleanup')
  }

  if (record.blob instanceof Blob) {
    if (record.blob.size !== record.file_size) {
      throw invalidRecord('blob.size must equal file_size')
    }
    if (record.blob.type !== record.mime_type) {
      throw invalidRecord('blob.type must equal mime_type')
    }
  }

  if (typeof record.discard_requested !== 'boolean') {
    throw invalidRecord('discard_requested must be a boolean')
  }
  if (!isNullableNonEmptyString(record.retry_phase)) {
    throw invalidRecord('retry_phase must be a non-empty string or null')
  }
  if (!isNullableNonEmptyString(record.failure_stage)) {
    throw invalidRecord('failure_stage must be a non-empty string or null')
  }
  if (record.last_http_status !== null && !isNonNegativeInteger(record.last_http_status)) {
    throw invalidRecord('last_http_status must be an integer >= 0 or null')
  }
  if (!isNullableNonEmptyString(record.tus_upload_url)) {
    throw invalidRecord('tus_upload_url must be a non-empty string or null')
  }
  if (!isNullableNonEmptyString(record.remote_public_url)) {
    throw invalidRecord('remote_public_url must be a non-empty string or null')
  }
  if (!isNullableNonEmptyString(record.db_row_id)) {
    throw invalidRecord('db_row_id must be a non-empty string or null')
  }
  if (!isNullableNonEmptyString(record.lease_owner)) {
    throw invalidRecord('lease_owner must be a non-empty string or null')
  }
  if (!isNullableNonEmptyString(record.remote_reconciliation_status)) {
    throw invalidRecord('remote_reconciliation_status must be a non-empty string or null')
  }
  if (record.metadata_payload !== null && !isPlainObject(record.metadata_payload)) {
    throw invalidRecord('metadata_payload must be a plain object or null')
  }

  assertSanitizedError(record.last_error, 'last_error')
  assertSanitizedError(record.remote_cleanup_last_error, 'remote_cleanup_last_error')
  assertNoSensitiveKeys(record.metadata_payload)

  for (const field of TIMESTAMP_FIELDS) {
    if (record[field] !== null && !isNonNegativeInteger(record[field])) {
      throw invalidRecord(`${field} must be epoch milliseconds or null`)
    }
  }

  return copyRecord(record)
}

function upgradePhotoUploadDb(database) {
  if (database.objectStoreNames.contains(PHOTO_UPLOAD_QUEUE_STORE)) {
    return
  }
  const store = database.createObjectStore(PHOTO_UPLOAD_QUEUE_STORE, {
    keyPath: 'queue_id',
  })
  store.createIndex('by_actor', ['actor_scope_type', 'actor_scope_id'])
  store.createIndex('by_actor_status', ['actor_scope_type', 'actor_scope_id', 'status'])
}

export function createPhotoUploadDb(options = {}) {
  const dbName = options.dbName || PHOTO_UPLOAD_DB_NAME
  const open = options.openDB || idbOpenDB
  let dbPromise = null

  async function getDb() {
    if (!dbPromise) {
      dbPromise = Promise.resolve()
        .then(() =>
          open(dbName, PHOTO_UPLOAD_DB_VERSION, {
            upgrade: upgradePhotoUploadDb,
          })
        )
        .catch((error) => {
          dbPromise = null
          throw wrapDatabaseError(error)
        })
    }
    return dbPromise
  }

  return {
    async putRecord(record) {
      const validated = validateRecord(record)
      const db = await getDb()
      const tx = db.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
      const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
      try {
        const existing = await store.get(validated.queue_id)
        if (existing && !sameActor(existing, validated.actor_scope_type, validated.actor_scope_id)) {
          throw actorConflict('queue_id is owned by a different actor')
        }
        await store.put(validated)
        await tx.done
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async getRecord({ queueId, actorScopeType, actorScopeId }) {
      if (!isNonEmptyString(queueId)) {
        throw invalidRecord('queueId must be a non-empty string')
      }
      requireActorScope(actorScopeType, actorScopeId)
      const db = await getDb()
      try {
        const record = await db.get(PHOTO_UPLOAD_QUEUE_STORE, queueId)
        if (!record || !sameActor(record, actorScopeType, actorScopeId)) {
          return null
        }
        return record
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async listRecordsForActor({ actorScopeType, actorScopeId }) {
      requireActorScope(actorScopeType, actorScopeId)
      const db = await getDb()
      try {
        return await db.getAllFromIndex(
          PHOTO_UPLOAD_QUEUE_STORE,
          'by_actor',
          [actorScopeType, actorScopeId]
        )
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async listRecordsForActorByStatus({ actorScopeType, actorScopeId, status }) {
      requireActorScope(actorScopeType, actorScopeId)
      if (!isPhotoUploadStatus(status)) {
        throw invalidRecord('status is not a frozen photo upload status')
      }
      const db = await getDb()
      try {
        return await db.getAllFromIndex(
          PHOTO_UPLOAD_QUEUE_STORE,
          'by_actor_status',
          [actorScopeType, actorScopeId, status]
        )
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async deleteLocalRecord({ queueId, actorScopeType, actorScopeId }) {
      if (!isNonEmptyString(queueId)) {
        throw invalidRecord('queueId must be a non-empty string')
      }
      requireActorScope(actorScopeType, actorScopeId)
      const db = await getDb()
      const tx = db.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
      const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
      try {
        const existing = await store.get(queueId)
        if (!existing) {
          await tx.done
          return
        }
        if (!sameActor(existing, actorScopeType, actorScopeId)) {
          throw actorConflict('cannot delete a record owned by a different actor')
        }
        await store.delete(queueId)
        await tx.done
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async clearDoneBlob({ queueId, actorScopeType, actorScopeId, updatedAt }) {
      if (!isNonEmptyString(queueId)) {
        throw invalidRecord('queueId must be a non-empty string')
      }
      requireActorScope(actorScopeType, actorScopeId)
      if (!isNonNegativeInteger(updatedAt)) {
        throw invalidRecord('updatedAt must be epoch milliseconds')
      }
      const db = await getDb()
      const tx = db.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readwrite')
      const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
      try {
        const existing = await store.get(queueId)
        if (!existing) {
          throw invalidRecord('record not found')
        }
        if (!sameActor(existing, actorScopeType, actorScopeId)) {
          throw actorConflict('cannot clear a blob owned by a different actor')
        }
        if (existing.status !== PHOTO_UPLOAD_STATUSES.DONE) {
          throw blobCleanupForbidden('Blob cleanup is allowed only for DONE records')
        }
        const updated = copyRecord(existing)
        updated.blob = null
        updated.updated_at = updatedAt
        await store.put(updated)
        await tx.done
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async close() {
      if (!dbPromise) {
        return
      }
      const pending = dbPromise
      dbPromise = null
      try {
        const db = await pending
        if (db && typeof db.close === 'function') {
          db.close()
        }
      } catch (_error) {
        return
      }
    },
  }
}

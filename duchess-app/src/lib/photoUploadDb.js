import { openDB as idbOpenDB } from 'idb'
import { PHOTO_UPLOAD_STATUSES, isPhotoUploadStatus } from './photoUploadDomain'
import { abbreviateQueueId, recordPhotoUploadDiagnostic } from './photoUploadDiagnostics'
import { assertProductionDatabaseOpen, withProductionOpenContext } from './photoUploadActivation'

export const PHOTO_UPLOAD_DB_NAME = 'duchess-photo-upload-v1'
export const PHOTO_UPLOAD_DB_VERSION = 2
export const PHOTO_UPLOAD_GLOBAL_DB_VERSION_LIMITATION = 'IndexedDB stores one version for the whole database. Opening duchess-photo-upload-v1 at version 2 upgrades that shared database for every actor in the browser. Promoting payloads is limited to the authorized actor, and that is not complete isolation.'
export const PHOTO_UPLOAD_QUEUE_STORE = 'photo_upload_queue'
export const PHOTO_UPLOAD_PAYLOAD_STORE = 'photo_upload_payloads'
export const PHOTO_UPLOAD_RECORD_SCHEMA_VERSION = 1
const PAYLOAD_VERIFY_CHUNK_BYTES = 65536
const LEGACY_MIGRATION_RETRY_MS = 30000

export const PHOTO_UPLOAD_DB_ERROR_CODES = Object.freeze({
  INVALID_RECORD: 'INVALID_RECORD',
  ACTOR_SCOPE_CONFLICT: 'ACTOR_SCOPE_CONFLICT',
  BLOB_CLEANUP_FORBIDDEN: 'BLOB_CLEANUP_FORBIDDEN',
  DATABASE_ERROR: 'DATABASE_ERROR',
  LEASE_FENCE_CONFLICT: 'LEASE_FENCE_CONFLICT',
  LEASE_NOT_AVAILABLE: 'LEASE_NOT_AVAILABLE',
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

function leaseFenceConflict(message) {
  return new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_FENCE_CONFLICT, message)
}

function leaseNotAvailable(message) {
  return new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_NOT_AVAILABLE, message)
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isLeaseExpired(record, now) {
  return record.lease_expires_at === null || record.lease_expires_at <= now
}

function requireLeaseOwner(leaseOwner) {
  if (!isNonEmptyString(leaseOwner)) {
    throw invalidRecord('leaseOwner must be a non-empty string')
  }
}

function requireLeaseGeneration(leaseGeneration) {
  if (!isNonNegativeInteger(leaseGeneration)) {
    throw invalidRecord('leaseGeneration must be an integer >= 0')
  }
}

function requireNow(now) {
  if (!isNonNegativeInteger(now)) {
    throw invalidRecord('now must be epoch milliseconds')
  }
}

function requireLeaseTtlMs(leaseTtlMs) {
  if (!isPositiveInteger(leaseTtlMs)) {
    throw invalidRecord('leaseTtlMs must be an integer > 0')
  }
}

function requireQueueId(queueId) {
  if (!isNonEmptyString(queueId)) {
    throw invalidRecord('queueId must be a non-empty string')
  }
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

function trace(event, data) {
  try {
    recordPhotoUploadDiagnostic(event, data)
  } catch (_error) {
    return
  }
}

function nativeErrorClass(error) {
  if (error && typeof error.name === 'string' && error.name.length > 0 && error.name.length <= 80) {
    return error.name
  }
  return 'Error'
}

function nativeErrorReason(error) {
  const code = error && error.code
  if (typeof code === 'string' && code.length > 0 && code.length <= 64) {
    return code
  }
  if (typeof code === 'number' && Number.isFinite(code)) {
    return code
  }
  return 'NO_NATIVE_CODE'
}

const NATIVE_MESSAGE_CLASS = Object.freeze({
  BLOB_FILE_PREPARATION: 'BLOB_FILE_PREPARATION',
  IDB_SERVER_CONNECTION_LOST: 'IDB_SERVER_CONNECTION_LOST',
  IDB_INTERNAL_SERVER_ERROR: 'IDB_INTERNAL_SERVER_ERROR',
  NO_IN_PROGRESS_TRANSACTION: 'NO_IN_PROGRESS_TRANSACTION',
  OTHER_UNKNOWN_ERROR: 'OTHER_UNKNOWN_ERROR',
  NO_MESSAGE: 'NO_MESSAGE',
})

const ACTOR_STATUS_INDEX_FIELDS = Object.freeze([
  'actor_scope_type',
  'actor_scope_id',
  'status',
])

const UNDETERMINED_INDEX_DIAGNOSTIC = 'UNDETERMINED'

function classifyNativeErrorMessage(error) {
  let message
  try {
    if (error === null || typeof error !== 'object') {
      return NATIVE_MESSAGE_CLASS.NO_MESSAGE
    }
    message = error.message
  } catch (_error) {
    return NATIVE_MESSAGE_CLASS.NO_MESSAGE
  }
  if (typeof message !== 'string' || message.length === 0) {
    return NATIVE_MESSAGE_CLASS.NO_MESSAGE
  }
  if (
    message.indexOf('Error preparing Blob/File data to be stored in object store') !== -1
    || message.indexOf('The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired') !== -1
  ) {
    return NATIVE_MESSAGE_CLASS.BLOB_FILE_PREPARATION
  }
  if (message.indexOf('Connection to Indexed Database server lost') !== -1) {
    return NATIVE_MESSAGE_CLASS.IDB_SERVER_CONNECTION_LOST
  }
  if (message.indexOf('An internal error was encountered in the Indexed Database server') !== -1) {
    return NATIVE_MESSAGE_CLASS.IDB_INTERNAL_SERVER_ERROR
  }
  if (message.indexOf('without an in-progress transaction') !== -1) {
    return NATIVE_MESSAGE_CLASS.NO_IN_PROGRESS_TRANSACTION
  }
  return NATIVE_MESSAGE_CLASS.OTHER_UNKNOWN_ERROR
}

function readIndexField(record, field) {
  try {
    if (record === null || typeof record !== 'object') {
      return null
    }
    const value = record[field]
    if (typeof value !== 'string') {
      return null
    }
    return value
  } catch (_error) {
    return null
  }
}

function indexedStatusSnapshot(record) {
  const status = readIndexField(record, 'status')
  if (!isPhotoUploadStatus(status)) {
    return UNDETERMINED_INDEX_DIAGNOSTIC
  }
  return status
}

function actorStatusIndexChanged(current, next) {
  let changed = false
  for (const field of ACTOR_STATUS_INDEX_FIELDS) {
    const before = readIndexField(current, field)
    const after = readIndexField(next, field)
    if (before === null || after === null) {
      return UNDETERMINED_INDEX_DIAGNOSTIC
    }
    if (before !== after) {
      changed = true
    }
  }
  return changed
}

function traceNativeError(event, queueId, error, indexRecords) {
  try {
    const data = {
      queue_fragment: abbreviateQueueId(queueId),
      error_class: nativeErrorClass(error),
      reason: nativeErrorReason(error),
      message_class: classifyNativeErrorMessage(error),
    }
    if (indexRecords) {
      data.status_before = indexedStatusSnapshot(indexRecords.current)
      data.status_after = indexedStatusSnapshot(indexRecords.next)
      data.actor_status_index_changed = actorStatusIndexChanged(indexRecords.current, indexRecords.next)
    }
    trace(event, data)
  } catch (_error) {
    return
  }
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

function validateRecord(record, options = {}) {
  const requireBlob = options.requireBlob !== false
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
  } else if (requireBlob && !(record.blob instanceof Blob)) {
    throw invalidRecord('blob must be retained as a Blob until DONE cleanup')
  } else if (record.blob != null && !(record.blob instanceof Blob)) {
    throw invalidRecord('blob must be a Blob or null')
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

function queueStoreNames(database, transaction) {
  if (!database.objectStoreNames.contains(PHOTO_UPLOAD_QUEUE_STORE)) {
    const store = database.createObjectStore(PHOTO_UPLOAD_QUEUE_STORE, {
      keyPath: 'queue_id',
    })
    store.createIndex('by_actor', ['actor_scope_type', 'actor_scope_id'])
    store.createIndex('by_actor_status', ['actor_scope_type', 'actor_scope_id', 'status'])
    return
  }
  if (transaction && typeof transaction.objectStore === 'function') {
    transaction.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
  }
}

function upgradePhotoUploadDb(database, _oldVersion, _newVersion, transaction) {
  queueStoreNames(database, transaction)
  if (!database.objectStoreNames.contains(PHOTO_UPLOAD_PAYLOAD_STORE)) {
    const payloads = database.createObjectStore(PHOTO_UPLOAD_PAYLOAD_STORE, {
      keyPath: 'payload_id',
    })
    payloads.createIndex('by_queue', 'queue_id', { unique: true })
    payloads.createIndex('by_actor', ['actor_scope_type', 'actor_scope_id'])
  }
}

function abortTransaction(tx) {
  try {
    if (tx && typeof tx.abort === 'function') {
      tx.abort()
    }
  } catch (_error) {
    return
  }
}

function abortAndSettle(tx) {
  abortTransaction(tx)
  try {
    const done = tx && tx.done
    if (done && typeof done.then === 'function') {
      done.then(() => {}, () => {})
    }
  } catch (_error) {
    return
  }
}

function bytesEqual(left, right) {
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

function createPayloadToken() {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    let token = ''
    for (let index = 0; index < bytes.length; index += 1) {
      token += bytes[index].toString(16).padStart(2, '0')
    }
    return token
  }
  return `payload-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

async function readBlobSlice(blob, start, end) {
  const slice = blob.slice(start, end)
  return new Uint8Array(await slice.arrayBuffer())
}

async function blobsEqualChunked(left, right) {
  if (!(left instanceof Blob) || !(right instanceof Blob)) {
    return false
  }
  if (left.size !== right.size || left.type !== right.type) {
    return false
  }
  let offset = 0
  while (offset < left.size) {
    const end = Math.min(left.size, offset + PAYLOAD_VERIFY_CHUNK_BYTES)
    const leftChunk = await readBlobSlice(left, offset, end)
    const rightChunk = await readBlobSlice(right, offset, end)
    if (!bytesEqual(leftChunk, rightChunk)) {
      return false
    }
    offset = end
  }
  return true
}

function buildPayload(record, blob) {
  return {
    payload_id: record.queue_id,
    queue_id: record.queue_id,
    actor_scope_type: record.actor_scope_type,
    actor_scope_id: record.actor_scope_id,
    blob,
    size_bytes: blob.size,
    mime_type: blob.type || record.mime_type,
    created_at: Number.isInteger(record.created_at) ? record.created_at : 0,
  }
}

function toStoredQueueRecord(record, payloadId) {
  const stored = copyRecord(record)
  delete stored.blob
  stored.payload_id = payloadId
  return stored
}

function toPublicRecord(stored, blob) {
  const source = {}
  for (const field of PHOTO_UPLOAD_RECORD_FIELDS) {
    source[field] = field === 'blob' ? (blob === undefined ? null : blob) : stored[field]
  }
  return copyRecord(source)
}

function isLegacyInlineBlob(row) {
  return Boolean(row && row.blob instanceof Blob && (row.payload_id == null || row.payload_id === ''))
}

async function readOwnedPayload(payloadStore, row) {
  if (!row || typeof row.payload_id !== 'string' || row.payload_id.length === 0) {
    return null
  }
  const payload = await payloadStore.get(row.payload_id)
  if (!payload || !sameActor(payload, row.actor_scope_type, row.actor_scope_id)) {
    return null
  }
  return payload
}

function separatedPayloadId(row) {
  if (!row || isLegacyInlineBlob(row)) {
    return null
  }
  if (typeof row.payload_id === 'string' && row.payload_id.length > 0) {
    return row.payload_id
  }
  return null
}

function legacySnapshot(row) {
  return {
    queue_id: row.queue_id,
    actor_scope_type: row.actor_scope_type,
    actor_scope_id: row.actor_scope_id,
    status: row.status,
    updated_at: row.updated_at,
    lease_generation: row.lease_generation,
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
  }
}

function sameLegacySnapshot(row, snapshot) {
  return Boolean(
    row
    && row.queue_id === snapshot.queue_id
    && row.actor_scope_type === snapshot.actor_scope_type
    && row.actor_scope_id === snapshot.actor_scope_id
    && row.status === snapshot.status
    && row.updated_at === snapshot.updated_at
    && row.lease_generation === snapshot.lease_generation
    && row.lease_owner === snapshot.lease_owner
    && row.lease_expires_at === snapshot.lease_expires_at
    && row.blob instanceof Blob
  )
}

function isCleanedDone(row) {
  return Boolean(
    row
    && row.status === PHOTO_UPLOAD_STATUSES.DONE
    && (row.payload_id == null || row.payload_id === '')
    && !(row.blob instanceof Blob)
  )
}

async function putPayloadBytes(payloadStore, record, blob) {
  const payloadId = record.queue_id
  const existing = await payloadStore.get(payloadId)
  if (existing && !sameActor(existing, record.actor_scope_type, record.actor_scope_id)) {
    throw actorConflict('payload is owned by a different actor')
  }
  await payloadStore.put(buildPayload(record, blob))
  return payloadId
}

function payloadIdentityMatches(snapshot, original, payload) {
  if (!payload || !(payload.blob instanceof Blob) || !(original instanceof Blob)) {
    return false
  }
  return payload.payload_id === snapshot.queue_id
    && payload.queue_id === snapshot.queue_id
    && payload.actor_scope_type === snapshot.actor_scope_type
    && payload.actor_scope_id === snapshot.actor_scope_id
    && payload.blob.size === original.size
    && payload.blob.type === original.type
}

export function createPhotoUploadDb(options = {}) {
  const dbName = options.dbName || PHOTO_UPLOAD_DB_NAME
  const actor = {
    actorScopeType: options.actorScopeType || null,
    actorScopeId: options.actorScopeId || null,
  }
  const open = options.openDB || idbOpenDB

  function operationActorAllowed(actorScopeType, actorScopeId) {
    if (!actor.actorScopeType || !actor.actorScopeId) {
      return true
    }
    return actor.actorScopeType === actorScopeType && actor.actorScopeId === actorScopeId
  }

  function legacyRowAllowed(row) {
    if (!actor.actorScopeType || !actor.actorScopeId) {
      return true
    }
    return Boolean(row)
      && row.actor_scope_type === actor.actorScopeType
      && row.actor_scope_id === actor.actorScopeId
  }
  const afterLegacyPayloadCommit = options.afterLegacyPayloadCommit
  const beforeLegacyPromote = options.beforeLegacyPromote
  let dbPromise = null
  let closed = false
  let connectionToken = 0
  const legacyRetryAt = new Map()

  function forgetConnection(token) {
    if (token === connectionToken) {
      dbPromise = null
    }
  }

  async function getDb() {
    if (closed) {
      throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'PHOTO_UPLOAD_DB_CLOSED')
    }
    if (!dbPromise) {
      assertProductionDatabaseOpen(dbName, actor)
      const token = connectionToken + 1
      connectionToken = token
      let openedDb = null
      const pending = Promise.resolve()
        .then(() => withProductionOpenContext(actor, () => open(dbName, PHOTO_UPLOAD_DB_VERSION, {
          upgrade: upgradePhotoUploadDb,
          blocked() {
            return undefined
          },
          blocking() {
            forgetConnection(token)
            if (openedDb && typeof openedDb.close === 'function') {
              try {
                openedDb.close()
              } catch (_error) {
                return
              }
            }
          },
          terminated() {
            forgetConnection(token)
          },
        })))
        .then((db) => {
          openedDb = db
          if (closed || token !== connectionToken) {
            if (db && typeof db.close === 'function') {
              db.close()
            }
            throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'PHOTO_UPLOAD_DB_CLOSED')
          }
          return db
        })
        .catch((error) => {
          forgetConnection(token)
          throw wrapDatabaseError(error)
        })
      dbPromise = pending
    }
    return dbPromise
  }

  async function reopenDb() {
    const pending = dbPromise
    connectionToken += 1
    dbPromise = null
    if (!pending) {
      return
    }
    try {
      const database = await pending
      if (database && typeof database.close === 'function') {
        database.close()
      }
    } catch (_error) {
      return
    }
  }

  async function withQueueAndPayload(fn) {
    const db = await getDb()
    const tx = db.transaction(
      [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
      'readwrite'
    )
    const queueStore = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
    const payloadStore = tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE)
    try {
      const result = await fn(tx, queueStore, payloadStore)
      await tx.done
      return result
    } catch (error) {
      abortAndSettle(tx)
      throw error
    }
  }

  async function hydrate(payloadStore, stored) {
    if (!stored) {
      return null
    }
    if (stored.blob instanceof Blob) {
      return toPublicRecord(stored, stored.blob)
    }
    const payload = await readOwnedPayload(payloadStore, stored)
    const blob = payload && payload.blob instanceof Blob ? payload.blob : null
    return toPublicRecord(stored, blob)
  }

  async function stageLegacyPayload(queueId) {
    const db = await getDb()
    const tx = db.transaction(
      [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
      'readwrite'
    )
    const queueStore = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
    const payloadStore = tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE)
    try {
      const row = await queueStore.get(queueId)
      if (!row) {
        await tx.done
        return { state: 'absent' }
      }
      if (!isLegacyInlineBlob(row)) {
        await tx.done
        return { state: 'current' }
      }
      const snapshot = legacySnapshot(row)
      const original = row.blob
      const existing = await payloadStore.get(queueId)
      if (existing && !sameActor(existing, row.actor_scope_type, row.actor_scope_id)) {
        throw actorConflict('payload is owned by a different actor')
      }
      const prepared = Boolean(
        existing
        && typeof existing.payload_token === 'string'
        && existing.payload_token.length > 0
        && existing.blob instanceof Blob
        && existing.blob.size === original.size
        && existing.blob.type === original.type
      )
      if (prepared) {
        const payloadToken = existing.payload_token
        await tx.done
        return { state: 'staged', snapshot, original, payloadToken }
      }
      const payloadToken = createPayloadToken()
      const payload = buildPayload(row, original)
      payload.payload_token = payloadToken
      await payloadStore.put(payload)
      await tx.done
      return { state: 'staged', snapshot, original, payloadToken }
    } catch (error) {
      abortAndSettle(tx)
      throw error
    }
  }

  async function readCommittedPayload(queueId) {
    const db = await getDb()
    const tx = db.transaction(PHOTO_UPLOAD_PAYLOAD_STORE, 'readonly')
    try {
      const payload = await tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).get(queueId)
      await tx.done
      return payload || null
    } catch (error) {
      abortAndSettle(tx)
      throw error
    }
  }

  async function readQueueRow(queueId) {
    const db = await getDb()
    const tx = db.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readonly')
    try {
      const row = await tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).get(queueId)
      await tx.done
      return row || null
    } catch (error) {
      abortAndSettle(tx)
      throw error
    }
  }

  function peerPromoted(row, snapshot) {
    return Boolean(
      row
      && row.queue_id === snapshot.queue_id
      && row.actor_scope_type === snapshot.actor_scope_type
      && row.actor_scope_id === snapshot.actor_scope_id
      && !(row.blob instanceof Blob)
      && row.payload_id === snapshot.queue_id
    )
  }

  async function verifyStaged(staged) {
    const recovered = await readCommittedPayload(staged.snapshot.queue_id)
    if (!recovered || recovered.payload_token !== staged.payloadToken) {
      return 'rejected'
    }
    if (!payloadIdentityMatches(staged.snapshot, staged.original, recovered)) {
      return 'rejected'
    }
    const payloadMatches = await blobsEqualChunked(staged.original, recovered.blob)
    const inline = await readQueueRow(staged.snapshot.queue_id)
    if (peerPromoted(inline, staged.snapshot)) {
      return payloadMatches ? 'ok' : 'rejected'
    }
    if (!sameLegacySnapshot(inline, staged.snapshot)) {
      return 'rejected'
    }
    const inlineMatches = await blobsEqualChunked(staged.original, inline.blob)
    if (payloadMatches && inlineMatches) {
      return 'ok'
    }
    if (!payloadMatches && inlineMatches) {
      return 'payload-mismatch'
    }
    return 'rejected'
  }

  async function restageMismatched(staged) {
    const db = await getDb()
    const tx = db.transaction(
      [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
      'readwrite'
    )
    const queueStore = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
    const payloadStore = tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE)
    try {
      const row = await queueStore.get(staged.snapshot.queue_id)
      const payload = await payloadStore.get(staged.snapshot.queue_id)
      if (!sameLegacySnapshot(row, staged.snapshot) || !payload || payload.payload_token !== staged.payloadToken) {
        await tx.done
        return
      }
      if (!sameActor(payload, staged.snapshot.actor_scope_type, staged.snapshot.actor_scope_id)) {
        await tx.done
        return
      }
      const replacement = buildPayload(row, row.blob)
      replacement.payload_token = createPayloadToken()
      await payloadStore.put(replacement)
      await tx.done
    } catch (error) {
      abortAndSettle(tx)
      throw error
    }
  }

  async function promoteUnchangedLegacy(snapshot, payloadToken, original) {
    const db = await getDb()
    const tx = db.transaction(
      [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
      'readwrite'
    )
    const queueStore = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
    const payloadStore = tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE)
    try {
      const row = await queueStore.get(snapshot.queue_id)
      const payload = await payloadStore.get(snapshot.queue_id)
      const tokenOk = Boolean(payload && payload.payload_token === payloadToken)
      if (sameLegacySnapshot(row, snapshot) && tokenOk && payloadIdentityMatches(snapshot, row.blob, payload)) {
        const bound = buildPayload(row, original)
        bound.payload_token = payloadToken
        await payloadStore.put(bound)
        await queueStore.put(toStoredQueueRecord(toPublicRecord(row, null), snapshot.queue_id))
        await tx.done
        return true
      }
      const payloadBlob = payload && payload.blob instanceof Blob ? payload.blob : null
      const observed = peerPromoted(row, snapshot) && tokenOk && payloadIdentityMatches(snapshot, original, payload)
      await tx.done
      if (!observed || !payloadBlob) {
        return false
      }
      return blobsEqualChunked(original, payloadBlob)
    } catch (error) {
      abortAndSettle(tx)
      throw error
    }
  }

  async function promoteLegacyRecord(queueId) {
    const staged = await stageLegacyPayload(queueId)
    if (staged.state === 'absent' || staged.state === 'current') {
      return true
    }
    try {
      if (typeof afterLegacyPayloadCommit === 'function') {
        await afterLegacyPayloadCommit({ queueId: staged.snapshot.queue_id })
      }
      await reopenDb()
      const verified = await verifyStaged(staged)
      if (verified === 'payload-mismatch') {
        await restageMismatched(staged)
      }
      if (verified !== 'ok') {
        return false
      }
      if (typeof beforeLegacyPromote === 'function') {
        await beforeLegacyPromote({
          queueId: staged.snapshot.queue_id,
          payloadToken: staged.payloadToken,
        })
      }
      await reopenDb()
      const confirmed = await verifyStaged(staged)
      if (confirmed === 'payload-mismatch') {
        await restageMismatched(staged)
      }
      if (confirmed !== 'ok') {
        return false
      }
      return await promoteUnchangedLegacy(staged.snapshot, staged.payloadToken, staged.original)
    } catch (_error) {
      return false
    }
  }

  return {
    async putRecord(record) {
      const incomingBlob = record && record.blob instanceof Blob ? record.blob : null
      const preserveBytes = !incomingBlob && record && record.status !== PHOTO_UPLOAD_STATUSES.DONE
      const validated = validateRecord(record, { requireBlob: !preserveBytes && !(record && record.status === PHOTO_UPLOAD_STATUSES.DONE && record.blob == null) })
      if (!operationActorAllowed(validated.actor_scope_type, validated.actor_scope_id)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      try {
        if (preserveBytes) {
          const owner = await withQueueAndPayload(async (_tx, queueStore) => queueStore.get(validated.queue_id))
          if (owner && !sameActor(owner, validated.actor_scope_type, validated.actor_scope_id)) {
            throw actorConflict('queue_id is owned by a different actor')
          }
          const promoted = await promoteLegacyRecord(validated.queue_id)
          if (!promoted) {
            throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'PAYLOAD_COPY_MISMATCH')
          }
        }
        await withQueueAndPayload(async (_tx, queueStore, payloadStore) => {
          const existing = await queueStore.get(validated.queue_id)
          if (existing && !sameActor(existing, validated.actor_scope_type, validated.actor_scope_id)) {
            throw actorConflict('queue_id is owned by a different actor')
          }
          if (isCleanedDone(existing) && incomingBlob) {
            throw blobCleanupForbidden('DONE cleanup cannot be reversed')
          }
          let payloadId = existing && typeof existing.payload_id === 'string' ? existing.payload_id : null
          if (isCleanedDone(existing)) {
            payloadId = null
          } else if (incomingBlob) {
            payloadId = await putPayloadBytes(payloadStore, validated, incomingBlob)
          } else if (existing && isLegacyInlineBlob(existing)) {
            throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'LEGACY_RECORD_UNPROMOTED')
          } else if (preserveBytes) {
            const payload = await readOwnedPayload(payloadStore, existing || {})
            if (!payload) {
              throw invalidRecord('blob must be retained as a Blob until DONE cleanup')
            }
            payloadId = payload.payload_id
          } else if (validated.status === PHOTO_UPLOAD_STATUSES.DONE && validated.blob == null) {
            if (payloadId) {
              const payload = await payloadStore.get(payloadId)
              if (payload && !sameActor(payload, validated.actor_scope_type, validated.actor_scope_id)) {
                throw actorConflict('payload is owned by a different actor')
              }
              await payloadStore.delete(payloadId)
            }
            payloadId = null
          }
          await queueStore.put(toStoredQueueRecord(validated, payloadId))
        })
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async getRecord({ queueId, actorScopeType, actorScopeId }) {
      if (!isNonEmptyString(queueId)) {
        throw invalidRecord('queueId must be a non-empty string')
      }
      requireActorScope(actorScopeType, actorScopeId)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      const db = await getDb()
      const tx = db.transaction(
        [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
        'readonly'
      )
      try {
        const record = await tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).get(queueId)
        if (!record || !sameActor(record, actorScopeType, actorScopeId)) {
          await tx.done
          return null
        }
        const publicRecord = await hydrate(tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE), record)
        await tx.done
        return publicRecord
      } catch (error) {
        abortAndSettle(tx)
        throw wrapDatabaseError(error)
      }
    },

    async listRecordsForActor({ actorScopeType, actorScopeId }) {
      requireActorScope(actorScopeType, actorScopeId)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      const db = await getDb()
      try {
        const rows = await db.getAllFromIndex(
          PHOTO_UPLOAD_QUEUE_STORE,
          'by_actor',
          [actorScopeType, actorScopeId]
        )
        return rows.map((row) => toPublicRecord(row, null))
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async listRecordsForActorByStatus({ actorScopeType, actorScopeId, status }) {
      requireActorScope(actorScopeType, actorScopeId)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      if (!isPhotoUploadStatus(status)) {
        throw invalidRecord('status is not a frozen photo upload status')
      }
      const db = await getDb()
      try {
        const rows = await db.getAllFromIndex(
          PHOTO_UPLOAD_QUEUE_STORE,
          'by_actor_status',
          [actorScopeType, actorScopeId, status]
        )
        return rows.map((row) => toPublicRecord(row, null))
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async hasRetainedPayloadForActor({ actorScopeType, actorScopeId }) {
      requireActorScope(actorScopeType, actorScopeId)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      const db = await getDb()
      try {
        const rows = await db.getAllFromIndex(
          PHOTO_UPLOAD_QUEUE_STORE,
          'by_actor',
          [actorScopeType, actorScopeId]
        )
        return rows.some((row) => (
          (typeof row.payload_id === 'string' && row.payload_id.length > 0)
          || row.blob instanceof Blob
        ))
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async getPayloadForUpload({ queueId, actorScopeType, actorScopeId }) {
      if (!isNonEmptyString(queueId)) {
        throw invalidRecord('queueId must be a non-empty string')
      }
      requireActorScope(actorScopeType, actorScopeId)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      const db = await getDb()
      const tx = db.transaction(
        [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
        'readonly'
      )
      try {
        const record = await tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE).get(queueId)
        if (!record || !sameActor(record, actorScopeType, actorScopeId)) {
          await tx.done
          return null
        }
        if (record.blob instanceof Blob || !record.payload_id) {
          await tx.done
          throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'PAYLOAD_UNAVAILABLE')
        }
        const payload = await tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE).get(record.payload_id)
        await tx.done
        const compatible = Boolean(
          payload
          && payload.payload_id === record.payload_id
          && payload.queue_id === record.queue_id
          && sameActor(payload, actorScopeType, actorScopeId)
          && payload.blob instanceof Blob
          && payload.blob.size === record.file_size
          && payload.blob.type === record.mime_type
        )
        if (!compatible) {
          throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'PAYLOAD_UNAVAILABLE')
        }
        return {
          payload_id: payload.payload_id,
          queue_id: payload.queue_id,
          blob: payload.blob,
          size_bytes: payload.blob.size,
          mime_type: payload.blob.type,
        }
      } catch (error) {
        abortAndSettle(tx)
        throw wrapDatabaseError(error)
      }
    },

    async deleteLocalRecord({ queueId, actorScopeType, actorScopeId }) {
      if (!isNonEmptyString(queueId)) {
        throw invalidRecord('queueId must be a non-empty string')
      }
      requireActorScope(actorScopeType, actorScopeId)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      try {
        await withQueueAndPayload(async (_tx, queueStore, payloadStore) => {
          const existing = await queueStore.get(queueId)
          if (!existing) {
            return
          }
          if (!sameActor(existing, actorScopeType, actorScopeId)) {
            throw actorConflict('cannot delete a record owned by a different actor')
          }
          const payloadId = typeof existing.payload_id === 'string' && existing.payload_id.length > 0
            ? existing.payload_id
            : queueId
          const payload = await payloadStore.get(payloadId)
          if (payload && !sameActor(payload, actorScopeType, actorScopeId)) {
            throw actorConflict('cannot delete a payload owned by a different actor')
          }
          if (payload) {
            await payloadStore.delete(payloadId)
          }
          await queueStore.delete(queueId)
        })
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async clearDoneBlob({ queueId, actorScopeType, actorScopeId, updatedAt }) {
      if (!isNonEmptyString(queueId)) {
        throw invalidRecord('queueId must be a non-empty string')
      }
      requireActorScope(actorScopeType, actorScopeId)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      if (!isNonNegativeInteger(updatedAt)) {
        throw invalidRecord('updatedAt must be epoch milliseconds')
      }
      try {
        await withQueueAndPayload(async (_tx, queueStore, payloadStore) => {
          const existing = await queueStore.get(queueId)
          if (!existing) {
            throw invalidRecord('record not found')
          }
          if (!sameActor(existing, actorScopeType, actorScopeId)) {
            throw actorConflict('cannot clear a blob owned by a different actor')
          }
          if (existing.status !== PHOTO_UPLOAD_STATUSES.DONE) {
            throw blobCleanupForbidden('Blob cleanup is allowed only for DONE records')
          }
          const payloadId = typeof existing.payload_id === 'string' && existing.payload_id.length > 0
            ? existing.payload_id
            : (existing.blob instanceof Blob ? queueId : null)
          if (payloadId) {
            const payload = await payloadStore.get(payloadId)
            if (payload && !sameActor(payload, actorScopeType, actorScopeId)) {
              throw actorConflict('cannot clear a payload owned by a different actor')
            }
            if (payload || existing.blob instanceof Blob) {
              if (payload) {
                await payloadStore.delete(payloadId)
              }
            }
          }
          const updated = toStoredQueueRecord(toPublicRecord(existing, null), null)
          updated.updated_at = updatedAt
          await queueStore.put(updated)
        })
      } catch (error) {
        throw wrapDatabaseError(error)
      }
    },

    async claimLease({
      queueId,
      actorScopeType,
      actorScopeId,
      leaseOwner,
      now,
      leaseTtlMs,
    }) {
      requireQueueId(queueId)
      requireActorScope(actorScopeType, actorScopeId)
      requireLeaseOwner(leaseOwner)
      requireNow(now)
      requireLeaseTtlMs(leaseTtlMs)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      const db = await getDb()
      const tx = db.transaction(
        [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
        'readwrite'
      )
      const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
      const payloadStore = tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE)
      try {
        let existing
        try {
          existing = await store.get(queueId)
        } catch (error) {
          traceNativeError('IDB_CLAIM_GET_ERROR', queueId, error)
          throw error
        }
        if (!existing) {
          await tx.done
          throw invalidRecord('record not found')
        }
        if (!sameActor(existing, actorScopeType, actorScopeId)) {
          await tx.done
          throw actorConflict('cannot claim a lease owned by a different actor')
        }

        const noOwner = existing.lease_owner === null
        const expired = isLeaseExpired(existing, now)
        const sameOwner = existing.lease_owner === leaseOwner
        const payloadId = separatedPayloadId(existing)
        if (isLegacyInlineBlob(existing)) {
          throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'LEGACY_RECORD_UNPROMOTED')
        }
        const next = toStoredQueueRecord(toPublicRecord(existing, null), payloadId)

        if (noOwner || expired) {
          next.lease_owner = leaseOwner
          next.lease_generation = existing.lease_generation + 1
          next.lease_expires_at = now + leaseTtlMs
        } else if (sameOwner) {
          next.lease_expires_at = now + leaseTtlMs
        } else {
          await tx.done
          throw leaseNotAvailable('lease is held by a different owner')
        }

        try {
          await store.put(next)
        } catch (error) {
          traceNativeError('IDB_CLAIM_PUT_ERROR', queueId, error)
          throw error
        }
        let publicRecord
        try {
          publicRecord = await hydrate(payloadStore, next)
        } catch (error) {
          traceNativeError('IDB_CLAIM_GET_ERROR', queueId, error)
          throw error
        }
        try {
          await tx.done
        } catch (error) {
          traceNativeError('IDB_CLAIM_TX_DONE_ERROR', queueId, error)
          throw error
        }
        return publicRecord
      } catch (error) {
        abortAndSettle(tx)
        throw wrapDatabaseError(error)
      }
    },

    async heartbeatLease({
      queueId,
      actorScopeType,
      actorScopeId,
      leaseOwner,
      leaseGeneration,
      now,
      leaseTtlMs,
    }) {
      requireQueueId(queueId)
      requireActorScope(actorScopeType, actorScopeId)
      requireLeaseOwner(leaseOwner)
      requireLeaseGeneration(leaseGeneration)
      requireNow(now)
      requireLeaseTtlMs(leaseTtlMs)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      const db = await getDb()
      const tx = db.transaction(
        [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
        'readwrite'
      )
      const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
      const payloadStore = tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE)
      try {
        const existing = await store.get(queueId)
        if (!existing) {
          await tx.done
          throw invalidRecord('record not found')
        }
        if (!sameActor(existing, actorScopeType, actorScopeId)) {
          await tx.done
          throw actorConflict('cannot heartbeat a lease owned by a different actor')
        }
        if (existing.lease_owner !== leaseOwner || existing.lease_generation !== leaseGeneration) {
          await tx.done
          throw leaseFenceConflict('LEASE_FENCE_CONFLICT')
        }
        if (isLegacyInlineBlob(existing)) {
          throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'LEGACY_RECORD_UNPROMOTED')
        }
        const payloadId = separatedPayloadId(existing)
        const next = toStoredQueueRecord(toPublicRecord(existing, null), payloadId)
        next.lease_expires_at = now + leaseTtlMs
        await store.put(next)
        const publicRecord = await hydrate(payloadStore, next)
        await tx.done
        return publicRecord
      } catch (error) {
        abortAndSettle(tx)
        throw wrapDatabaseError(error)
      }
    },

    async releaseLease({
      queueId,
      actorScopeType,
      actorScopeId,
      leaseOwner,
      leaseGeneration,
    }) {
      requireQueueId(queueId)
      requireActorScope(actorScopeType, actorScopeId)
      requireLeaseOwner(leaseOwner)
      requireLeaseGeneration(leaseGeneration)
      if (!operationActorAllowed(actorScopeType, actorScopeId)) {
        throw actorConflict('operation is outside the authorized actor')
      }
      const db = await getDb()
      const tx = db.transaction(
        [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
        'readwrite'
      )
      const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
      const payloadStore = tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE)
      try {
        const existing = await store.get(queueId)
        if (!existing) {
          await tx.done
          throw invalidRecord('record not found')
        }
        if (!sameActor(existing, actorScopeType, actorScopeId)) {
          await tx.done
          throw actorConflict('cannot release a lease owned by a different actor')
        }
        if (existing.lease_owner !== leaseOwner || existing.lease_generation !== leaseGeneration) {
          await tx.done
          throw leaseFenceConflict('LEASE_FENCE_CONFLICT')
        }
        if (isLegacyInlineBlob(existing)) {
          throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'LEGACY_RECORD_UNPROMOTED')
        }
        const payloadId = separatedPayloadId(existing)
        const next = toStoredQueueRecord(toPublicRecord(existing, null), payloadId)
        next.lease_owner = null
        next.lease_expires_at = null
        await store.put(next)
        const publicRecord = await hydrate(payloadStore, next)
        await tx.done
        return publicRecord
      } catch (error) {
        abortAndSettle(tx)
        throw wrapDatabaseError(error)
      }
    },

    async putRecordFenced({ record, leaseOwner, leaseGeneration }) {
      requireLeaseOwner(leaseOwner)
      requireLeaseGeneration(leaseGeneration)
      const db = await getDb()
      const tx = db.transaction(
        [PHOTO_UPLOAD_QUEUE_STORE, PHOTO_UPLOAD_PAYLOAD_STORE],
        'readwrite'
      )
      const store = tx.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
      const payloadStore = tx.objectStore(PHOTO_UPLOAD_PAYLOAD_STORE)
      try {
        let validated
        try {
          validated = validateRecord(record, { requireBlob: false })
        } catch (error) {
          await tx.done
          throw error
        }
        if (!operationActorAllowed(validated.actor_scope_type, validated.actor_scope_id)) {
          await tx.done
          throw actorConflict('operation is outside the authorized actor')
        }
        let current
        try {
          current = await store.get(validated.queue_id)
        } catch (error) {
          traceNativeError('IDB_FENCED_GET_ERROR', validated.queue_id, error)
          throw error
        }
        if (!current) {
          await tx.done
          throw invalidRecord('record not found')
        }
        if (!sameActor(current, validated.actor_scope_type, validated.actor_scope_id)) {
          await tx.done
          throw actorConflict('cannot write a record owned by a different actor')
        }
        if (current.lease_owner !== leaseOwner || current.lease_generation !== leaseGeneration) {
          await tx.done
          throw leaseFenceConflict('LEASE_FENCE_CONFLICT')
        }
        if (isLegacyInlineBlob(current)) {
          throw new PhotoUploadDbError(PHOTO_UPLOAD_DB_ERROR_CODES.DATABASE_ERROR, 'LEGACY_RECORD_UNPROMOTED')
        }
        const cleaned = current.payload_id == null && !(current.blob instanceof Blob)
        const payloadId = cleaned ? null : separatedPayloadId(current)
        const next = toStoredQueueRecord(validated, payloadId)
        next.lease_owner = current.lease_owner
        next.lease_generation = current.lease_generation
        next.lease_expires_at = current.lease_expires_at
        try {
          await store.put(next)
        } catch (error) {
          traceNativeError('IDB_FENCED_PUT_ERROR', validated.queue_id, error, {
            current,
            next,
          })
          throw error
        }
        let publicRecord
        try {
          publicRecord = await hydrate(payloadStore, next)
        } catch (error) {
          traceNativeError('IDB_FENCED_GET_ERROR', validated.queue_id, error)
          throw error
        }
        try {
          await tx.done
        } catch (error) {
          traceNativeError('IDB_FENCED_TX_DONE_ERROR', validated.queue_id, error)
          throw error
        }
        return publicRecord
      } catch (error) {
        abortAndSettle(tx)
        throw wrapDatabaseError(error)
      }
    },

    async migrateNextLegacyRecord() {
      const db = await getDb()
      const scan = db.transaction(PHOTO_UPLOAD_QUEUE_STORE, 'readonly')
      const scanStore = scan.objectStore(PHOTO_UPLOAD_QUEUE_STORE)
      let queueId = null
      try {
        let cursor = await scanStore.openCursor()
        const nowMs = Date.now()
        while (cursor) {
          const row = cursor.value
          const retryAt = row && legacyRetryAt.get(row.queue_id)
          if (row && row.blob instanceof Blob && legacyRowAllowed(row) && (!retryAt || retryAt <= nowMs)) {
            queueId = row.queue_id
            break
          }
          cursor = await cursor.continue()
        }
        await scan.done
      } catch (error) {
        abortAndSettle(scan)
        throw wrapDatabaseError(error)
      }
      if (!queueId) {
        return { migrated: false }
      }
      try {
        const promoted = await promoteLegacyRecord(queueId)
        if (!promoted) {
          legacyRetryAt.set(queueId, Date.now() + LEGACY_MIGRATION_RETRY_MS)
          return { migrated: false, deferred: true, queueId }
        }
        legacyRetryAt.delete(queueId)
        return { migrated: true, queueId }
      } catch (_error) {
        legacyRetryAt.set(queueId, Date.now() + LEGACY_MIGRATION_RETRY_MS)
        return { migrated: false, deferred: true, queueId }
      }
    },

    async close() {
      closed = true
      connectionToken += 1
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

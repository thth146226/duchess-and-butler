import { supabase as applicationSupabaseClient } from './supabase'

export const PHOTO_UPLOAD_STORAGE_BUCKET = 'evidence-photos'
export const PHOTO_UPLOAD_EVIDENCE_TABLE = 'evidence_photos'

export const SERVER_SIDE_IDEMPOTENCY_GUARANTEE = false
export const SERVER_SIDE_IDEMPOTENCY_GATE_REQUIRED = true

export const PHOTO_UPLOAD_REMOTE_PROOF_SOURCES = Object.freeze({
  STORAGE_INFO: 'STORAGE_INFO',
  PUBLIC_GET: 'PUBLIC_GET',
})

export const PHOTO_UPLOAD_RECONCILER_RESULT_KINDS = Object.freeze({
  REMOTE_COMPLETE: 'REMOTE_COMPLETE',
  REMOTE_INCOMPLETE: 'REMOTE_INCOMPLETE',
  DB_ROW_FOUND: 'DB_ROW_FOUND',
  DB_INSERT_SUCCEEDED: 'DB_INSERT_SUCCEEDED',
})

export const PHOTO_UPLOAD_RECONCILER_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  REMOTE_AUTH_OR_PERMISSION: 'REMOTE_AUTH_OR_PERMISSION',
  REMOTE_RETRYABLE: 'REMOTE_RETRYABLE',
  REMOTE_PERMANENT: 'REMOTE_PERMANENT',
  DB_AUTH_OR_PERMISSION: 'DB_AUTH_OR_PERMISSION',
  DB_RETRYABLE: 'DB_RETRYABLE',
  DB_PERMANENT: 'DB_PERMANENT',
  DB_MULTIPLE_ROWS: 'DB_MULTIPLE_ROWS',
  DB_INSERT_AMBIGUOUS: 'DB_INSERT_AMBIGUOUS',
})

export const PHOTO_UPLOAD_EVIDENCE_INSERT_FIELDS = Object.freeze([
  'order_id',
  'user_id',
  'run_type',
  'photo_url',
  'notes',
  'crms_ref',
  'event_name',
  'file_path',
  'driver_name',
  'uploaded_by_name',
  'job_table',
  'uploaded_by',
])

const ALLOWED_INSERT_FIELDS = new Set(PHOTO_UPLOAD_EVIDENCE_INSERT_FIELDS)

export class PhotoUploadReconcilerError extends Error {
  constructor(code, message, extras = {}) {
    super(message)
    this.name = 'PhotoUploadReconcilerError'
    this.code = code
    this.httpStatus = extras.httpStatus == null ? null : extras.httpStatus
    this.storagePath = extras.storagePath == null ? null : extras.storagePath
    this.postgresCode = extras.postgresCode == null ? null : extras.postgresCode
    if (extras.outcomeMayHaveCommitted === true) {
      this.outcomeMayHaveCommitted = true
    }
  }
}

function invalidInput(message, storagePath) {
  return new PhotoUploadReconcilerError(
    PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT,
    message,
    { storagePath: storagePath || null }
  )
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function extractHttpStatus(error) {
  if (!error || typeof error !== 'object') {
    return null
  }
  if (Number.isInteger(error.status)) {
    return error.status
  }
  if (Number.isInteger(error.statusCode)) {
    return error.statusCode
  }
  if (typeof error.statusCode === 'string' && /^\d+$/.test(error.statusCode)) {
    return Number(error.statusCode)
  }
  return null
}

function extractPostgresCode(error) {
  if (!error || typeof error.code !== 'string') {
    return null
  }
  if (/^[0-9A-Z]{5}$/.test(error.code)) {
    return error.code
  }
  return null
}

function extractRemoteSize(data) {
  if (!data || typeof data !== 'object') {
    return null
  }
  if (isNonNegativeInteger(data.size)) {
    return data.size
  }
  if (data.metadata && isNonNegativeInteger(data.metadata.size)) {
    return data.metadata.size
  }
  return null
}

function classifyStatus(status, authCode, retryableCode, permanentCode) {
  if (status === 401 || status === 403) {
    return authCode
  }
  if (status == null) {
    return retryableCode
  }
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
    return retryableCode
  }
  if (status >= 400 && status <= 499) {
    return permanentCode
  }
  return retryableCode
}

function remoteError(error, storagePath) {
  const httpStatus = extractHttpStatus(error)
  const code = classifyStatus(
    httpStatus,
    PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_AUTH_OR_PERMISSION,
    PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_RETRYABLE,
    PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_PERMANENT
  )
  return new PhotoUploadReconcilerError(code, code, { httpStatus, storagePath })
}

function dbError(error, storagePath, options = {}) {
  const httpStatus = extractHttpStatus(error)
  const postgresCode = extractPostgresCode(error)
  let code
  if (options.ambiguous) {
    code = PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_INSERT_AMBIGUOUS
  } else if (options.insertAttempt && postgresCode === '23505') {
    // PostgreSQL unique violation on the deterministic file_path means another worker committed
    // the same Storage path. Treat as ambiguous so the existing query-before-insert path can
    // reconcile the row on the next DB phase without re-uploading.
    code = PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_INSERT_AMBIGUOUS
  } else {
    code = classifyStatus(
      httpStatus,
      PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_AUTH_OR_PERMISSION,
      PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_RETRYABLE,
      PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_PERMANENT
    )
    if (options.insertAttempt && code === PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_RETRYABLE && httpStatus == null) {
      code = PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_INSERT_AMBIGUOUS
    }
  }
  return new PhotoUploadReconcilerError(code, code, {
    httpStatus,
    storagePath,
    postgresCode,
    outcomeMayHaveCommitted: code === PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_INSERT_AMBIGUOUS,
  })
}

function isNotFoundStatus(status) {
  return status === 404
}

function storageBucket(client) {
  return client.storage.from(PHOTO_UPLOAD_STORAGE_BUCKET)
}

function readPublicUrl(client, storagePath) {
  const result = storageBucket(client).getPublicUrl(storagePath)
  const publicUrl = result && result.data ? result.data.publicUrl : null
  if (!isNonEmptyString(publicUrl)) {
    return null
  }
  return publicUrl
}

function completeResult({ storagePath, expectedSize, actualSize, proofSource, publicUrl }) {
  return {
    kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.REMOTE_COMPLETE,
    storagePath,
    expectedSize,
    actualSize,
    proofSource,
    publicUrl,
  }
}

function incompleteResult({ storagePath, expectedSize, actualSize, proofSource }) {
  return {
    kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.REMOTE_INCOMPLETE,
    storagePath,
    expectedSize,
    actualSize,
    proofSource,
  }
}

async function proveViaPublicGet({ client, fetchFn, storagePath, expectedSize }) {
  const publicUrl = readPublicUrl(client, storagePath)
  if (!isNonEmptyString(publicUrl)) {
    throw remoteError({ status: 500 }, storagePath)
  }
  let response
  try {
    response = await fetchFn(publicUrl)
  } catch (error) {
    throw remoteError(error, storagePath)
  }
  const status = response && Number.isInteger(response.status) ? response.status : null
  if (status !== 200) {
    if (isNotFoundStatus(status)) {
      return incompleteResult({
        storagePath,
        expectedSize,
        actualSize: null,
        proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.PUBLIC_GET,
      })
    }
    throw remoteError({ status }, storagePath)
  }
  if (!response || typeof response.arrayBuffer !== 'function') {
    throw remoteError({ status: 500 }, storagePath)
  }
  const buffer = await response.arrayBuffer()
  const actualSize = buffer ? buffer.byteLength : null
  if (!isNonNegativeInteger(actualSize) || actualSize !== expectedSize) {
    return incompleteResult({
      storagePath,
      expectedSize,
      actualSize: isNonNegativeInteger(actualSize) ? actualSize : null,
      proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.PUBLIC_GET,
    })
  }
  return completeResult({
    storagePath,
    expectedSize,
    actualSize,
    proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.PUBLIC_GET,
    publicUrl,
  })
}

function validateInspectInput(input) {
  if (!input || typeof input !== 'object') {
    throw invalidInput('inspectRemoteObject input is required')
  }
  if (!isNonEmptyString(input.storagePath)) {
    throw invalidInput('storagePath must be a non-empty string')
  }
  if (!isNonNegativeInteger(input.expectedSize)) {
    throw invalidInput('expectedSize must be an integer >= 0', input.storagePath)
  }
}

function validateRowInput(input) {
  if (!input || typeof input !== 'object') {
    throw invalidInput('reconcileEvidencePhotoRow input is required')
  }
  if (!isNonEmptyString(input.storagePath)) {
    throw invalidInput('storagePath must be a non-empty string')
  }
  if (!isNonEmptyString(input.publicUrl)) {
    throw invalidInput('publicUrl must be a non-empty string', input.storagePath)
  }
  if (!isPlainObject(input.metadataPayload)) {
    throw invalidInput('metadataPayload must be a plain object', input.storagePath)
  }
}

function buildInsertPayload(storagePath, publicUrl, metadataPayload) {
  const payload = {}
  for (const key of Object.keys(metadataPayload)) {
    if (!ALLOWED_INSERT_FIELDS.has(key)) {
      throw invalidInput(`Unknown insert field: ${key}`, storagePath)
    }
    if (key === 'file_path' && metadataPayload.file_path !== storagePath) {
      throw invalidInput('metadataPayload.file_path must equal storagePath', storagePath)
    }
    if (key === 'photo_url' && metadataPayload.photo_url !== publicUrl) {
      throw invalidInput('metadataPayload.photo_url must equal publicUrl', storagePath)
    }
    payload[key] = metadataPayload[key]
  }
  payload.file_path = storagePath
  payload.photo_url = publicUrl
  return payload
}

function rowIdentity(row, storagePath) {
  return {
    id: row && row.id != null ? row.id : null,
    file_path: row && row.file_path != null ? row.file_path : storagePath,
    photo_url: row && row.photo_url != null ? row.photo_url : null,
  }
}

export function createPhotoUploadReconciler(options = {}) {
  const client = options.supabaseClient || applicationSupabaseClient
  const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch

  return {
    async inspectRemoteObject(input) {
      validateInspectInput(input)
      const storagePath = input.storagePath
      const expectedSize = input.expectedSize

      let infoResult
      try {
        infoResult = await storageBucket(client).info(storagePath)
      } catch (error) {
        throw remoteError(error, storagePath)
      }

      const infoError = infoResult && infoResult.error ? infoResult.error : null
      const infoData = infoResult ? infoResult.data : null
      if (infoError) {
        const status = extractHttpStatus(infoError)
        if (isNotFoundStatus(status)) {
          return incompleteResult({
            storagePath,
            expectedSize,
            actualSize: null,
            proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.STORAGE_INFO,
          })
        }
        throw remoteError(infoError, storagePath)
      }

      const actualSize = extractRemoteSize(infoData)
      if (isNonNegativeInteger(actualSize)) {
        if (actualSize !== expectedSize) {
          return incompleteResult({
            storagePath,
            expectedSize,
            actualSize,
            proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.STORAGE_INFO,
          })
        }
        const publicUrl = readPublicUrl(client, storagePath)
        if (!isNonEmptyString(publicUrl)) {
          throw remoteError({ status: 500 }, storagePath)
        }
        return completeResult({
          storagePath,
          expectedSize,
          actualSize,
          proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.STORAGE_INFO,
          publicUrl,
        })
      }

      return proveViaPublicGet({
        client,
        fetchFn,
        storagePath,
        expectedSize,
      })
    },

    async reconcileEvidencePhotoRow(input) {
      validateRowInput(input)
      const storagePath = input.storagePath
      const publicUrl = input.publicUrl
      const insertPayload = buildInsertPayload(storagePath, publicUrl, input.metadataPayload)

      let existing
      try {
        existing = await client
          .from(PHOTO_UPLOAD_EVIDENCE_TABLE)
          .select('id,file_path,photo_url')
          .eq('file_path', storagePath)
          .limit(2)
      } catch (error) {
        throw dbError(error, storagePath)
      }

      if (existing && existing.error) {
        throw dbError(existing.error, storagePath)
      }

      const rows = Array.isArray(existing && existing.data) ? existing.data : []
      if (rows.length >= 2) {
        throw new PhotoUploadReconcilerError(
          PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_MULTIPLE_ROWS,
          PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_MULTIPLE_ROWS,
          { storagePath }
        )
      }
      if (rows.length === 1) {
        return {
          kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.DB_ROW_FOUND,
          ...rowIdentity(rows[0], storagePath),
        }
      }

      let inserted
      try {
        inserted = await client
          .from(PHOTO_UPLOAD_EVIDENCE_TABLE)
          .insert(insertPayload)
          .select('id,file_path,photo_url')
          .limit(1)
      } catch (error) {
        throw dbError(error, storagePath, { insertAttempt: true, ambiguous: true })
      }

      if (inserted && inserted.error) {
        throw dbError(inserted.error, storagePath, { insertAttempt: true })
      }

      const insertedRows = Array.isArray(inserted && inserted.data) ? inserted.data : []
      if (insertedRows.length !== 1 || insertedRows[0] == null) {
        throw new PhotoUploadReconcilerError(
          PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_INSERT_AMBIGUOUS,
          PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_INSERT_AMBIGUOUS,
          { storagePath, outcomeMayHaveCommitted: true }
        )
      }

      return {
        kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.DB_INSERT_SUCCEEDED,
        ...rowIdentity(insertedRows[0], storagePath),
      }
    },
  }
}

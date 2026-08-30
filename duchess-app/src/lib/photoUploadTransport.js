import * as tus from 'tus-js-client'

export const TUS_ENDPOINT =
  'https://ecosxamjvxveawaeluma.storage.supabase.co/storage/v1/upload/resumable'

export const TUS_BUCKET_NAME = 'evidence-photos'
export const TUS_CHUNK_SIZE_BYTES = 6291456
export const TUS_RETRY_DELAYS_MS = Object.freeze([0, 3000, 5000, 10000, 20000])
export const TUS_UPLOAD_URL_MAX_AGE_MS = 86400000

export const PHOTO_UPLOAD_TRANSPORT_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  TUS_CONFLICT: 'TUS_CONFLICT',
  AUTH_OR_PERMISSION: 'AUTH_OR_PERMISSION',
  RETRYABLE_TRANSPORT: 'RETRYABLE_TRANSPORT',
  PERMANENT_TRANSPORT: 'PERMANENT_TRANSPORT',
  ABORTED: 'ABORTED',
})

export class PhotoUploadTransportError extends Error {
  constructor(code, message, extras = {}) {
    super(message)
    this.name = 'PhotoUploadTransportError'
    this.code = code
    this.httpStatus = extras.httpStatus == null ? null : extras.httpStatus
    this.storagePath = extras.storagePath == null ? null : extras.storagePath
    this.uploadUrl = extras.uploadUrl == null ? null : extras.uploadUrl
  }
}

function invalidInput(message) {
  return new PhotoUploadTransportError(
    PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.INVALID_INPUT,
    message
  )
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isBlobLike(value) {
  return typeof Blob === 'function' && value instanceof Blob
}

export function extractTusHttpStatus(error) {
  if (!error || !error.originalResponse || typeof error.originalResponse.getStatus !== 'function') {
    return null
  }
  try {
    const status = error.originalResponse.getStatus()
    if (!Number.isInteger(status)) {
      return null
    }
    return status
  } catch (_error) {
    return null
  }
}

function classifyTransportFailure(status) {
  if (status === 409) {
    return PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.TUS_CONFLICT
  }
  if (status === 401 || status === 403) {
    return PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.AUTH_OR_PERMISSION
  }
  if (status == null) {
    return PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.RETRYABLE_TRANSPORT
  }
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
    return PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.RETRYABLE_TRANSPORT
  }
  if (status >= 400 && status <= 499) {
    return PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.PERMANENT_TRANSPORT
  }
  return PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.RETRYABLE_TRANSPORT
}

function normalizeTusError(error, extras) {
  const httpStatus = extractTusHttpStatus(error)
  const code = classifyTransportFailure(httpStatus)
  return new PhotoUploadTransportError(code, code, {
    httpStatus,
    storagePath: extras.storagePath,
    uploadUrl: extras.uploadUrl,
  })
}

function validateStartUploadInput(input) {
  if (!input || typeof input !== 'object') {
    throw invalidInput('startUpload input is required')
  }
  if (!isBlobLike(input.blob)) {
    throw invalidInput('blob must be a Blob')
  }
  if (!isNonEmptyString(input.storagePath)) {
    throw invalidInput('storagePath must be a non-empty string')
  }
  if (!isNonEmptyString(input.mimeType)) {
    throw invalidInput('mimeType must be a non-empty string')
  }
  if (!isNonEmptyString(input.accessToken)) {
    throw invalidInput('accessToken must be a non-empty string')
  }
  if (!isNonNegativeInteger(input.now)) {
    throw invalidInput('now must be epoch milliseconds')
  }
  if (input.tusUploadUrl != null) {
    if (!isNonEmptyString(input.tusUploadUrl)) {
      throw invalidInput('tusUploadUrl must be a non-empty string when provided')
    }
    if (!isNonNegativeInteger(input.tusCreatedAt)) {
      throw invalidInput('tusCreatedAt must be epoch milliseconds when tusUploadUrl is provided')
    }
  }
}

function isPersistedUrlExpired(tusUploadUrl, tusCreatedAt, now) {
  if (tusUploadUrl == null) {
    return false
  }
  return now - tusCreatedAt >= TUS_UPLOAD_URL_MAX_AGE_MS
}

function currentUploadUrl(upload, fallbackUrl) {
  if (upload && isNonEmptyString(upload.url)) {
    return upload.url
  }
  if (isNonEmptyString(fallbackUrl)) {
    return fallbackUrl
  }
  return null
}

export function createPhotoUploadTransport(options = {}) {
  const UploadClass = options.UploadClass || tus.Upload

  return {
    startUpload(input) {
      validateStartUploadInput(input)

      const blob = input.blob
      const storagePath = input.storagePath
      const mimeType = input.mimeType
      const accessToken = input.accessToken
      const now = input.now
      const tusUploadUrl = input.tusUploadUrl == null ? null : input.tusUploadUrl
      const tusCreatedAt = input.tusCreatedAt == null ? null : input.tusCreatedAt
      const onUploadUrl = input.onUploadUrl
      const onProgress = input.onProgress
      const onChunkComplete = input.onChunkComplete

      const persistedUploadUrlExpired = isPersistedUrlExpired(tusUploadUrl, tusCreatedAt, now)
      const usedPersistedUploadUrl = tusUploadUrl != null && !persistedUploadUrlExpired

      let upload = null
      let aborted = false
      let settled = false
      let rejectDone = null

      const tusOptions = {
        endpoint: TUS_ENDPOINT,
        chunkSize: TUS_CHUNK_SIZE_BYTES,
        retryDelays: TUS_RETRY_DELAYS_MS.slice(),
        storeFingerprintForResuming: false,
        urlStorage: null,
        metadata: {
          bucketName: TUS_BUCKET_NAME,
          objectName: storagePath,
          contentType: mimeType,
        },
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        onProgress(bytesUploaded, bytesTotal) {
          if (typeof onProgress !== 'function') {
            return
          }
          if (
            !Number.isInteger(bytesUploaded) ||
            !Number.isInteger(bytesTotal) ||
            bytesUploaded < 0 ||
            bytesTotal < 0 ||
            bytesUploaded > bytesTotal
          ) {
            return
          }
          onProgress({ bytesUploaded, bytesTotal })
        },
        onChunkComplete(chunkSize, bytesAccepted, bytesTotal) {
          if (typeof onChunkComplete !== 'function') {
            return
          }
          onChunkComplete({ chunkSize, bytesAccepted, bytesTotal })
        },
        onUploadUrlAvailable() {
          if (typeof onUploadUrl !== 'function') {
            return
          }
          const uploadUrl = currentUploadUrl(upload, null)
          if (!uploadUrl) {
            return
          }
          onUploadUrl({
            uploadUrl,
            createdAt: now,
          })
        },
      }

      if (usedPersistedUploadUrl) {
        tusOptions.uploadUrl = tusUploadUrl
      }

      const done = new Promise((resolve, reject) => {
        rejectDone = reject
        tusOptions.onSuccess = () => {
          if (settled) {
            return
          }
          settled = true
          resolve({
            kind: 'TUS_COMPLETE',
            uploadUrl: currentUploadUrl(upload, usedPersistedUploadUrl ? tusUploadUrl : null),
            storagePath,
            bytesTotal: blob.size,
          })
        }
        tusOptions.onError = (error) => {
          if (settled) {
            return
          }
          settled = true
          if (aborted) {
            reject(new PhotoUploadTransportError(
              PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.ABORTED,
              PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.ABORTED,
              {
                storagePath,
                uploadUrl: currentUploadUrl(upload, usedPersistedUploadUrl ? tusUploadUrl : null),
              }
            ))
            return
          }
          reject(normalizeTusError(error, {
            storagePath,
            uploadUrl: currentUploadUrl(upload, usedPersistedUploadUrl ? tusUploadUrl : null),
          }))
        }

        upload = new UploadClass(blob, tusOptions)
        if (upload && typeof upload.start === 'function') {
          upload.start()
        }
      })

      return {
        abort() {
          aborted = true
          if (upload && typeof upload.abort === 'function') {
            upload.abort(false)
          }
          if (!settled && typeof rejectDone === 'function') {
            settled = true
            rejectDone(new PhotoUploadTransportError(
              PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.ABORTED,
              PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.ABORTED,
              {
                storagePath,
                uploadUrl: currentUploadUrl(upload, usedPersistedUploadUrl ? tusUploadUrl : null),
              }
            ))
          }
        },
        done,
        usedPersistedUploadUrl,
        persistedUploadUrlExpired,
      }
    },
  }
}

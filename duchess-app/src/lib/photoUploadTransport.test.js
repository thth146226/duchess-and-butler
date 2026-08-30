/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */

import {
  PHOTO_UPLOAD_TRANSPORT_ERROR_CODES,
  PhotoUploadTransportError,
  TUS_BUCKET_NAME,
  TUS_CHUNK_SIZE_BYTES,
  TUS_ENDPOINT,
  TUS_RETRY_DELAYS_MS,
  TUS_UPLOAD_URL_MAX_AGE_MS,
  createPhotoUploadTransport,
  extractTusHttpStatus,
} from './photoUploadTransport'

const FIXED_NOW = 1_900_000_000_000
const STORAGE_PATH = 'job-1/delivery_queue-office-a-1.jpg'
const MIME_TYPE = 'image/jpeg'
const ACCESS_TOKEN = 'secret-access-token-do-not-leak'
const FRESH_TUS_URL = 'https://storage.example/tus/fresh-1'

class FakeUpload {
  static instances = []

  constructor(file, options) {
    this.file = file
    this.options = options
    this.url = null
    this.started = false
    this.abortCalls = []
    this.findPreviousUploads = jest.fn()
    this.resumeFromPreviousUpload = jest.fn()
    FakeUpload.instances.push(this)
  }

  start() {
    this.started = true
  }

  abort(shouldTerminate) {
    this.abortCalls.push(shouldTerminate)
  }
}

function jpegBlob() {
  return new Blob([Uint8Array.from([1, 2, 3, 4])], { type: MIME_TYPE })
}

function makeTusError(status) {
  const error = new Error('tus failed')
  if (status === undefined) {
    return error
  }
  error.originalResponse = {
    getStatus() {
      return status
    },
  }
  return error
}

function startWithFake(overrides = {}) {
  const transport = createPhotoUploadTransport({ UploadClass: FakeUpload })
  const handle = transport.startUpload({
    blob: jpegBlob(),
    storagePath: STORAGE_PATH,
    mimeType: MIME_TYPE,
    accessToken: ACCESS_TOKEN,
    now: FIXED_NOW,
    ...overrides,
  })
  return {
    handle,
    upload: FakeUpload.instances[FakeUpload.instances.length - 1],
  }
}

function expectNoToken(value) {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(ACCESS_TOKEN)
  expect(serialized).not.toMatch(/Bearer /i)
}

describe('photoUploadTransport', () => {
  beforeEach(() => {
    FakeUpload.instances = []
  })

  test('exports frozen TUS constants', () => {
    expect(TUS_ENDPOINT).toBe(
      'https://ecosxamjvxveawaeluma.storage.supabase.co/storage/v1/upload/resumable'
    )
    expect(TUS_BUCKET_NAME).toBe('evidence-photos')
    expect(TUS_CHUNK_SIZE_BYTES).toBe(6291456)
    expect(TUS_RETRY_DELAYS_MS).toEqual([0, 3000, 5000, 10000, 20000])
    expect(TUS_UPLOAD_URL_MAX_AGE_MS).toBe(86400000)
  })

  test('constructs tus.Upload with the exact endpoint, chunk size, and retry delays', () => {
    const { upload } = startWithFake()
    expect(upload.options.endpoint).toBe(
      'https://ecosxamjvxveawaeluma.storage.supabase.co/storage/v1/upload/resumable'
    )
    expect(upload.options.chunkSize).toBe(6291456)
    expect(upload.options.retryDelays).toEqual([0, 3000, 5000, 10000, 20000])
    expect(upload.started).toBe(true)
  })

  test('sends exact bucket, object path, and content type metadata', () => {
    const { upload } = startWithFake()
    expect(upload.options.metadata).toEqual({
      bucketName: 'evidence-photos',
      objectName: STORAGE_PATH,
      contentType: MIME_TYPE,
    })
  })

  test('does not send x-upsert and forwards the Bearer authorization header', () => {
    const { upload } = startWithFake()
    const keys = Object.keys(upload.options.headers).map((key) => key.toLowerCase())
    expect(keys).not.toContain('x-upsert')
    expect(upload.options.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  test('disables fingerprint persistence and URL storage', () => {
    const { upload } = startWithFake()
    expect(upload.options.storeFingerprintForResuming).toBe(false)
    expect(upload.options.urlStorage).toBeNull()
  })

  test('uses a fresh persisted TUS URL as uploadUrl', () => {
    const { handle, upload } = startWithFake({
      tusUploadUrl: FRESH_TUS_URL,
      tusCreatedAt: FIXED_NOW - TUS_UPLOAD_URL_MAX_AGE_MS + 1,
    })
    expect(upload.options.uploadUrl).toBe(FRESH_TUS_URL)
    expect(handle.usedPersistedUploadUrl).toBe(true)
    expect(handle.persistedUploadUrlExpired).toBe(false)
  })

  test('ignores an expired persisted TUS URL and keeps the same storage path', () => {
    const { handle, upload } = startWithFake({
      tusUploadUrl: FRESH_TUS_URL,
      tusCreatedAt: FIXED_NOW - TUS_UPLOAD_URL_MAX_AGE_MS,
    })
    expect(Object.prototype.hasOwnProperty.call(upload.options, 'uploadUrl')).toBe(false)
    expect(handle.usedPersistedUploadUrl).toBe(false)
    expect(handle.persistedUploadUrlExpired).toBe(true)
    expect(upload.options.metadata.objectName).toBe(STORAGE_PATH)
  })

  test('does not use local bytes or offset as resume authority', () => {
    const { upload } = startWithFake({
      tusUploadUrl: FRESH_TUS_URL,
      tusCreatedAt: FIXED_NOW,
      bytesUploaded: 1234,
      offset: 1234,
    })
    expect(upload.options.offset).toBeUndefined()
    expect(upload.options.bytesUploaded).toBeUndefined()
    expect(upload.options.uploadSize).toBeUndefined()
    expect(upload.options.uploadUrl).toBe(FRESH_TUS_URL)
  })

  test('onUploadUrlAvailable surfaces the exact URL and tolerates multiple invocations', async () => {
    const urls = []
    const { handle, upload } = startWithFake({
      onUploadUrl: (payload) => {
        urls.push(payload)
      },
    })
    upload.url = 'https://storage.example/tus/one'
    upload.options.onUploadUrlAvailable()
    upload.url = 'https://storage.example/tus/two'
    upload.options.onUploadUrlAvailable()
    expect(urls).toEqual([
      { uploadUrl: 'https://storage.example/tus/one', createdAt: FIXED_NOW },
      { uploadUrl: 'https://storage.example/tus/two', createdAt: FIXED_NOW },
    ])
    upload.options.onSuccess()
    await handle.done
  })

  test('forwards exact progress bytesUploaded and bytesTotal', async () => {
    const progress = []
    const { handle, upload } = startWithFake({
      onProgress: (payload) => {
        progress.push(payload)
      },
    })
    upload.options.onProgress(10, 100)
    upload.options.onProgress(100, 100)
    expect(progress).toEqual([
      { bytesUploaded: 10, bytesTotal: 100 },
      { bytesUploaded: 100, bytesTotal: 100 },
    ])
    upload.options.onSuccess()
    await handle.done
  })

  test('success produces TUS_COMPLETE with the stable storage path', async () => {
    const { handle, upload } = startWithFake()
    upload.url = 'https://storage.example/tus/complete'
    upload.options.onSuccess()
    const result = await handle.done
    expect(result).toEqual({
      kind: 'TUS_COMPLETE',
      uploadUrl: 'https://storage.example/tus/complete',
      storagePath: STORAGE_PATH,
      bytesTotal: 4,
    })
    expectNoToken(result)
  })

  test('HTTP 409 produces TUS_CONFLICT and never success', async () => {
    const { handle, upload } = startWithFake()
    upload.url = 'https://storage.example/tus/conflict'
    upload.options.onError(makeTusError(409))
    await expect(handle.done).rejects.toMatchObject({
      name: 'PhotoUploadTransportError',
      code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.TUS_CONFLICT,
      httpStatus: 409,
      storagePath: STORAGE_PATH,
      uploadUrl: 'https://storage.example/tus/conflict',
    })
    await expect(handle.done).rejects.not.toMatchObject({ kind: 'TUS_COMPLETE' })
  })

  test('HTTP 401 produces AUTH_OR_PERMISSION', async () => {
    const { handle, upload } = startWithFake()
    upload.options.onError(makeTusError(401))
    await expect(handle.done).rejects.toMatchObject({
      code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.AUTH_OR_PERMISSION,
      httpStatus: 401,
    })
  })

  test('HTTP 403 produces AUTH_OR_PERMISSION', async () => {
    const { handle, upload } = startWithFake()
    upload.options.onError(makeTusError(403))
    await expect(handle.done).rejects.toMatchObject({
      code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.AUTH_OR_PERMISSION,
      httpStatus: 403,
    })
  })

  test('HTTP 429 produces RETRYABLE_TRANSPORT', async () => {
    const { handle, upload } = startWithFake()
    upload.options.onError(makeTusError(429))
    await expect(handle.done).rejects.toMatchObject({
      code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.RETRYABLE_TRANSPORT,
      httpStatus: 429,
    })
  })

  test('HTTP 500 produces RETRYABLE_TRANSPORT', async () => {
    const { handle, upload } = startWithFake()
    upload.options.onError(makeTusError(500))
    await expect(handle.done).rejects.toMatchObject({
      code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.RETRYABLE_TRANSPORT,
      httpStatus: 500,
    })
  })

  test('no-response network failure produces RETRYABLE_TRANSPORT', async () => {
    const { handle, upload } = startWithFake()
    upload.options.onError(new Error('network down'))
    await expect(handle.done).rejects.toMatchObject({
      code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.RETRYABLE_TRANSPORT,
      httpStatus: null,
    })
  })

  test('ordinary permanent 4xx produces PERMANENT_TRANSPORT', async () => {
    const { handle, upload } = startWithFake()
    upload.options.onError(makeTusError(400))
    await expect(handle.done).rejects.toMatchObject({
      code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.PERMANENT_TRANSPORT,
      httpStatus: 400,
    })
  })

  test('abort uses non-terminating abort(false) and never terminate', async () => {
    const { handle, upload } = startWithFake()
    handle.abort()
    expect(upload.abortCalls).toEqual([false])
    expect(upload.abortCalls).not.toContain(true)
    await expect(handle.done).rejects.toMatchObject({
      code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.ABORTED,
    })
  })

  test('invalid input rejects before constructing Upload', () => {
    const transport = createPhotoUploadTransport({ UploadClass: FakeUpload })
    const valid = {
      blob: jpegBlob(),
      storagePath: STORAGE_PATH,
      mimeType: MIME_TYPE,
      accessToken: ACCESS_TOKEN,
      now: FIXED_NOW,
    }
    expect(() => transport.startUpload({ ...valid, blob: {} })).toThrow(PhotoUploadTransportError)
    expect(() => transport.startUpload({ ...valid, storagePath: '' })).toThrow(
      expect.objectContaining({ code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.INVALID_INPUT })
    )
    expect(() => transport.startUpload({ ...valid, mimeType: '' })).toThrow(
      expect.objectContaining({ code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.INVALID_INPUT })
    )
    expect(() => transport.startUpload({ ...valid, accessToken: '' })).toThrow(
      expect.objectContaining({ code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.INVALID_INPUT })
    )
    expect(() => transport.startUpload({ ...valid, now: 1.5 })).toThrow(
      expect.objectContaining({ code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.INVALID_INPUT })
    )
    expect(() => transport.startUpload({
      ...valid,
      tusUploadUrl: FRESH_TUS_URL,
    })).toThrow(expect.objectContaining({ code: PHOTO_UPLOAD_TRANSPORT_ERROR_CODES.INVALID_INPUT }))
    expect(FakeUpload.instances).toHaveLength(0)
  })

  test('token secrecy holds for success, errors, metadata, and storagePath', async () => {
    const { handle, upload } = startWithFake()
    expect(upload.options.metadata.objectName).toBe(STORAGE_PATH)
    expectNoToken(upload.options.metadata)
    expectNoToken({ storagePath: STORAGE_PATH })
    upload.url = 'https://storage.example/tus/ok'
    upload.options.onSuccess()
    const result = await handle.done
    expectNoToken(result)

    FakeUpload.instances = []
    const failed = startWithFake()
    failed.upload.options.onError(makeTusError(409))
    try {
      await failed.handle.done
    } catch (error) {
      expectNoToken({
        code: error.code,
        message: error.message,
        httpStatus: error.httpStatus,
        storagePath: error.storagePath,
        uploadUrl: error.uploadUrl,
        name: error.name,
      })
      expect(error.message).not.toContain(ACCESS_TOKEN)
    }
  })

  test('expired resume retries the same storagePath as objectName', () => {
    const { upload } = startWithFake({
      tusUploadUrl: FRESH_TUS_URL,
      tusCreatedAt: FIXED_NOW - TUS_UPLOAD_URL_MAX_AGE_MS,
    })
    expect(upload.options.metadata.objectName).toBe(STORAGE_PATH)
    expect(upload.options.metadata.bucketName).toBe('evidence-photos')
  })

  test('never calls findPreviousUploads or resumeFromPreviousUpload', async () => {
    const { handle, upload } = startWithFake({
      tusUploadUrl: FRESH_TUS_URL,
      tusCreatedAt: FIXED_NOW,
    })
    expect(upload.findPreviousUploads).not.toHaveBeenCalled()
    expect(upload.resumeFromPreviousUpload).not.toHaveBeenCalled()
    upload.options.onSuccess()
    await handle.done
    expect(upload.findPreviousUploads).not.toHaveBeenCalled()
    expect(upload.resumeFromPreviousUpload).not.toHaveBeenCalled()
  })

  test('extractTusHttpStatus handles missing and throwing responses', () => {
    expect(extractTusHttpStatus(null)).toBeNull()
    expect(extractTusHttpStatus({})).toBeNull()
    expect(extractTusHttpStatus({ originalResponse: {} })).toBeNull()
    expect(extractTusHttpStatus({
      originalResponse: {
        getStatus() {
          throw new Error('unavailable')
        },
      },
    })).toBeNull()
    expect(extractTusHttpStatus({
      originalResponse: {
        getStatus() {
          return 409
        },
      },
    })).toBe(409)
  })
})

import {
  PHOTO_UPLOAD_EVIDENCE_TABLE,
  PHOTO_UPLOAD_RECONCILER_ERROR_CODES,
  PHOTO_UPLOAD_RECONCILER_RESULT_KINDS,
  PHOTO_UPLOAD_REMOTE_PROOF_SOURCES,
  PHOTO_UPLOAD_STORAGE_BUCKET,
  PhotoUploadReconcilerError,
  SERVER_SIDE_IDEMPOTENCY_GATE_REQUIRED,
  SERVER_SIDE_IDEMPOTENCY_GUARANTEE,
  createPhotoUploadReconciler,
} from './photoUploadReconciler'

const STORAGE_PATH = 'job-1/delivery_queue-office-a-1.jpg'
const PUBLIC_URL = 'https://cdn.example/storage/v1/object/public/evidence-photos/job-1/delivery_queue-office-a-1.jpg'
const EXPECTED_SIZE = 8
const SECRET_SENTINELS = [
  'access_token',
  'refresh_token',
  'portal_token',
  'Authorization',
  'service_role',
  'apikey',
  'password',
  'secret',
  'credential',
]

function expectNoSecrets(value) {
  const serialized = JSON.stringify(value)
  for (const sentinel of SECRET_SENTINELS) {
    expect(serialized).not.toContain(sentinel)
  }
}

function createFakeSupabase({
  infoResult,
  publicUrl = PUBLIC_URL,
  selectResult,
  insertResult,
} = {}) {
  const calls = {
    buckets: [],
    infoPaths: [],
    publicUrlPaths: [],
    tables: [],
    selects: [],
    eqs: [],
    limits: [],
    inserts: [],
  }

  function thenable(run) {
    const builder = {
      select(columns) {
        calls.selects.push(columns)
        return builder
      },
      eq(column, value) {
        calls.eqs.push({ column, value })
        return builder
      },
      limit(n) {
        calls.limits.push(n)
        return builder
      },
      insert(row) {
        calls.inserts.push(row)
        builder._inserted = true
        return builder
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => run(Boolean(builder._inserted)))
          .then(resolve, reject)
      },
    }
    return builder
  }

  return {
    calls,
    storage: {
      from(bucket) {
        calls.buckets.push(bucket)
        return {
          info(path) {
            calls.infoPaths.push(path)
            if (typeof infoResult === 'function') {
              return infoResult(path)
            }
            return infoResult
          },
          getPublicUrl(path) {
            calls.publicUrlPaths.push(path)
            return { data: { publicUrl: typeof publicUrl === 'function' ? publicUrl(path) : publicUrl } }
          },
        }
      },
    },
    from(table) {
      calls.tables.push(table)
      return thenable((isInsert) => {
        if (isInsert) {
          if (typeof insertResult === 'function') {
            return insertResult()
          }
          return insertResult
        }
        if (typeof selectResult === 'function') {
          return selectResult()
        }
        return selectResult
      })
    },
  }
}

function createTransport({ supabaseClient, fetchImpl }) {
  return createPhotoUploadReconciler({ supabaseClient, fetchImpl })
}

describe('photoUploadReconciler', () => {
  test('exports frozen constants and idempotency boundary', () => {
    expect(PHOTO_UPLOAD_STORAGE_BUCKET).toBe('evidence-photos')
    expect(PHOTO_UPLOAD_EVIDENCE_TABLE).toBe('evidence_photos')
    expect(SERVER_SIDE_IDEMPOTENCY_GUARANTEE).toBe(false)
    expect(SERVER_SIDE_IDEMPOTENCY_GATE_REQUIRED).toBe(true)
  })

  test('exact Storage info path and size match is REMOTE_COMPLETE', async () => {
    const supabaseClient = createFakeSupabase({
      infoResult: { data: { size: EXPECTED_SIZE }, error: null },
    })
    const fetchImpl = jest.fn(() => {
      throw new Error('unexpected fetch')
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl })
    const result = await reconciler.inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })
    expect(supabaseClient.calls.buckets).toEqual(['evidence-photos', 'evidence-photos'])
    expect(supabaseClient.calls.infoPaths).toEqual([STORAGE_PATH])
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result).toEqual({
      kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.REMOTE_COMPLETE,
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
      actualSize: EXPECTED_SIZE,
      proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.STORAGE_INFO,
      publicUrl: PUBLIC_URL,
    })
    expect(supabaseClient.calls.publicUrlPaths).toEqual([STORAGE_PATH])
  })

  test('size mismatch is REMOTE_INCOMPLETE and does not fetch or change path', async () => {
    const supabaseClient = createFakeSupabase({
      infoResult: { data: { size: 3 }, error: null },
    })
    const fetchImpl = jest.fn()
    const reconciler = createTransport({ supabaseClient, fetchImpl })
    const result = await reconciler.inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })
    expect(result).toEqual({
      kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.REMOTE_INCOMPLETE,
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
      actualSize: 3,
      proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.STORAGE_INFO,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(supabaseClient.calls.infoPaths).toEqual([STORAGE_PATH])
  })

  test('authoritative 404 is REMOTE_INCOMPLETE with actualSize null', async () => {
    const supabaseClient = createFakeSupabase({
      infoResult: { data: null, error: { status: 404, message: 'not found' } },
    })
    const fetchImpl = jest.fn()
    const reconciler = createTransport({ supabaseClient, fetchImpl })
    const result = await reconciler.inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })
    expect(result.kind).toBe(PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.REMOTE_INCOMPLETE)
    expect(result.actualSize).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('ambiguous primary uses secondary public GET with exact byte length', async () => {
    const supabaseClient = createFakeSupabase({
      infoResult: { data: { name: STORAGE_PATH }, error: null },
    })
    const fetchImpl = jest.fn(async (url) => {
      expect(url).toBe(PUBLIC_URL)
      return {
        status: 200,
        arrayBuffer: async () => new Uint8Array(EXPECTED_SIZE).buffer,
      }
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl })
    const result = await reconciler.inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.REMOTE_COMPLETE,
      proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.PUBLIC_GET,
      actualSize: EXPECTED_SIZE,
      publicUrl: PUBLIC_URL,
      storagePath: STORAGE_PATH,
    })
  })

  test('public GET byte mismatch is REMOTE_INCOMPLETE', async () => {
    const supabaseClient = createFakeSupabase({
      infoResult: { data: {}, error: null },
    })
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      arrayBuffer: async () => new Uint8Array(2).buffer,
    }))
    const reconciler = createTransport({ supabaseClient, fetchImpl })
    const result = await reconciler.inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })
    expect(result).toMatchObject({
      kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.REMOTE_INCOMPLETE,
      actualSize: 2,
      proofSource: PHOTO_UPLOAD_REMOTE_PROOF_SOURCES.PUBLIC_GET,
    })
  })

  test('remote 401/403 classify as REMOTE_AUTH_OR_PERMISSION', async () => {
    const supabaseClient = createFakeSupabase({
      infoResult: { data: null, error: { status: 401 } },
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl: jest.fn() })
    await expect(reconciler.inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_AUTH_OR_PERMISSION,
      httpStatus: 401,
    })
    const forbidden = createFakeSupabase({
      infoResult: { data: null, error: { status: 403 } },
    })
    await expect(createTransport({ supabaseClient: forbidden, fetchImpl: jest.fn() }).inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_AUTH_OR_PERMISSION,
      httpStatus: 403,
    })
  })

  test('remote 429/5xx classify as REMOTE_RETRYABLE', async () => {
    await expect(createTransport({
      supabaseClient: createFakeSupabase({ infoResult: { data: null, error: { status: 429 } } }),
      fetchImpl: jest.fn(),
    }).inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_RETRYABLE,
      httpStatus: 429,
    })
    await expect(createTransport({
      supabaseClient: createFakeSupabase({ infoResult: { data: null, error: { status: 500 } } }),
      fetchImpl: jest.fn(),
    }).inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_RETRYABLE,
      httpStatus: 500,
    })
  })

  test('remote network failure classifies as REMOTE_RETRYABLE', async () => {
    await expect(createTransport({
      supabaseClient: createFakeSupabase({
        infoResult: async () => {
          throw new Error('network down')
        },
      }),
      fetchImpl: jest.fn(),
    }).inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_RETRYABLE,
      httpStatus: null,
    })
  })

  test('ordinary remote 4xx classifies as REMOTE_PERMANENT', async () => {
    await expect(createTransport({
      supabaseClient: createFakeSupabase({ infoResult: { data: null, error: { status: 400 } } }),
      fetchImpl: jest.fn(),
    }).inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: EXPECTED_SIZE,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.REMOTE_PERMANENT,
      httpStatus: 400,
    })
  })

  test('queries evidence_photos by exact file_path and returns DB_ROW_FOUND without insert', async () => {
    const supabaseClient = createFakeSupabase({
      selectResult: {
        data: [{ id: 'row-1', file_path: STORAGE_PATH, photo_url: PUBLIC_URL }],
        error: null,
      },
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl: jest.fn() })
    const result = await reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: { order_id: 'job-1', run_type: 'delivery' },
    })
    expect(supabaseClient.calls.tables).toEqual(['evidence_photos'])
    expect(supabaseClient.calls.eqs).toEqual([{ column: 'file_path', value: STORAGE_PATH }])
    expect(supabaseClient.calls.inserts).toHaveLength(0)
    expect(result).toEqual({
      kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.DB_ROW_FOUND,
      id: 'row-1',
      file_path: STORAGE_PATH,
      photo_url: PUBLIC_URL,
    })
  })

  test('two existing rows are DB_MULTIPLE_ROWS with no insert', async () => {
    const supabaseClient = createFakeSupabase({
      selectResult: {
        data: [
          { id: 'row-1', file_path: STORAGE_PATH, photo_url: PUBLIC_URL },
          { id: 'row-2', file_path: STORAGE_PATH, photo_url: PUBLIC_URL },
        ],
        error: null,
      },
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl: jest.fn() })
    await expect(reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: {},
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_MULTIPLE_ROWS,
    })
    expect(supabaseClient.calls.inserts).toHaveLength(0)
  })

  test('zero rows performs exactly one insert with file_path, photo_url, and allowed metadata', async () => {
    const supabaseClient = createFakeSupabase({
      selectResult: { data: [], error: null },
      insertResult: {
        data: [{ id: 'row-new', file_path: STORAGE_PATH, photo_url: PUBLIC_URL }],
        error: null,
      },
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl: jest.fn() })
    const result = await reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: {
        order_id: 'job-1',
        run_type: 'delivery',
        notes: 'rear',
        file_path: STORAGE_PATH,
        photo_url: PUBLIC_URL,
      },
    })
    expect(supabaseClient.calls.inserts).toHaveLength(1)
    expect(supabaseClient.calls.inserts[0]).toEqual({
      order_id: 'job-1',
      run_type: 'delivery',
      notes: 'rear',
      file_path: STORAGE_PATH,
      photo_url: PUBLIC_URL,
    })
    expect(result).toEqual({
      kind: PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.DB_INSERT_SUCCEEDED,
      id: 'row-new',
      file_path: STORAGE_PATH,
      photo_url: PUBLIC_URL,
    })
  })

  test('unknown metadata field, job_id, id, and created_at are rejected before DB calls', async () => {
    const supabaseClient = createFakeSupabase({
      selectResult: { data: [], error: null },
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl: jest.fn() })
    const base = {
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
    }
    await expect(reconciler.reconcileEvidencePhotoRow({
      ...base,
      metadataPayload: { extra_field: true },
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    await expect(reconciler.reconcileEvidencePhotoRow({
      ...base,
      metadataPayload: { job_id: 'job-1' },
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    await expect(reconciler.reconcileEvidencePhotoRow({
      ...base,
      metadataPayload: { id: 'caller-id' },
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    await expect(reconciler.reconcileEvidencePhotoRow({
      ...base,
      metadataPayload: { created_at: 1 },
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    expect(supabaseClient.calls.tables).toHaveLength(0)
    expect(supabaseClient.calls.inserts).toHaveLength(0)
  })

  test('mismatched caller file_path or photo_url is rejected', async () => {
    const supabaseClient = createFakeSupabase({})
    const reconciler = createTransport({ supabaseClient, fetchImpl: jest.fn() })
    await expect(reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: { file_path: 'other.jpg' },
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    await expect(reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: { photo_url: 'https://cdn.example/other.jpg' },
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    expect(supabaseClient.calls.tables).toHaveLength(0)
  })

  test('insert retryable, auth, and permanent failures are classified', async () => {
    const retryable = createFakeSupabase({
      selectResult: { data: [], error: null },
      insertResult: { data: null, error: { status: 429 } },
    })
    await expect(createTransport({ supabaseClient: retryable, fetchImpl: jest.fn() }).reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: {},
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_RETRYABLE,
      httpStatus: 429,
    })
    expect(retryable.calls.inserts).toHaveLength(1)

    const auth = createFakeSupabase({
      selectResult: { data: [], error: null },
      insertResult: { data: null, error: { status: 403 } },
    })
    await expect(createTransport({ supabaseClient: auth, fetchImpl: jest.fn() }).reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: {},
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_AUTH_OR_PERMISSION,
      httpStatus: 403,
    })

    const permanent = createFakeSupabase({
      selectResult: { data: [], error: null },
      insertResult: { data: null, error: { status: 400, code: '23514' } },
    })
    await expect(createTransport({ supabaseClient: permanent, fetchImpl: jest.fn() }).reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: {},
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_PERMANENT,
      httpStatus: 400,
      postgresCode: '23514',
    })
  })

  test('ambiguous insert does not immediately retry and a later cycle queries first', async () => {
    let selectData = []
    const supabaseClient = createFakeSupabase({
      selectResult: () => ({ data: selectData, error: null }),
      insertResult: async () => {
        throw new Error('connection dropped')
      },
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl: jest.fn() })
    await expect(reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: {},
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.DB_INSERT_AMBIGUOUS,
      outcomeMayHaveCommitted: true,
    })
    expect(supabaseClient.calls.inserts).toHaveLength(1)

    selectData = [{ id: 'row-1', file_path: STORAGE_PATH, photo_url: PUBLIC_URL }]
    const second = await reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: {},
    })
    expect(second.kind).toBe(PHOTO_UPLOAD_RECONCILER_RESULT_KINDS.DB_ROW_FOUND)
    expect(supabaseClient.calls.inserts).toHaveLength(1)
    expect(supabaseClient.calls.eqs).toEqual([
      { column: 'file_path', value: STORAGE_PATH },
      { column: 'file_path', value: STORAGE_PATH },
    ])
  })

  test('invalid inspect and row inputs reject before remote or DB calls', async () => {
    const supabaseClient = createFakeSupabase({})
    const fetchImpl = jest.fn()
    const reconciler = createTransport({ supabaseClient, fetchImpl })
    await expect(reconciler.inspectRemoteObject({
      storagePath: '',
      expectedSize: EXPECTED_SIZE,
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    await expect(reconciler.inspectRemoteObject({
      storagePath: STORAGE_PATH,
      expectedSize: -1,
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    await expect(reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: '',
      metadataPayload: {},
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    await expect(reconciler.reconcileEvidencePhotoRow({
      storagePath: STORAGE_PATH,
      publicUrl: PUBLIC_URL,
      metadataPayload: null,
    })).rejects.toMatchObject({ code: PHOTO_UPLOAD_RECONCILER_ERROR_CODES.INVALID_INPUT })
    expect(supabaseClient.calls.infoPaths).toHaveLength(0)
    expect(supabaseClient.calls.tables).toHaveLength(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('normalized results and errors never contain secret sentinels', async () => {
    const supabaseClient = createFakeSupabase({
      infoResult: {
        data: null,
        error: {
          status: 401,
          message: 'Authorization Bearer secret access_token refresh_token portal_token service_role apikey password credential',
        },
      },
    })
    const reconciler = createTransport({ supabaseClient, fetchImpl: jest.fn() })
    try {
      await reconciler.inspectRemoteObject({
        storagePath: STORAGE_PATH,
        expectedSize: EXPECTED_SIZE,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(PhotoUploadReconcilerError)
      expectNoSecrets({
        code: error.code,
        message: error.message,
        httpStatus: error.httpStatus,
        storagePath: error.storagePath,
      })
    }
  })

  test('query-before-insert is application reconciliation, not server-side unique idempotency', () => {
    expect(SERVER_SIDE_IDEMPOTENCY_GUARANTEE).toBe(false)
    expect(SERVER_SIDE_IDEMPOTENCY_GATE_REQUIRED).toBe(true)
  })
})

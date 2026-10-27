import { useEffect, useState } from 'react'
import { Upload } from 'tus-js-client'
import {
  PHOTO_UPLOAD_ACTOR_SCOPE_TYPES,
  PHOTO_UPLOAD_DB_NAME,
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  createPhotoUploadDb,
} from './lib/photoUploadDb'
import { PHOTO_UPLOAD_STATUSES } from './lib/photoUploadDomain'
import {
  getPhotoUploadRuntime,
  resetPhotoUploadRuntimeRegistryForTests,
} from './lib/photoUploadRuntime'
import { TUS_CHUNK_SIZE_BYTES, createPhotoUploadTransport } from './lib/photoUploadTransport'
import {
  resetDriverUploadSessionForTests,
  retainDriverUploadRuntime,
  scheduleDriverUploadRuntimeRelease,
} from './lib/driverUploadSession'
import { hashOriginBytes, webCryptoDiagnostic } from './tusLocalSafariSha256.mjs'

const DB_NAME = 'duchess-photo-upload-s12-tus-safari'
const ACTOR = 's12-tus-safari-actor'
const TOKEN = 'tus-local-safari-token'

function endpoint() {
  return `${window.location.origin}/tus-local/files`
}

function LocalUpload(file, options) {
  return new Upload(file, {
    ...options,
    endpoint: endpoint(),
  })
}

function syntheticBytes(size, seed) {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (seed + index * 17) & 255
  }
  return bytes
}

function makeRecord(queueId, bytes) {
  const now = Date.now()
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: queueId,
    blob: new Blob([bytes], { type: 'application/octet-stream' }),
    file_name: `${queueId}.bin`,
    mime_type: 'application/octet-stream',
    file_size: bytes.length,
    source_surface: 's12_tus_safari',
    entity_type: 'job',
    entity_id: 's12-tus-safari-job',
    provisional_id: null,
    actor_scope_type: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL,
    actor_scope_id: ACTOR,
    run_type: 'delivery',
    storage_path: `s12-tus-safari/${queueId}.bin`,
    status: PHOTO_UPLOAD_STATUSES.QUEUED,
    upload_attempt_count: 0,
    db_attempt_count: 0,
    next_retry_at: null,
    retry_phase: null,
    discard_requested: false,
    discard_requested_at: null,
    failure_stage: null,
    last_error: null,
    last_http_status: null,
    tus_upload_url: null,
    tus_created_at: null,
    bytes_uploaded: 0,
    bytes_total: bytes.length,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: { synthetic: true },
    lease_owner: null,
    lease_generation: 0,
    lease_expires_at: null,
    remote_reconciliation_status: null,
    remote_cleanup_attempt_count: 0,
    remote_cleanup_last_error: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
}

function localReconciler() {
  return {
    async inspectRemoteObject({ storagePath, expectedSize }) {
      const response = await fetch('/tus-local/status', { cache: 'no-store' })
      if (!response.ok) {
        throw new Error('local tus status unavailable')
      }
      const body = await response.json()
      const file = (body.files || []).find((item) => item.storage_path === storagePath)
      const actualSize = file ? file.length : 0
      if (!file || actualSize !== expectedSize || file.offset !== expectedSize) {
        return {
          kind: 'REMOTE_INCOMPLETE',
          storagePath,
          expectedSize,
          actualSize,
        }
      }
      return {
        kind: 'REMOTE_COMPLETE',
        storagePath,
        expectedSize,
        actualSize,
        proofSource: 'local_tus_status',
        publicUrl: `${window.location.origin}/tus-local/status`,
      }
    },
    async reconcileEvidencePhotoRow({ storagePath }) {
      return { kind: 'DB_INSERT_SUCCEEDED', id: `local-${storagePath}` }
    },
  }
}

function runtimeOptions() {
  return {
    createDb: () => createPhotoUploadDb({ dbName: DB_NAME }),
    createTransport: () => createPhotoUploadTransport({ UploadClass: LocalUpload }),
    createReconciler: () => localReconciler(),
    getAccessToken: async () => TOKEN,
    leaseOwner: 'tus-local-safari-tab',
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

async function readStatus() {
  const response = await fetch('/tus-local/status', { cache: 'no-store' })
  if (!response.ok) {
    throw new Error('status HTTP ' + response.status)
  }
  return response.json()
}

async function arm(storagePath, rule) {
  const response = await fetch('/tus-local/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storagePath, ...rule }),
  })
  if (!response.ok && response.status !== 204) {
    throw new Error('control HTTP ' + response.status)
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function TusLocalSafariHarness() {
  const [screen, setScreen] = useState('upload')
  const [line, setLine] = useState('Pronto.')
  const [cryptoNote, setCryptoNote] = useState(() => webCryptoDiagnostic(window))
  const [report, setReport] = useState(null)
  const [suspension, setSuspension] = useState('Ainda sem suspensão. O upload não continua enquanto o Safari estiver suspenso.')
  const localHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

  useEffect(() => {
    if (DB_NAME === PHOTO_UPLOAD_DB_NAME) {
      throw new Error('tus local harness refused the real database name')
    }
    retainDriverUploadRuntime(ACTOR, runtimeOptions())
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setSuspension('Safari suspenso. Nenhum upload contínuo é declarado nesta condição.')
        return
      }
      const runtime = getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, ACTOR)
      if (runtime && typeof runtime.wake === 'function') {
        void runtime.wake({ hiddenDuration: 0, source: 'visibility' })
      }
      setSuspension('Safari voltou a executar. A retomada só vale a partir deste retorno.')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      scheduleDriverUploadRuntimeRelease(ACTOR)
    }
  }, [])

  async function runTransfer(kind) {
    const db = createPhotoUploadDb({ dbName: DB_NAME })
    try {
      let bytes
      let queueId
      if (kind === 'complete') {
        queueId = 's12-safari-complete'
        bytes = syntheticBytes(32 * 1024, 4)
      } else if (kind === 'resume') {
        queueId = 's12-safari-resume'
        bytes = syntheticBytes(TUS_CHUNK_SIZE_BYTES + 4096, 8)
        await arm(`s12-tus-safari/${queueId}.bin`, { cutAfterBytes: 128 })
      } else {
        queueId = 's12-safari-navigate'
        bytes = syntheticBytes(16 * 1024, 2)
        await arm(`s12-tus-safari/${queueId}.bin`, { delayMs: 5000 })
        setScreen('other')
      }
      const source = await hashOriginBytes(bytes, window)
      if (source.diagnostic) {
        setCryptoNote(source.diagnostic)
      }
      const sourceHash = source.hex
      await db.putRecord(makeRecord(queueId, bytes))
      const runtime = getPhotoUploadRuntime(PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL, ACTOR)
      if (runtime) {
        await runtime.wake({ hiddenDuration: 0, source: 'manual' })
      }
      let row = null
      for (let attempt = 0; attempt < 80; attempt += 1) {
        row = await db.getRecord({
          queueId,
          actorScopeType: PHOTO_UPLOAD_ACTOR_SCOPE_TYPES.DRIVER_PORTAL,
          actorScopeId: ACTOR,
        })
        if (row && row.status === PHOTO_UPLOAD_STATUSES.DONE) {
          break
        }
        if (kind === 'navigate' && row && row.bytes_uploaded > 0) {
          setLine(`Outra tela. Bytes já aceitos: ${row.bytes_uploaded}.`)
        }
        await wait(250)
      }
      const status = await readStatus()
      const file = (status.files || []).find((item) => item.storage_path === `s12-tus-safari/${queueId}.bin`)
      const next = {
        kind,
        bytes: bytes.length,
        sha256_source: sourceHash,
        sha256_source_method: source.method,
        sha256_destination: file ? file.sha256 : null,
        is_secure_context: window.isSecureContext === true,
        web_crypto_diagnostic: source.diagnostic,
        match: Boolean(file && file.sha256 === sourceHash),
        offset: file ? file.offset : null,
        status: row ? row.status : null,
        endpoint: endpoint(),
        database: DB_NAME,
        real_database: PHOTO_UPLOAD_DB_NAME,
        operations: (status.operations || []).filter((item) => item.storage_path === `s12-tus-safari/${queueId}.bin`),
        suspension,
      }
      setReport(next)
      setLine(next.match ? `${kind}: hash coincidente.` : `${kind}: hash diferente ou incompleto.`)
    } catch (error) {
      setLine(error && error.message ? error.message : 'falha')
    } finally {
      await db.close()
    }
  }

  return (
    <main style={{ fontFamily: 'sans-serif', margin: '16px', maxWidth: '720px' }}>
      <h1>TUS local — Safari</h1>
      <p>
        Banco exclusivo <code>{DB_NAME}</code>. O banco real não é aberto.
        O cliente é o TUS da aplicação, pelo XHR desta página.
        Endpoint <code>{endpoint()}</code>.
      </p>
      {localHost ? (
        <p>Este hostname é o próprio aparelho. No iPhone abra o IP da rede local, não 127.0.0.1.</p>
      ) : null}
      <p>{suspension}</p>
      {cryptoNote ? <p>{cryptoNote}</p> : null}
      <p>{line}</p>
      <p>
        <button type="button" onClick={() => setScreen('upload')}>Tela de upload</button>
        {' '}
        <button type="button" onClick={() => setScreen('other')}>Outra tela</button>
      </p>
      {screen === 'upload' ? (
        <section>
          <p>Tela de upload. O runtime permanece montado na sessão.</p>
          <button type="button" onClick={() => runTransfer('complete')}>Enviar e conferir SHA-256</button>
          {' '}
          <button type="button" onClick={() => runTransfer('resume')}>Cortar, retomar e conferir</button>
          {' '}
          <button type="button" onClick={() => runTransfer('navigate')}>Enviar e ir para a outra tela</button>
        </section>
      ) : (
        <section>
          <p>Outra tela interna. O upload continua porque o runtime não foi desmontado.</p>
          <button type="button" onClick={() => setScreen('upload')}>Voltar ao upload</button>
        </section>
      )}
      <textarea
        readOnly
        value={report ? JSON.stringify(report, null, 2) : ''}
        style={{ width: '100%', minHeight: '220px', marginTop: '12px' }}
      />
      <button
        type="button"
        onClick={() => {
          resetDriverUploadSessionForTests()
          void resetPhotoUploadRuntimeRegistryForTests()
        }}
      >
        Encerrar runtime de teste
      </button>
    </main>
  )
}

import { useCallback, useRef, useState } from 'react'
import { PHOTO_UPLOAD_STATUSES } from '../lib/photoUploadDomain'

const STATUS_LABELS = {
  [PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED]: 'Queued',
  [PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN]: 'Waiting for report confirmation',
  [PHOTO_UPLOAD_STATUSES.QUEUED]: 'Queued',
  [PHOTO_UPLOAD_STATUSES.UPLOADING]: 'Uploading…',
  [PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED]: 'Upload paused — waiting to resume',
  [PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT]: 'Upload retry scheduled',
  [PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD]: 'Upload failed',
  [PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE]: 'Saving photo…',
  [PHOTO_UPLOAD_STATUSES.DB_PENDING]: 'Saving photo…',
  [PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT]: 'Saving photo…',
  [PHOTO_UPLOAD_STATUSES.FAILED_DB]: 'Photo uploaded, but saving failed',
}

const VARIANT_STYLES = {
  evidence: {
    container: { marginTop: '12px' },
    row: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 12px',
      marginBottom: '6px',
      borderRadius: '6px',
      backgroundColor: '#f9fafb',
      border: '1px solid #e5e7eb',
    },
    label: { fontSize: '14px', color: '#374151' },
    progressTrack: {
      width: '100px',
      height: '6px',
      backgroundColor: '#e5e7eb',
      borderRadius: '3px',
      overflow: 'hidden',
      marginLeft: '10px',
    },
    progressFill: { height: '100%', backgroundColor: '#3b82f6' },
    retryButton: {
      marginLeft: '10px',
      padding: '4px 10px',
      fontSize: '13px',
      borderRadius: '4px',
      border: '1px solid #d1d5db',
      backgroundColor: '#ffffff',
      cursor: 'pointer',
    },
  },
  report: {
    container: { marginTop: '8px' },
    row: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '6px 10px',
      marginBottom: '4px',
      borderRadius: '4px',
      backgroundColor: '#f3f4f6',
      border: '1px solid #d1d5db',
    },
    label: { fontSize: '13px', color: '#4b5563' },
    progressTrack: {
      width: '80px',
      height: '5px',
      backgroundColor: '#d1d5db',
      borderRadius: '2px',
      overflow: 'hidden',
      marginLeft: '8px',
    },
    progressFill: { height: '100%', backgroundColor: '#2563eb' },
    retryButton: {
      marginLeft: '8px',
      padding: '3px 8px',
      fontSize: '12px',
      borderRadius: '3px',
      border: '1px solid #9ca3af',
      backgroundColor: '#ffffff',
      cursor: 'pointer',
    },
  },
}

function clampProgress(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function getStatusLabel(status) {
  return STATUS_LABELS[status] || status || 'Unknown'
}

function QueueRow({ record, variant, retryingQueueId, onUploadRetry, onDbRetry }) {
  const styles = VARIANT_STYLES[variant] || VARIANT_STYLES.evidence
  const status = record && record.status
  const label = getStatusLabel(status)
  const progress = clampProgress(record && record.progress_pct)
  const showProgress = status === PHOTO_UPLOAD_STATUSES.UPLOADING
  const showUploadRetry = status === PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD
  const showDbRetry = status === PHOTO_UPLOAD_STATUSES.FAILED_DB
  const showRetry = showUploadRetry || showDbRetry
  const isRetrying = retryingQueueId === record.queue_id

  return (
    <div data-testid="queue-status-row" data-queue-id={record.queue_id} style={styles.row}>
      <span style={styles.label}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {showProgress && (
          <div style={styles.progressTrack}>
            <div
              data-testid="queue-progress-fill"
              style={{
                ...styles.progressFill,
                width: `${progress}%`,
              }}
            />
          </div>
        )}
        {showRetry && (
          <button
            type="button"
            data-testid={showUploadRetry ? 'queue-retry-upload' : 'queue-retry-db'}
            disabled={isRetrying}
            style={{
              ...styles.retryButton,
              opacity: isRetrying ? 0.6 : 1,
              cursor: isRetrying ? 'not-allowed' : 'pointer',
            }}
            onClick={showUploadRetry ? onUploadRetry : onDbRetry}
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}

export default function PhotoUploadQueueStatus({
  records = [],
  variant = 'evidence',
  onUploadRetry,
  onDbRetry,
}) {
  const [retryingQueueId, setRetryingQueueId] = useState(null)
  const retryingRef = useRef(false)

  const handleUploadRetry = useCallback(
    (queueId) => async () => {
      if (typeof onUploadRetry !== 'function') return
      if (retryingRef.current) return
      retryingRef.current = true
      setRetryingQueueId(queueId)
      try {
        await onUploadRetry(queueId)
      } finally {
        retryingRef.current = false
        setRetryingQueueId(null)
      }
    },
    [onUploadRetry],
  )

  const handleDbRetry = useCallback(
    (queueId) => async () => {
      if (typeof onDbRetry !== 'function') return
      if (retryingRef.current) return
      retryingRef.current = true
      setRetryingQueueId(queueId)
      try {
        await onDbRetry(queueId)
      } finally {
        retryingRef.current = false
        setRetryingQueueId(null)
      }
    },
    [onDbRetry],
  )

  const styles = VARIANT_STYLES[variant] || VARIANT_STYLES.evidence
  const list = (Array.isArray(records) ? records : []).filter((record) => record && record.status !== PHOTO_UPLOAD_STATUSES.DONE)
  if (list.length === 0) return null

  return (
    <div data-testid="photo-upload-queue-status" style={styles.container}>
      {list.map((record) => (
        <QueueRow
          key={record.queue_id}
          record={record}
          variant={variant}
          retryingQueueId={retryingQueueId}
          onUploadRetry={handleUploadRetry(record.queue_id)}
          onDbRetry={handleDbRetry(record.queue_id)}
        />
      ))}
    </div>
  )
}

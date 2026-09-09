import { createRoot } from 'react-dom/client'
import { act } from 'react'
import PhotoUploadQueueStatus from './PhotoUploadQueueStatus'
import { PHOTO_UPLOAD_STATUSES } from '../lib/photoUploadDomain'

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true
})

function render(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return new Promise((resolve) => {
    act(() => {
      root.render(element)
    })
    resolve({
      root,
      container,
      unmount() {
        act(() => {
          root.unmount()
        })
        container.remove()
      },
      queryByText(text) {
        const nodes = Array.from(container.querySelectorAll('*'))
        return nodes.find((n) => n.textContent === text)
      },
      queryByTestId(id) {
        return container.querySelector(`[data-testid="${id}"]`)
      },
      getByTestId(id) {
        const el = container.querySelector(`[data-testid="${id}"]`)
        if (!el) throw new Error(`data-testid="${id}" not found`)
        return el
      },
      rerender(next) {
        act(() => {
          root.render(next)
        })
      },
    })
  })
}

describe('PhotoUploadQueueStatus', () => {
  function makeRecord({ status, progressPct = 0, extra = {} }) {
    return {
      queue_id: 'q-1',
      status,
      progress_pct: progressPct,
      source_surface: 'office_evidence',
      entity_type: 'job',
      entity_id: 'job-1',
      provisional_id: null,
      created_at: Date.now(),
      ...extra,
    }
  }

  test('renders status labels per UX matrix', async () => {
    const matrix = {
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
    for (const [status, expected] of Object.entries(matrix)) {
      const { unmount, queryByText } = await render(<PhotoUploadQueueStatus records={[makeRecord({ status })]} />)
      expect(queryByText(expected)).toBeTruthy()
      unmount()
    }
  })

  test('DONE records are not persistently rendered', async () => {
    const { container, unmount } = await render(<PhotoUploadQueueStatus records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.DONE })]} />)
    expect(container.querySelector('[data-testid="photo-upload-queue-status"]')).toBeNull()
    unmount()
  })

  test('empty records render nothing', async () => {
    const { container, unmount } = await render(<PhotoUploadQueueStatus records={[]} />)
    expect(container.firstChild).toBeNull()
    unmount()
  })

  test('progress bar renders only for UPLOADING', async () => {
    const { queryByTestId, rerender, unmount } = await render(
      <PhotoUploadQueueStatus records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.UPLOADING, progressPct: 42 })]} />,
    )
    expect(queryByTestId('queue-progress-fill')).toBeTruthy()
    rerender(<PhotoUploadQueueStatus records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.QUEUED })]} />)
    expect(queryByTestId('queue-progress-fill')).toBeFalsy()
    unmount()
  })

  test('progress clamps to 0 and 100', async () => {
    const { getByTestId, rerender, unmount } = await render(
      <PhotoUploadQueueStatus records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.UPLOADING, progressPct: -10 })]} />,
    )
    expect(getByTestId('queue-progress-fill').style.width).toBe('0%')
    rerender(<PhotoUploadQueueStatus records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.UPLOADING, progressPct: 150 })]} />)
    expect(getByTestId('queue-progress-fill').style.width).toBe('100%')
    unmount()
  })

  test('FAILED_UPLOAD shows Retry and calls upload retry only', async () => {
    const onUploadRetry = jest.fn().mockResolvedValue()
    const onDbRetry = jest.fn().mockResolvedValue()
    const { getByTestId, queryByTestId, unmount } = await render(
      <PhotoUploadQueueStatus
        records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD })]}
        onUploadRetry={onUploadRetry}
        onDbRetry={onDbRetry}
      />,
    )
    expect(getByTestId('queue-retry-upload')).toBeTruthy()
    expect(queryByTestId('queue-retry-db')).toBeFalsy()
    await act(async () => {
      getByTestId('queue-retry-upload').click()
    })
    expect(onUploadRetry).toHaveBeenCalledWith('q-1')
    expect(onDbRetry).not.toHaveBeenCalled()
    unmount()
  })

  test('FAILED_DB shows Retry and calls DB retry only', async () => {
    const onUploadRetry = jest.fn().mockResolvedValue()
    const onDbRetry = jest.fn().mockResolvedValue()
    const { getByTestId, queryByTestId, unmount } = await render(
      <PhotoUploadQueueStatus
        records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.FAILED_DB })]}
        onUploadRetry={onUploadRetry}
        onDbRetry={onDbRetry}
      />,
    )
    expect(getByTestId('queue-retry-db')).toBeTruthy()
    expect(queryByTestId('queue-retry-upload')).toBeFalsy()
    await act(async () => {
      getByTestId('queue-retry-db').click()
    })
    expect(onDbRetry).toHaveBeenCalledWith('q-1')
    expect(onUploadRetry).not.toHaveBeenCalled()
    unmount()
  })

  test('non-failed statuses show no retry button', async () => {
    const nonRetryable = [
      PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED,
      PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN,
      PHOTO_UPLOAD_STATUSES.QUEUED,
      PHOTO_UPLOAD_STATUSES.UPLOADING,
      PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED,
      PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT,
      PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE,
      PHOTO_UPLOAD_STATUSES.DB_PENDING,
      PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT,
    ]
    for (const status of nonRetryable) {
      const { queryByTestId, unmount } = await render(<PhotoUploadQueueStatus records={[makeRecord({ status })]} />)
      expect(queryByTestId('queue-retry-upload')).toBeFalsy()
      expect(queryByTestId('queue-retry-db')).toBeFalsy()
      unmount()
    }
  })

  test('double-click guard prevents second retry invocation', async () => {
    let resolveFirst
    const onUploadRetry = jest.fn(() => new Promise((resolve) => { resolveFirst = resolve }))
    const { getByTestId, unmount } = await render(
      <PhotoUploadQueueStatus
        records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD })]}
        onUploadRetry={onUploadRetry}
      />,
    )
    const button = getByTestId('queue-retry-upload')
    await act(async () => {
      button.click()
      button.click()
    })
    expect(onUploadRetry).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveFirst()
    })
    unmount()
  })

  test('raw last_error and secrets are not rendered', async () => {
    const records = [makeRecord({
      status: PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD,
      extra: {
        last_error: { code: 'HTTP_500', message: 'leak' },
        tus_upload_url: 'https://tus.example.com/secret',
        remote_public_url: 'https://storage.example.com/photo.jpg',
        token: 'Bearer abc123',
      },
    })]
    const { container, unmount } = await render(<PhotoUploadQueueStatus records={records} />)
    const text = container.textContent
    expect(text).not.toContain('HTTP_500')
    expect(text).not.toContain('leak')
    expect(text).not.toContain('https://tus.example.com/secret')
    expect(text).not.toContain('https://storage.example.com/photo.jpg')
    expect(text).not.toContain('Bearer abc123')
    unmount()
  })

  test('Blob and metadata are not exposed to status UI', async () => {
    const records = [makeRecord({
      status: PHOTO_UPLOAD_STATUSES.QUEUED,
      extra: {
        blob: new Blob(['x']),
        metadata_payload: { secret: 'x' },
      },
    })]
    const { container, unmount } = await render(<PhotoUploadQueueStatus records={records} />)
    expect(container.textContent).toBe('Queued')
    unmount()
  })

  test('uses report variant styles without altering domain mapping', async () => {
    const { queryByText, unmount } = await render(
      <PhotoUploadQueueStatus records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.QUEUED })]} variant="report" />,
    )
    expect(queryByText('Queued')).toBeTruthy()
    unmount()
  })

  test('row data attributes expose queue id for tests', async () => {
    const { getByTestId, unmount } = await render(<PhotoUploadQueueStatus records={[makeRecord({ status: PHOTO_UPLOAD_STATUSES.QUEUED })]} />)
    expect(getByTestId('queue-status-row').getAttribute('data-queue-id')).toBe('q-1')
    unmount()
  })
})

import { createRoot } from 'react-dom/client'
import { act } from 'react'
import EvidenceUpload from './EvidenceUpload'
import { usePhotoUploadQueue } from '../hooks/usePhotoUploadQueue'
import { supabase } from '../lib/supabase'

jest.mock('../hooks/usePhotoUploadQueue')
jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', name: 'Alex' } }),
}))
jest.mock('../lib/supabase', () => {
  const mockUpload = jest.fn()
  const mockInsert = jest.fn()
  const mockFromBuilder = {}
  mockFromBuilder.select = jest.fn(() => mockFromBuilder)
  mockFromBuilder.eq = jest.fn(() => mockFromBuilder)
  mockFromBuilder.order = jest.fn(() => Promise.resolve({ data: [] }))
  mockFromBuilder.insert = mockInsert
  mockFromBuilder.delete = jest.fn(() => mockFromBuilder)
  return {
    mockUpload,
    mockInsert,
    supabase: {
      from: jest.fn(() => mockFromBuilder),
      storage: {
        from: jest.fn(() => ({
          upload: mockUpload,
          getPublicUrl: jest.fn(),
          remove: jest.fn(),
        })),
      },
    },
  }
})

const { mockUpload, mockInsert } = jest.requireMock('../lib/supabase')
const mockEnqueueFiles = jest.fn()
const mockManualUploadRetry = jest.fn()
const mockManualDbRetry = jest.fn()
let capturedQueueOptions = {}
let mockQueueRecords = []
let galleryFetchCount = 0

function renderComponent(props = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <EvidenceUpload
        jobId="job-77"
        jobTable="crms_jobs"
        crmsRef="CRMS-1"
        eventName="Wedding"
        {...props}
      />
    )
  })
  return { container, root }
}

describe('EvidenceUpload photo upload v1', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockEnqueueFiles.mockReset()
    mockManualUploadRetry.mockReset()
    mockManualDbRetry.mockReset()
    mockUpload.mockReset()
    mockInsert.mockReset()
    capturedQueueOptions = {}
    mockQueueRecords = []
    galleryFetchCount = 0
    usePhotoUploadQueue.mockImplementation((options = {}) => {
      capturedQueueOptions = options
      return {
        enqueueFiles: mockEnqueueFiles,
        queueRecords: mockQueueRecords,
        manualUploadRetry: mockManualUploadRetry,
        manualDbRetry: mockManualDbRetry,
        busy: false,
        lastResult: null,
      }
    })
    const chain = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      order: jest.fn(() => {
        galleryFetchCount += 1
        return Promise.resolve({ data: [] })
      }),
      insert: mockInsert,
      delete: jest.fn(() => chain),
    }
    if (jest.isMockFunction(supabase.from)) {
      supabase.from.mockReturnValue(chain)
    } else {
      jest.spyOn(supabase, 'from').mockReturnValue(chain)
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('file picker still renders with multiple selection', () => {
    const { container, root } = renderComponent()
    const inputs = container.querySelectorAll('input[type="file"]')
    expect(inputs.length).toBe(2)
    inputs.forEach((input) => {
      expect(input.multiple).toBe(true)
      expect(input.accept).toBe('image/*')
    })
    expect(container.querySelector('input[capture="environment"]')).toBeTruthy()
    expect(container.textContent).toContain('Upload evidence photos')
    expect(container.textContent).toContain('No evidence photos yet')
    expect(usePhotoUploadQueue).toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('supported image selection routes through usePhotoUploadQueue with multiple files', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = renderComponent()
    const gallery = container.querySelector('[data-testid="evidence-gallery-input"]')
    const files = [
      new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' }),
      new File([Uint8Array.from([2])], 'b.png', { type: 'image/png' }),
    ]
    Object.defineProperty(gallery, 'files', { value: files })
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockEnqueueFiles).toHaveBeenCalledTimes(1)
    const forwarded = mockEnqueueFiles.mock.calls[0][0]
    expect(forwarded).toHaveLength(2)
    expect(forwarded[0].name).toBe('a.jpg')
    expect(forwarded[1].name).toBe('b.png')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('durable acceptance success produces queued UI not remote completion', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = renderComponent()
    const gallery = container.querySelector('[data-testid="evidence-gallery-input"]')
    Object.defineProperty(gallery, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Photos queued for upload.')
    expect(container.textContent).not.toContain('uploaded successfully')
    expect(container.textContent).not.toContain('Upload success')
    act(() => { root.unmount() })
  })

  test('durable acceptance failure produces safe error UI', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [], rejected: [{ fileName: 'a.jpg', code: 'QUEUE_WRITE_FAILED' }] })
    const { container, root } = renderComponent()
    const gallery = container.querySelector('[data-testid="evidence-gallery-input"]')
    Object.defineProperty(gallery, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Photos could not be queued for upload.')
    expect(container.textContent).not.toContain('uploaded successfully')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('unsupported files are surfaced safely', async () => {
    mockEnqueueFiles.mockResolvedValue({
      accepted: [],
      rejected: [{ fileName: 'a.heic', code: 'UNSUPPORTED_MIME' }],
    })
    const { container, root } = renderComponent()
    const gallery = container.querySelector('[data-testid="evidence-gallery-input"]')
    Object.defineProperty(gallery, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.heic', { type: 'image/heic' })],
    })
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Photos could not be queued for upload.')
    act(() => { root.unmount() })
  })

  test('existing non-upload UI and props remain intact', () => {
    const { container, root } = renderComponent()
    expect(container.textContent).toContain('After DEL')
    expect(container.textContent).toContain('Pre-COL')
    expect(container.textContent).toContain('After COL')
    expect(container.textContent).toContain('Take photo')
    expect(container.textContent).toContain('Choose from gallery')
    expect(supabase.from).toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('local durable acceptance does not call fetchPhotos', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = renderComponent()
    await act(async () => { await Promise.resolve() })
    const afterMount = galleryFetchCount
    expect(afterMount).toBeGreaterThan(0)
    const gallery = container.querySelector('[data-testid="evidence-gallery-input"]')
    Object.defineProperty(gallery, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Photos queued for upload.')
    expect(galleryFetchCount).toBe(afterMount)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('remote DONE for current jobId calls fetchPhotos after completion not before', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = renderComponent()
    await act(async () => { await Promise.resolve() })
    const afterMount = galleryFetchCount
    const gallery = container.querySelector('[data-testid="evidence-gallery-input"]')
    Object.defineProperty(gallery, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(galleryFetchCount).toBe(afterMount)
    await act(async () => {
      capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'job-77',
        status: 'DONE',
      })
    })
    expect(galleryFetchCount).toBe(afterMount + 1)
    expect(container.textContent).toContain('Photos queued for upload.')
    expect(container.textContent).not.toContain('uploaded successfully')
    act(() => { root.unmount() })
  })

  test('remote DONE for another job does not refresh current job', async () => {
    const { root } = renderComponent({ jobId: 'job-A' })
    await act(async () => { await Promise.resolve() })
    act(() => {
      root.render(
        <EvidenceUpload
          jobId="job-B"
          jobTable="crms_jobs"
          crmsRef="CRMS-1"
          eventName="Wedding"
        />
      )
    })
    await act(async () => { await Promise.resolve() })
    const afterSwitch = galleryFetchCount
    await act(async () => {
      capturedQueueOptions.onRemoteDone({
        queue_id: 'q-a',
        entity_id: 'job-A',
        status: 'DONE',
      })
    })
    expect(galleryFetchCount).toBe(afterSwitch)
    act(() => { root.unmount() })
  })

  test('hook exactly-once DONE notification refreshes gallery once', async () => {
    const { root } = renderComponent()
    await act(async () => { await Promise.resolve() })
    const afterMount = galleryFetchCount
    await act(async () => {
      capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'job-77',
        status: 'DONE',
      })
    })
    expect(galleryFetchCount).toBe(afterMount + 1)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })
})

describe('EvidenceUpload P11D queue status integration', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockEnqueueFiles.mockReset()
    mockManualUploadRetry.mockReset()
    mockManualDbRetry.mockReset()
    mockUpload.mockReset()
    mockInsert.mockReset()
    capturedQueueOptions = {}
    mockQueueRecords = []
    galleryFetchCount = 0
    usePhotoUploadQueue.mockImplementation((options = {}) => {
      capturedQueueOptions = options
      return {
        enqueueFiles: mockEnqueueFiles,
        queueRecords: mockQueueRecords,
        manualUploadRetry: mockManualUploadRetry,
        manualDbRetry: mockManualDbRetry,
        busy: false,
        lastResult: null,
      }
    })
    const chain = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      order: jest.fn(() => {
        galleryFetchCount += 1
        return Promise.resolve({ data: [] })
      }),
      insert: mockInsert,
      delete: jest.fn(() => chain),
    }
    if (jest.isMockFunction(supabase.from)) {
      supabase.from.mockReturnValue(chain)
    } else {
      jest.spyOn(supabase, 'from').mockReturnValue(chain)
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  function makeRecord({ queueId, status, extra = {} }) {
    return {
      queue_id: queueId,
      status,
      progress_pct: 0,
      source_surface: 'office_evidence',
      entity_type: 'job',
      entity_id: 'job-77',
      provisional_id: null,
      created_at: Date.now(),
      last_error: { code: 'HTTP_500', message: 'secret-leak' },
      ...extra,
    }
  }

  test('renders QUEUED status from usePhotoUploadQueue', () => {
    mockQueueRecords = [makeRecord({ queueId: 'q1', status: 'QUEUED' })]
    const { container, root } = renderComponent()
    expect(container.textContent).toContain('Queued')
    expect(container.querySelector('[data-testid="photo-upload-queue-status"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="queue-retry-upload"]')).toBeFalsy()
    expect(container.querySelector('[data-testid="queue-retry-db"]')).toBeFalsy()
    act(() => { root.unmount() })
  })

  test('FAILED_UPLOAD shows upload retry button and calls manualUploadRetry', async () => {
    mockQueueRecords = [makeRecord({ queueId: 'q1', status: 'FAILED_UPLOAD' })]
    const { container, root } = renderComponent()
    expect(container.textContent).toContain('Upload failed')
    const retryButton = container.querySelector('[data-testid="queue-retry-upload"]')
    expect(retryButton).toBeTruthy()
    await act(async () => { retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(mockManualUploadRetry).toHaveBeenCalledWith('q1')
    expect(mockManualDbRetry).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('FAILED_DB shows DB retry button and calls manualDbRetry', async () => {
    mockQueueRecords = [makeRecord({ queueId: 'q1', status: 'FAILED_DB' })]
    const { container, root } = renderComponent()
    expect(container.textContent).toContain('Photo uploaded, but saving failed')
    const retryButton = container.querySelector('[data-testid="queue-retry-db"]')
    expect(retryButton).toBeTruthy()
    await act(async () => { retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(mockManualDbRetry).toHaveBeenCalledWith('q1')
    expect(mockManualUploadRetry).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('REPORT_LINK_UNKNOWN shows no retry button', () => {
    mockQueueRecords = [makeRecord({ queueId: 'q1', status: 'REPORT_LINK_UNKNOWN' })]
    const { container, root } = renderComponent()
    expect(container.textContent).toContain('Waiting for report confirmation')
    expect(container.querySelector('[data-testid="queue-retry-upload"]')).toBeFalsy()
    expect(container.querySelector('[data-testid="queue-retry-db"]')).toBeFalsy()
    act(() => { root.unmount() })
  })

  test('DONE records are not persistently rendered', () => {
    mockQueueRecords = [makeRecord({ queueId: 'q1', status: 'DONE' })]
    const { container, root } = renderComponent()
    expect(container.querySelector('[data-testid="photo-upload-queue-status"]')).toBeFalsy()
    act(() => { root.unmount() })
  })

  test('raw error is not exposed in status UI', () => {
    mockQueueRecords = [makeRecord({ queueId: 'q1', status: 'FAILED_UPLOAD' })]
    const { container, root } = renderComponent()
    expect(container.textContent).not.toContain('secret-leak')
    expect(container.textContent).not.toContain('HTTP_500')
    act(() => { root.unmount() })
  })
})

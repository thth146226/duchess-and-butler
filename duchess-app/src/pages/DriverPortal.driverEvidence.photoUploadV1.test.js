import { createRoot } from 'react-dom/client'
import { act } from 'react'
import DriverPortal from './DriverPortal'
import { useDriverPhotoUploadQueue } from '../hooks/useDriverPhotoUploadQueue'

jest.mock('../hooks/useDriverPhotoUploadQueue')
jest.mock('@supabase/supabase-js', () => {
  const mockUpload = jest.fn()
  const mockInsert = jest.fn()
  const galleryFetch = { count: 0 }
  function makeChain(table) {
    const chain = {}
    chain.select = jest.fn((cols) => {
      chain._select = cols
      return chain
    })
    chain.eq = jest.fn(() => chain)
    chain.in = jest.fn(() => Promise.resolve({ data: [] }))
    chain.order = jest.fn(() => {
      if (table === 'evidence_photos') {
        galleryFetch.count += 1
      }
      return Promise.resolve({ data: [] })
    })
    chain.insert = mockInsert
    chain.delete = jest.fn(() => chain)
    chain.maybeSingle = jest.fn(() => Promise.resolve({
      data: table === 'job_reports' && chain._select === '*'
        ? { id: 'report-1', run_type: 'DEL', driver_name: 'Pat', driver_notes: null, client_signature: null }
        : null,
    }))
    chain.then = (onFulfilled, onRejected) => Promise.resolve({ data: [] }).then(onFulfilled, onRejected)
    return chain
  }
  const client = {
    from(table) {
      return makeChain(table)
    },
    storage: {
      from() {
        return {
          upload: mockUpload,
          getPublicUrl: () => ({ data: { publicUrl: 'https://example.test/p.jpg' } }),
          remove: jest.fn(),
        }
      },
    },
    auth: {
      getSession: jest.fn(async () => ({ data: { session: null } })),
    },
  }
  return {
    createClient: jest.fn(() => client),
    mockUpload,
    mockInsert,
    galleryFetch,
  }
})

const { mockUpload, mockInsert, galleryFetch } = jest.requireMock('@supabase/supabase-js')
const mockEnqueueFiles = jest.fn()
const mockManualUploadRetry = jest.fn()
const mockManualDbRetry = jest.fn()
const fetchCalls = []
let capturedQueueOptions = {}
let mockQueueRecords = []

function londonYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const year = parts.find((part) => part.type === 'year').value
  const month = parts.find((part) => part.type === 'month').value
  const day = parts.find((part) => part.type === 'day').value
  return `${year}-${month}-${day}`
}

function portalPayload() {
  return {
    driver: { id: 'driver-id-aaa', name: 'Pat', colour: '#B8965A' },
    runs: [{
      id: 'run-1',
      date: londonYmd(),
      type: 'DEL',
      time: '09:00',
      job: {
        id: 'job-88',
        event_name: 'Gala',
        crms_ref: 'CRMS-9',
        venue: 'Hall',
        delivery_done: false,
        collection_done: false,
      },
    }],
  }
}

async function renderPortal(props = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<DriverPortal token="p8-portal-token-SECRET" {...props} />)
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { container, root }
}

async function openEvidenceTab(container) {
  const view = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === 'View →')
  await act(async () => { view.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
  const evidenceTab = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Evidence')
  await act(async () => { evidenceTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('DriverPortal driver evidence photo upload v1', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockEnqueueFiles.mockReset()
    mockUpload.mockReset()
    mockInsert.mockReset()
    mockManualUploadRetry.mockReset()
    mockManualDbRetry.mockReset()
    capturedQueueOptions = {}
    mockQueueRecords = []
    galleryFetch.count = 0
    fetchCalls.length = 0
    global.fetch = jest.fn((...args) => {
      fetchCalls.push(args)
      const url = String(args[0] || '')
      if (url.includes('/api/driver-portal-runs') && (!args[1] || args[1].method !== 'PATCH')) {
        return Promise.resolve({
          ok: true,
          json: async () => portalPayload(),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    useDriverPhotoUploadQueue.mockImplementation((options = {}) => {
      capturedQueueOptions = options
      return {
        enqueueFiles: mockEnqueueFiles,
        busy: false,
        lastResult: null,
        queueRecords: mockQueueRecords,
        manualUploadRetry: mockManualUploadRetry,
        manualDbRetry: mockManualDbRetry,
      }
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('driver evidence picker still renders and routes files through the driver queue', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    expect(container.textContent).toContain('Driver Portal')
    expect(container.textContent).toContain('Pat')
    expect(container.textContent).toContain('Gala')
    await openEvidenceTab(container)
    const camera = container.querySelector('[data-testid="driver-evidence-camera-input"]')
    const gallery = container.querySelector('[data-testid="driver-evidence-gallery-input"]')
    expect(camera).toBeTruthy()
    expect(gallery).toBeTruthy()
    expect(camera.multiple).toBe(true)
    expect(gallery.multiple).toBe(true)
    expect(camera.accept).toBe('image/*')
    expect(camera.getAttribute('capture')).toBe('environment')
    expect(useDriverPhotoUploadQueue).toHaveBeenCalled()
    expect(capturedQueueOptions.driverId).toBe('driver-id-aaa')
    expect(capturedQueueOptions.jobId).toBe('job-88')
    const files = [
      new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' }),
      new File([Uint8Array.from([2])], 'b.png', { type: 'image/png' }),
    ]
    Object.defineProperty(gallery, 'files', { value: files })
    const fetchesBefore = fetchCalls.length
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockEnqueueFiles).toHaveBeenCalledTimes(1)
    expect(mockEnqueueFiles.mock.calls[0][0]).toHaveLength(2)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Photos queued for upload.')
    expect(container.textContent).not.toContain('uploaded successfully')
    expect(container.textContent).not.toContain('Upload complete')
    expect(JSON.stringify(capturedQueueOptions)).not.toContain('p8-portal-token-SECRET')
    expect(fetchCalls.length).toBe(fetchesBefore)
    act(() => { root.unmount() })
  })

  test('local queue failure shows safe error and does not call target storage/insert', async () => {
    mockEnqueueFiles.mockResolvedValue({
      accepted: [],
      rejected: [{ fileName: 'a.jpg', code: 'QUEUE_WRITE_FAILED' }],
    })
    const { container, root } = await renderPortal()
    await openEvidenceTab(container)
    const gallery = container.querySelector('[data-testid="driver-evidence-gallery-input"]')
    Object.defineProperty(gallery, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    const afterOpen = galleryFetch.count
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Photos could not be queued for upload.')
    expect(galleryFetch.count).toBe(afterOpen)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('remote DONE for current job refreshes gallery; other job does not', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    await openEvidenceTab(container)
    const afterOpen = galleryFetch.count
    const gallery = container.querySelector('[data-testid="driver-evidence-gallery-input"]')
    Object.defineProperty(gallery, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      gallery.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(galleryFetch.count).toBe(afterOpen)
    await act(async () => {
      capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'job-99',
        status: 'DONE',
      })
    })
    expect(galleryFetch.count).toBe(afterOpen)
    await act(async () => {
      capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'job-88',
        status: 'DONE',
      })
    })
    expect(galleryFetch.count).toBe(afterOpen + 1)
    act(() => { root.unmount() })
  })

  test('reportMode is a distinct P10-owned surface isolated from Driver Evidence', async () => {
    const { container, root } = await renderPortal()
    const reportBtn = Array.from(container.querySelectorAll('button')).find((el) => el.textContent.trim() === '+ DEL Report')
    expect(reportBtn).toBeTruthy()
    await act(async () => { reportBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('Add collection photo')
    const reportInput = container.querySelector('[data-testid="driver-report-mode-photo-input"]')
    expect(reportInput).toBeTruthy()
    expect(reportInput.getAttribute('data-testid')).toBe('driver-report-mode-photo-input')
    expect(reportInput.getAttribute('data-testid')).not.toBe('driver-evidence-camera-input')
    expect(reportInput.getAttribute('data-testid')).not.toBe('driver-evidence-gallery-input')
    expect(container.querySelector('[data-testid="driver-evidence-camera-input"]')).toBeNull()
    expect(container.querySelector('[data-testid="driver-evidence-gallery-input"]')).toBeNull()
    act(() => { root.unmount() })
  })

  test('DriverReportTab is a distinct P10-owned surface isolated from Driver Evidence', async () => {
    const { container, root } = await renderPortal()
    await openEvidenceTab(container)
    const evidenceGallery = container.querySelector('[data-testid="driver-evidence-gallery-input"]')
    const evidenceCamera = container.querySelector('[data-testid="driver-evidence-camera-input"]')
    expect(evidenceGallery).toBeTruthy()
    expect(evidenceCamera).toBeTruthy()
    const reportTab = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Report')
    await act(async () => { reportTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('Report Submitted')
    const addPhoto = container.querySelector('[data-testid="driver-report-tab-photo-input"]')
    expect(addPhoto).toBeTruthy()
    expect(addPhoto.getAttribute('data-testid')).toBe('driver-report-tab-photo-input')
    expect(addPhoto).not.toBe(evidenceGallery)
    expect(addPhoto).not.toBe(evidenceCamera)
    expect(addPhoto.getAttribute('data-testid')).not.toBe('driver-evidence-gallery-input')
    expect(addPhoto.getAttribute('data-testid')).not.toBe('driver-evidence-camera-input')
    act(() => { root.unmount() })
  })
})

describe('DriverPortal driver evidence P11D queue status integration', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockEnqueueFiles.mockReset()
    mockUpload.mockReset()
    mockInsert.mockReset()
    mockManualUploadRetry.mockReset()
    mockManualDbRetry.mockReset()
    capturedQueueOptions = {}
    mockQueueRecords = []
    galleryFetch.count = 0
    fetchCalls.length = 0
    global.fetch = jest.fn((...args) => {
      fetchCalls.push(args)
      const url = String(args[0] || '')
      if (url.includes('/api/driver-portal-runs') && (!args[1] || args[1].method !== 'PATCH')) {
        return Promise.resolve({
          ok: true,
          json: async () => portalPayload(),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    useDriverPhotoUploadQueue.mockImplementation((options = {}) => {
      capturedQueueOptions = options
      return {
        enqueueFiles: mockEnqueueFiles,
        busy: false,
        lastResult: null,
        queueRecords: mockQueueRecords,
        manualUploadRetry: mockManualUploadRetry,
        manualDbRetry: mockManualDbRetry,
      }
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  function makeQueueRecord(status, lastError = null) {
    return {
      queue_id: 'q1',
      status,
      progress_pct: 0,
      source_surface: 'driver_evidence',
      entity_type: 'job',
      entity_id: 'job-88',
      provisional_id: null,
      created_at: Date.now(),
      last_error: lastError,
    }
  }

  test('renders QUEUED status from useDriverPhotoUploadQueue', async () => {
    mockQueueRecords = [makeQueueRecord('QUEUED')]
    const { container, root } = await renderPortal()
    await openEvidenceTab(container)
    expect(container.textContent).toContain('Queued')
    expect(container.querySelector('[data-testid="queue-retry-upload"]')).toBeNull()
    expect(container.querySelector('[data-testid="queue-retry-db"]')).toBeNull()
    act(() => { root.unmount() })
  })

  test('FAILED_UPLOAD shows upload retry button and calls manualUploadRetry', async () => {
    mockQueueRecords = [makeQueueRecord('FAILED_UPLOAD')]
    const { container, root } = await renderPortal()
    await openEvidenceTab(container)
    const button = container.querySelector('[data-testid="queue-retry-upload"]')
    expect(button).toBeTruthy()
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mockManualUploadRetry).toHaveBeenCalledWith('q1')
    act(() => { root.unmount() })
  })

  test('FAILED_DB shows DB retry button and calls manualDbRetry', async () => {
    mockQueueRecords = [makeQueueRecord('FAILED_DB')]
    const { container, root } = await renderPortal()
    await openEvidenceTab(container)
    const button = container.querySelector('[data-testid="queue-retry-db"]')
    expect(button).toBeTruthy()
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mockManualDbRetry).toHaveBeenCalledWith('q1')
    act(() => { root.unmount() })
  })

  test('DONE records are not persistently rendered', async () => {
    mockQueueRecords = [makeQueueRecord('DONE')]
    const { container, root } = await renderPortal()
    await openEvidenceTab(container)
    expect(container.querySelector('[data-testid="photo-upload-queue-status"]')).toBeNull()
    act(() => { root.unmount() })
  })

  test('raw error is not exposed in status UI', async () => {
    mockQueueRecords = [makeQueueRecord('FAILED_UPLOAD', { code: 'HTTP_500', message: 'secret-leak' })]
    const { container, root } = await renderPortal()
    await openEvidenceTab(container)
    expect(container.textContent).not.toContain('secret-leak')
    expect(container.textContent).not.toContain('HTTP_500')
    act(() => { root.unmount() })
  })
})

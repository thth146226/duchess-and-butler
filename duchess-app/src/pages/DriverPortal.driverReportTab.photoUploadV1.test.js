import { createRoot } from 'react-dom/client'
import { act } from 'react'
import DriverPortal from './DriverPortal'
import { useDriverPhotoUploadQueue } from '../hooks/useDriverPhotoUploadQueue'
import { useDriverReportPhotoUploadQueue } from '../hooks/useDriverReportPhotoUploadQueue'

jest.mock('../hooks/useDriverPhotoUploadQueue')
jest.mock('../hooks/useDriverReportPhotoUploadQueue', () => {
  const actual = jest.requireActual('../hooks/useDriverReportPhotoUploadQueue')
  return {
    ...actual,
    useDriverReportPhotoUploadQueue: jest.fn(),
  }
})
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
    chain.eq = jest.fn(() => {
      if (table === 'evidence_photos') {
        galleryFetch.count += 1
      }
      return chain
    })
    chain.in = jest.fn(() => Promise.resolve({ data: [] }))
    chain.order = jest.fn(() => Promise.resolve({ data: [] }))
    chain.insert = mockInsert
    chain.delete = jest.fn(() => chain)
    chain.maybeSingle = jest.fn(() => Promise.resolve({
      data: table === 'job_reports' && chain._select === '*'
        ? { id: 'report-77', run_type: 'DEL', driver_name: 'Pat', driver_notes: null, client_signature: null }
        : null,
    }))
    chain.then = (onFulfilled, onRejected) => {
      if (table === 'evidence_photos') {
        galleryFetch.count += 1
      }
      return Promise.resolve({ data: [] }).then(onFulfilled, onRejected)
    }
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

async function renderPortal() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<DriverPortal token="p10-portal-token-SECRET" />)
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { container, root }
}

async function openReportTab(container) {
  const view = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === 'View →')
  await act(async () => { view.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
  const reportTab = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Report')
  await act(async () => { reportTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
}

describe('DriverPortal DriverReportTab photo upload v1', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockEnqueueFiles.mockReset()
    mockManualUploadRetry.mockReset()
    mockManualDbRetry.mockReset()
    mockQueueRecords = []
    mockUpload.mockReset()
    mockInsert.mockReset()
    galleryFetch.count = 0
    capturedQueueOptions = {}
    mockEnqueueFiles.mockResolvedValue({ accepted: [], rejected: [] })
    global.fetch = jest.fn((...args) => {
      const url = String(args[0] || '')
      if (url.includes('/api/driver-portal-runs') && (!args[1] || args[1].method !== 'PATCH')) {
        return Promise.resolve({
          ok: true,
          json: async () => portalPayload(),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    useDriverPhotoUploadQueue.mockReturnValue({
      enqueueFiles: jest.fn(),
      busy: false,
      lastResult: null,
    })
    useDriverReportPhotoUploadQueue.mockImplementation((options = {}) => {
      if (options.sourceSurface === 'driver_report_tab') {
        capturedQueueOptions = options
      }
      return {
        enqueueFiles: mockEnqueueFiles,
        proveReportId: jest.fn(),
        markReportResultAmbiguous: jest.fn(),
        discardNeverUploadedDrafts: jest.fn(),
        manualUploadRetry: mockManualUploadRetry,
        manualDbRetry: mockManualDbRetry,
        queueRecords: mockQueueRecords,
        busy: false,
        lastResult: null,
      }
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('DriverReportTab still renders submitted report', async () => {
    const { container, root } = await renderPortal()
    await openReportTab(container)
    expect(container.textContent).toContain('Report Submitted')
    expect(container.querySelector('[data-testid="driver-report-tab-photo-input"]')).toBeTruthy()
    act(() => { root.unmount() })
  })

  test('uses exact report identity and driver actor', async () => {
    const { container, root } = await renderPortal()
    await openReportTab(container)
    expect(capturedQueueOptions.sourceSurface).toBe('driver_report_tab')
    expect(capturedQueueOptions.reportId).toBe('report-77')
    expect(capturedQueueOptions.driverId).toBe('driver-id-aaa')
    expect(capturedQueueOptions.driverId).not.toBe('report-77')
    expect(capturedQueueOptions.eventName).toBe('Gala')
    act(() => { root.unmount() })
  })

  test('selected file routes through P10 hook with no direct storage or evidence insert', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    await openReportTab(container)
    const input = container.querySelector('[data-testid="driver-report-tab-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'rep.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockEnqueueFiles).toHaveBeenCalledTimes(1)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Photos queued for upload.')
    expect(container.textContent).not.toContain('Photo uploaded')
    act(() => { root.unmount() })
  })

  test('current-report DONE refreshes then toasts Photo uploaded', async () => {
    const { container, root } = await renderPortal()
    await openReportTab(container)
    const afterOpen = galleryFetch.count
    await act(async () => {
      await capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'report-77',
        status: 'DONE',
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(galleryFetch.count).toBeGreaterThan(afterOpen)
    expect(container.textContent).toContain('Photo uploaded')
    act(() => { root.unmount() })
  })

  test('wrong report DONE does not refresh or toast success', async () => {
    const { container, root } = await renderPortal()
    await openReportTab(container)
    const afterOpen = galleryFetch.count
    await act(async () => {
      await capturedQueueOptions.onRemoteDone({
        queue_id: 'q-other',
        entity_id: 'report-OTHER',
        status: 'DONE',
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(galleryFetch.count).toBe(afterOpen)
    expect(container.textContent).not.toContain('Photo uploaded')
    act(() => { root.unmount() })
  })

  test('portal token is not persisted on queue options', async () => {
    const { container, root } = await renderPortal()
    await openReportTab(container)
    expect(JSON.stringify(capturedQueueOptions)).not.toContain('p10-portal-token-SECRET')
    act(() => { root.unmount() })
  })
})

describe('DriverPortal driver report tab P11D queue status integration', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockEnqueueFiles.mockReset()
    mockManualUploadRetry.mockReset()
    mockManualDbRetry.mockReset()
    mockQueueRecords = []
    mockUpload.mockReset()
    mockInsert.mockReset()
    galleryFetch.count = 0
    capturedQueueOptions = {}
    mockEnqueueFiles.mockResolvedValue({ accepted: [], rejected: [] })
    global.fetch = jest.fn((...args) => {
      const url = String(args[0] || '')
      if (url.includes('/api/driver-portal-runs') && (!args[1] || args[1].method !== 'PATCH')) {
        return Promise.resolve({
          ok: true,
          json: async () => portalPayload(),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    useDriverPhotoUploadQueue.mockReturnValue({
      enqueueFiles: jest.fn(),
      busy: false,
      lastResult: null,
    })
    useDriverReportPhotoUploadQueue.mockImplementation((options = {}) => {
      if (options.sourceSurface === 'driver_report_tab') {
        capturedQueueOptions = options
      }
      return {
        enqueueFiles: mockEnqueueFiles,
        proveReportId: jest.fn(),
        markReportResultAmbiguous: jest.fn(),
        discardNeverUploadedDrafts: jest.fn(),
        manualUploadRetry: mockManualUploadRetry,
        manualDbRetry: mockManualDbRetry,
        queueRecords: mockQueueRecords,
        busy: false,
        lastResult: null,
      }
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  function makeRecord(status, lastError = null) {
    return {
      queue_id: 'q1',
      status,
      progress_pct: 0,
      source_surface: 'driver_report_tab',
      entity_type: 'report',
      entity_id: 'report-77',
      provisional_id: null,
      created_at: Date.now(),
      last_error: lastError,
    }
  }

  test('renders QUEUED status from useDriverReportPhotoUploadQueue', async () => {
    mockQueueRecords = [makeRecord('QUEUED')]
    const { container, root } = await renderPortal()
    await openReportTab(container)
    expect(container.textContent).toContain('Queued')
    expect(container.querySelector('[data-testid="queue-retry-upload"]')).toBeFalsy()
    expect(container.querySelector('[data-testid="queue-retry-db"]')).toBeFalsy()
    act(() => { root.unmount() })
  })

  test('FAILED_UPLOAD shows upload retry button and calls manualUploadRetry', async () => {
    mockQueueRecords = [makeRecord('FAILED_UPLOAD')]
    const { container, root } = await renderPortal()
    await openReportTab(container)
    const button = container.querySelector('[data-testid="queue-retry-upload"]')
    expect(button).toBeTruthy()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(mockManualUploadRetry).toHaveBeenCalledWith('q1')
    act(() => { root.unmount() })
  })

  test('FAILED_DB shows DB retry button and calls manualDbRetry', async () => {
    mockQueueRecords = [makeRecord('FAILED_DB')]
    const { container, root } = await renderPortal()
    await openReportTab(container)
    const button = container.querySelector('[data-testid="queue-retry-db"]')
    expect(button).toBeTruthy()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(mockManualDbRetry).toHaveBeenCalledWith('q1')
    act(() => { root.unmount() })
  })

  test('DONE records are not persistently rendered', async () => {
    mockQueueRecords = [makeRecord('DONE')]
    const { container, root } = await renderPortal()
    await openReportTab(container)
    expect(container.querySelector('[data-testid="photo-upload-queue-status"]')).toBeFalsy()
    act(() => { root.unmount() })
  })

  test('raw error is not exposed in status UI', async () => {
    mockQueueRecords = [makeRecord('FAILED_UPLOAD', { code: 'HTTP_500', message: 'secret-leak' })]
    const { container, root } = await renderPortal()
    await openReportTab(container)
    expect(container.textContent).not.toContain('secret-leak')
    expect(container.textContent).not.toContain('HTTP_500')
    act(() => { root.unmount() })
  })
})

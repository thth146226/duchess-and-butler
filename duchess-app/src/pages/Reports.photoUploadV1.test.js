import { createRoot } from 'react-dom/client'
import { act } from 'react'
import Reports from './Reports'
import { useOfficeReportPhotoUploadQueue } from '../hooks/useOfficeReportPhotoUploadQueue'

jest.mock('../hooks/useOfficeReportPhotoUploadQueue')
jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'profile-uuid-NOT-session', name: 'Admin Ada' },
  }),
}))

const mockUpload = jest.fn()
const mockInsert = jest.fn()
const mockJobReportsInsert = jest.fn()
const galleryFetch = { count: 0 }
const refreshProbe = { readToast: null, toastVisibleDuringRefresh: null }
let capturedQueueOptions = {}
let mockQueueRecords = []

jest.mock('../lib/supabase', () => {
  const report = {
    id: 'report-44',
    event_name: 'Gala',
    crms_ref: 'CRMS-9',
    driver_name: 'Pat',
    run_type: 'COL',
    status: 'submitted',
    created_at: '2026-01-01T00:00:00.000Z',
  }
  function makeChain(table) {
    const chain = {}
    chain.select = jest.fn(() => chain)
    chain.eq = jest.fn(() => chain)
    chain.order = jest.fn(() => {
      if (table === 'job_reports') {
        return Promise.resolve({ data: [report] })
      }
      if (table === 'evidence_photos') {
        galleryFetch.count += 1
      }
      return Promise.resolve({ data: [] })
    })
    chain.insert = table === 'job_reports' ? mockJobReportsInsert : mockInsert
    chain.delete = jest.fn(() => chain)
    chain.single = jest.fn(() => Promise.resolve({ data: report, error: null }))
    chain.or = jest.fn(() => chain)
    chain.limit = jest.fn(() => Promise.resolve({ data: [] }))
    chain.then = (onFulfilled, onRejected) => {
      if (table === 'evidence_photos') {
        galleryFetch.count += 1
        if (typeof refreshProbe.readToast === 'function') {
          refreshProbe.toastVisibleDuringRefresh = refreshProbe.readToast()
        }
      }
      const payload = table === 'job_reports'
        ? { data: [report] }
        : { data: [] }
      return Promise.resolve(payload).then(onFulfilled, onRejected)
    }
    return chain
  }
  return {
    supabase: {
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
    },
  }
})

const mockEnqueueFiles = jest.fn()
const mockManualUploadRetry = jest.fn()
const mockManualDbRetry = jest.fn()

async function renderReports() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Reports />)
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { container, root }
}

async function openFirstReport(container) {
  const row = container.querySelector('[data-testid="office-reports-row-report-44"]')
  expect(row).toBeTruthy()
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

describe('Reports photo upload v1', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockUpload.mockReset()
    mockInsert.mockReset()
    mockJobReportsInsert.mockReset()
    mockEnqueueFiles.mockReset()
    mockManualUploadRetry.mockReset()
    mockManualDbRetry.mockReset()
    galleryFetch.count = 0
    refreshProbe.readToast = null
    refreshProbe.toastVisibleDuringRefresh = null
    capturedQueueOptions = {}
    mockQueueRecords = []
    mockEnqueueFiles.mockResolvedValue({ accepted: [], rejected: [] })
    useOfficeReportPhotoUploadQueue.mockImplementation((options) => {
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

  test('existing report UI still renders', async () => {
    const { container, root } = await renderReports()
    expect(container.textContent).toContain('Gala')
    expect(container.textContent).toContain('+ New Report')
    act(() => { root.unmount() })
  })

  test('target file selection uses P9 hook with MODE_A report id', async () => {
    const { container, root } = await renderReports()
    await openFirstReport(container)
    const input = container.querySelector('[data-testid="office-reports-photo-input"]')
    expect(input).toBeTruthy()
    expect(input.multiple).toBe(true)
    expect(capturedQueueOptions.sourceSurface).toBe('office_reports')
    expect(capturedQueueOptions.reportId).toBe('report-44')
    expect(capturedQueueOptions.eventName).toBe('Gala')
    expect(capturedQueueOptions.crmsRef).toBe('CRMS-9')
    expect(capturedQueueOptions.profile.name).toBe('Admin Ada')
    const files = [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })]
    Object.defineProperty(input, 'files', { value: files })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockEnqueueFiles).toHaveBeenCalledTimes(1)
    expect(mockEnqueueFiles.mock.calls[0][0]).toHaveLength(1)
    act(() => { root.unmount() })
  })

  test('direct target Storage upload and evidence_photos insert are zero', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderReports()
    await openFirstReport(container)
    const input = container.querySelector('[data-testid="office-reports-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('photo queue does not create a business report', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderReports()
    await openFirstReport(container)
    const input = container.querySelector('[data-testid="office-reports-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockJobReportsInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('report business creation UI remains on existing authority', async () => {
    const { container, root } = await renderReports()
    const create = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '+ New Report')
    await act(async () => {
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Create report')
    expect(container.textContent).toContain('Submit Report')
    act(() => { root.unmount() })
  })

  test('local durable acceptance is not remote completion', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderReports()
    await openFirstReport(container)
    const afterOpen = galleryFetch.count
    const input = container.querySelector('[data-testid="office-reports-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Photos queued for upload.')
    expect(container.textContent).not.toContain('Photo uploaded')
    expect(galleryFetch.count).toBe(afterOpen)
    act(() => { root.unmount() })
  })

  test('MODE_A surface does not introduce a draft provisional flow', async () => {
    const { container, root } = await renderReports()
    await openFirstReport(container)
    expect(capturedQueueOptions.reportId).toBe('report-44')
    expect(capturedQueueOptions.provisionalId).toBeUndefined()
    act(() => { root.unmount() })
  })

  test('legacy metadata expressions are passed through the hook', async () => {
    const { container, root } = await renderReports()
    await openFirstReport(container)
    expect(capturedQueueOptions.eventName).toBe('Gala')
    expect(capturedQueueOptions.crmsRef).toBe('CRMS-9')
    expect(capturedQueueOptions.profile).toEqual({ id: 'profile-uuid-NOT-session', name: 'Admin Ada' })
    act(() => { root.unmount() })
  })

  test('remote DONE for current report refreshes photos then toasts Photo uploaded', async () => {
    const { container, root } = await renderReports()
    await openFirstReport(container)
    const afterOpen = galleryFetch.count
    refreshProbe.readToast = () => container.textContent.includes('Photo uploaded')
    await act(async () => {
      await capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'report-44',
        status: 'DONE',
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(galleryFetch.count).toBeGreaterThan(afterOpen)
    expect(refreshProbe.toastVisibleDuringRefresh).toBe(false)
    expect(container.textContent).toContain('Photo uploaded')
    act(() => { root.unmount() })
  })

  test('one current-report DONE yields one success toast', async () => {
    const { container, root } = await renderReports()
    await openFirstReport(container)
    await act(async () => {
      await capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'report-44',
        status: 'DONE',
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent.match(/Photo uploaded/g) || []).toHaveLength(1)
    act(() => { root.unmount() })
  })

  test('unrelated DONE does not refresh current report or toast success', async () => {
    const { container, root } = await renderReports()
    await openFirstReport(container)
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

  test('unrelated report list behavior remains', async () => {
    const { container, root } = await renderReports()
    expect(container.textContent).toContain('1 report')
    expect(container.textContent).toContain('Pat')
    act(() => { root.unmount() })
  })
})

describe('Reports office reports P11D queue status integration', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockUpload.mockReset()
    mockInsert.mockReset()
    mockJobReportsInsert.mockReset()
    mockEnqueueFiles.mockReset()
    mockManualUploadRetry.mockReset()
    mockManualDbRetry.mockReset()
    galleryFetch.count = 0
    refreshProbe.readToast = null
    refreshProbe.toastVisibleDuringRefresh = null
    capturedQueueOptions = {}
    mockQueueRecords = []
    mockEnqueueFiles.mockResolvedValue({ accepted: [], rejected: [] })
    useOfficeReportPhotoUploadQueue.mockImplementation((options) => {
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

  test('renders QUEUED status from useOfficeReportPhotoUploadQueue', async () => {
    mockQueueRecords = [
      {
        queue_id: 'q1',
        status: 'QUEUED',
        progress_pct: 0,
        source_surface: 'office_reports',
        entity_type: 'report',
        entity_id: 'report-44',
        provisional_id: null,
        created_at: Date.now(),
        last_error: null,
      },
    ]
    const { container, root } = await renderReports()
    await openFirstReport(container)
    expect(container.textContent).toContain('Queued')
    expect(container.querySelector('[data-testid="queue-retry-upload"]')).not.toBeTruthy()
    expect(container.querySelector('[data-testid="queue-retry-db"]')).not.toBeTruthy()
    act(() => { root.unmount() })
  })

  test('FAILED_UPLOAD shows upload retry button and calls manualUploadRetry', async () => {
    mockQueueRecords = [
      {
        queue_id: 'q1',
        status: 'FAILED_UPLOAD',
        progress_pct: 0,
        source_surface: 'office_reports',
        entity_type: 'report',
        entity_id: 'report-44',
        provisional_id: null,
        created_at: Date.now(),
        last_error: null,
      },
    ]
    const { container, root } = await renderReports()
    await openFirstReport(container)
    const retryButton = container.querySelector('[data-testid="queue-retry-upload"]')
    expect(retryButton).toBeTruthy()
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mockManualUploadRetry).toHaveBeenCalledWith('q1')
    act(() => { root.unmount() })
  })

  test('FAILED_DB shows DB retry button and calls manualDbRetry', async () => {
    mockQueueRecords = [
      {
        queue_id: 'q1',
        status: 'FAILED_DB',
        progress_pct: 0,
        source_surface: 'office_reports',
        entity_type: 'report',
        entity_id: 'report-44',
        provisional_id: null,
        created_at: Date.now(),
        last_error: null,
      },
    ]
    const { container, root } = await renderReports()
    await openFirstReport(container)
    const retryButton = container.querySelector('[data-testid="queue-retry-db"]')
    expect(retryButton).toBeTruthy()
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mockManualDbRetry).toHaveBeenCalledWith('q1')
    act(() => { root.unmount() })
  })

  test('DONE records are not persistently rendered', async () => {
    mockQueueRecords = [
      {
        queue_id: 'q1',
        status: 'DONE',
        progress_pct: 100,
        source_surface: 'office_reports',
        entity_type: 'report',
        entity_id: 'report-44',
        provisional_id: null,
        created_at: Date.now(),
        last_error: null,
      },
    ]
    const { container, root } = await renderReports()
    await openFirstReport(container)
    expect(container.querySelector('[data-testid="photo-upload-queue-status"]')).not.toBeTruthy()
    act(() => { root.unmount() })
  })

  test('raw error is not exposed in status UI', async () => {
    mockQueueRecords = [
      {
        queue_id: 'q1',
        status: 'FAILED_UPLOAD',
        progress_pct: 0,
        source_surface: 'office_reports',
        entity_type: 'report',
        entity_id: 'report-44',
        provisional_id: null,
        created_at: Date.now(),
        last_error: { code: 'HTTP_500', message: 'secret-leak' },
      },
    ]
    const { container, root } = await renderReports()
    await openFirstReport(container)
    expect(container.textContent).not.toContain('secret-leak')
    expect(container.textContent).not.toContain('HTTP_500')
    act(() => { root.unmount() })
  })
})

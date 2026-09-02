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
  const mockJobReportsInsert = jest.fn()
  const galleryFetch = { count: 0 }
  const insertResult = { data: { id: 'report-created-1' }, error: null }
  const jobReportsControl = { hangSingle: false }
  function makeChain(table) {
    const chain = {}
    chain.select = jest.fn((cols) => {
      chain._select = cols
      return chain
    })
    chain.eq = jest.fn(() => chain)
    chain.in = jest.fn(() => Promise.resolve({ data: [] }))
    chain.order = jest.fn(() => Promise.resolve({ data: [] }))
    chain.insert = jest.fn((payload) => {
      if (table === 'job_reports') {
        mockJobReportsInsert(payload)
        return chain
      }
      mockInsert(payload)
      return chain
    })
    chain.delete = jest.fn(() => chain)
    chain.maybeSingle = jest.fn(() => Promise.resolve({ data: null }))
    chain.single = jest.fn(() => {
      if (jobReportsControl.hangSingle) {
        return new Promise(() => {})
      }
      return Promise.resolve({
        data: insertResult.data,
        error: insertResult.error,
      })
    })
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
    mockJobReportsInsert,
    galleryFetch,
    insertResult,
    jobReportsControl,
  }
})

const { mockUpload, mockInsert, mockJobReportsInsert, insertResult, jobReportsControl } = jest.requireMock('@supabase/supabase-js')
const mockEnqueueFiles = jest.fn()
const mockProveReportId = jest.fn()
const mockMarkAmbiguous = jest.fn()
const mockDiscardNeverUploadedDrafts = jest.fn()
const fetchCalls = []
let capturedQueueOptions = {}

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

async function openReportMode(container) {
  const reportBtn = Array.from(container.querySelectorAll('button')).find((el) => el.textContent.trim() === '+ DEL Report')
  expect(reportBtn).toBeTruthy()
  await act(async () => { reportBtn.click() })
  await act(async () => { await Promise.resolve() })
}

async function queueReportModePhoto(container) {
  const input = container.querySelector('[data-testid="driver-report-mode-photo-input"]')
  expect(input).toBeTruthy()
  Object.defineProperty(input, 'files', {
    value: [new File([Uint8Array.from([1])], 'col.jpg', { type: 'image/jpeg' })],
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function findBackButton(container) {
  return Array.from(container.querySelectorAll('button')).find((el) => el.textContent.includes('Back'))
}

describe('DriverPortal reportMode photo upload v1', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockEnqueueFiles.mockReset()
    mockProveReportId.mockReset()
    mockMarkAmbiguous.mockReset()
    mockDiscardNeverUploadedDrafts.mockReset()
    mockUpload.mockReset()
    mockInsert.mockReset()
    mockJobReportsInsert.mockReset()
    insertResult.data = { id: 'report-created-1' }
    insertResult.error = null
    jobReportsControl.hangSingle = false
    capturedQueueOptions = {}
    fetchCalls.length = 0
    mockEnqueueFiles.mockResolvedValue({ accepted: [], rejected: [] })
    mockProveReportId.mockResolvedValue({ linked: [], failed: [] })
    mockMarkAmbiguous.mockResolvedValue({ updated: [], failed: [] })
    mockDiscardNeverUploadedDrafts.mockResolvedValue({ ok: true, deleted: [] })
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
    useDriverPhotoUploadQueue.mockReturnValue({
      enqueueFiles: jest.fn(),
      busy: false,
      lastResult: null,
    })
    useDriverReportPhotoUploadQueue.mockImplementation((options = {}) => {
      capturedQueueOptions = options
      return {
        enqueueFiles: mockEnqueueFiles,
        proveReportId: mockProveReportId,
        markReportResultAmbiguous: mockMarkAmbiguous,
        discardNeverUploadedDrafts: mockDiscardNeverUploadedDrafts,
        busy: false,
        lastResult: null,
      }
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('reportMode still renders collection photo UI', async () => {
    const { container, root } = await renderPortal()
    await openReportMode(container)
    expect(container.textContent).toContain('DEL Report')
    expect(container.textContent).toContain('Add collection photo')
    expect(container.textContent).toContain('Submit Report')
    act(() => { root.unmount() })
  })

  test('photos can be selected before report creation and route through P10 hook', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    const input = container.querySelector('[data-testid="driver-report-mode-photo-input"]')
    expect(input).toBeTruthy()
    expect(input.multiple).toBe(false)
    expect(input.accept).toBe('image/*')
    expect(input.getAttribute('capture')).toBe('environment')
    expect(capturedQueueOptions.sourceSurface).toBe('driver_report_mode')
    expect(capturedQueueOptions.driverId).toBe('driver-id-aaa')
    expect(capturedQueueOptions.reportId).toBeUndefined()
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'col.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockEnqueueFiles).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Photos queued for upload.')
    expect(container.textContent).not.toContain('Photo uploaded')
    act(() => { root.unmount() })
  })

  test('selection does not create temp storage objects or evidence rows', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    const input = container.querySelector('[data-testid="driver-report-mode-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'col.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    expect(JSON.stringify(mockUpload.mock.calls)).not.toContain('reports/temp_')
    act(() => { root.unmount() })
  })

  test('business report creation remains submitReport and is called once', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    const input = container.querySelector('[data-testid="driver-report-mode-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'col.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockJobReportsInsert).not.toHaveBeenCalled()
    const submit = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Submit Report')
    await act(async () => { submit.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockJobReportsInsert).toHaveBeenCalledTimes(1)
    expect(mockProveReportId).toHaveBeenCalledWith('report-created-1')
    expect(mockDiscardNeverUploadedDrafts).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('portal token never enters queue options', async () => {
    const { container, root } = await renderPortal()
    await openReportMode(container)
    expect(JSON.stringify(capturedQueueOptions)).not.toContain('p10-portal-token-SECRET')
    act(() => { root.unmount() })
  })

  test('back cancel clears UI and does not upload bytes', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    const input = container.querySelector('[data-testid="driver-report-mode-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'col.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const back = findBackButton(container)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockDiscardNeverUploadedDrafts).toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Add collection photo')
    act(() => { root.unmount() })
  })

  test('definitive report creation error does not prove id or upload bytes', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    insertResult.data = null
    insertResult.error = { message: 'insert failed' }
    const { container, root } = await renderPortal()
    await openReportMode(container)
    const input = container.querySelector('[data-testid="driver-report-mode-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'col.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const submit = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Submit Report')
    await act(async () => { submit.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockProveReportId).not.toHaveBeenCalled()
    expect(mockMarkAmbiguous).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('ambiguous report result marks drafts unknown and does not upload bytes', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    insertResult.data = {}
    insertResult.error = null
    const { container, root } = await renderPortal()
    await openReportMode(container)
    const input = container.querySelector('[data-testid="driver-report-mode-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'col.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const submit = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Submit Report')
    await act(async () => { submit.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockProveReportId).not.toHaveBeenCalled()
    expect(mockMarkAmbiguous).toHaveBeenCalled()
    expect(mockDiscardNeverUploadedDrafts).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('reportMode remains MODE_B and file selection still creates a local draft path', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    expect(capturedQueueOptions.sourceSurface).toBe('driver_report_mode')
    expect(capturedQueueOptions.reportId).toBeUndefined()
    await queueReportModePhoto(container)
    expect(mockEnqueueFiles).toHaveBeenCalledTimes(1)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(JSON.stringify(mockUpload.mock.calls)).not.toContain('reports/temp_')
    act(() => { root.unmount() })
  })

  test('back with no photos exits normally without deleting rows', async () => {
    const { container, root } = await renderPortal()
    await openReportMode(container)
    const provisionalId = capturedQueueOptions.provisionalId
    expect(provisionalId).toBeTruthy()
    const back = findBackButton(container)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockDiscardNeverUploadedDrafts).toHaveBeenCalledWith({ provisionalId })
    expect(container.textContent).not.toContain('Add collection photo')
    expect(container.textContent).toContain('+ DEL Report')
    act(() => { root.unmount() })
  })

  test('back after a safe draft discards current provisional id before UI reset', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    await queueReportModePhoto(container)
    const provisionalId = capturedQueueOptions.provisionalId
    mockDiscardNeverUploadedDrafts.mockImplementation(async (args) => {
      expect(args).toEqual({ provisionalId })
      expect(container.textContent).toContain('Add collection photo')
      expect(container.querySelector('img')).toBeTruthy()
      expect(capturedQueueOptions.provisionalId).toBe(provisionalId)
      return { ok: true, deleted: ['q1'] }
    })
    const back = findBackButton(container)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockDiscardNeverUploadedDrafts).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Add collection photo')
    expect(container.querySelector('img')).toBeFalsy()
    expect(capturedQueueOptions.provisionalId == null).toBe(true)
    act(() => { root.unmount() })
  })

  test('successful safe cleanup exits reportMode and clears previews and submittedReportId', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    mockDiscardNeverUploadedDrafts.mockResolvedValue({ ok: true, deleted: ['q1'] })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    await queueReportModePhoto(container)
    expect(container.querySelector('img')).toBeTruthy()
    const back = findBackButton(container)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).not.toContain('Add collection photo')
    expect(container.querySelector('img')).toBeFalsy()
    await openReportMode(container)
    expect(container.querySelector('img')).toBeFalsy()
    act(() => { root.unmount() })
  })

  test('back during photo enqueue busy does not discard', async () => {
    useDriverReportPhotoUploadQueue.mockImplementation((options = {}) => {
      capturedQueueOptions = options
      return {
        enqueueFiles: mockEnqueueFiles,
        proveReportId: mockProveReportId,
        markReportResultAmbiguous: mockMarkAmbiguous,
        discardNeverUploadedDrafts: mockDiscardNeverUploadedDrafts,
        busy: true,
        lastResult: null,
      }
    })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    const back = findBackButton(container)
    expect(back.disabled).toBe(true)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockDiscardNeverUploadedDrafts).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Queuing…')
    expect(container.textContent).toContain('DEL Report')
    act(() => { root.unmount() })
  })

  test('back during report submit busy does not discard', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    jobReportsControl.hangSingle = true
    const { container, root } = await renderPortal()
    await openReportMode(container)
    await queueReportModePhoto(container)
    const submit = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Submit Report')
    await act(async () => { submit.click() })
    await act(async () => { await Promise.resolve() })
    const back = findBackButton(container)
    expect(back.disabled).toBe(true)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockDiscardNeverUploadedDrafts).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Add collection photo')
    expect(mockProveReportId).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('unsafe back result does not exit and preserves provisional id and previews', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    mockDiscardNeverUploadedDrafts.mockResolvedValue({
      ok: false,
      deleted: [],
      code: 'UNSAFE_COMPOSITION',
    })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    await queueReportModePhoto(container)
    const provisionalId = capturedQueueOptions.provisionalId
    const back = findBackButton(container)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('Add collection photo')
    expect(container.querySelector('img')).toBeTruthy()
    expect(capturedQueueOptions.provisionalId).toBe(provisionalId)
    expect(container.textContent).toContain('Queued photos are still being processed. Please try again.')
    expect(mockDiscardNeverUploadedDrafts).toHaveBeenCalledWith({ provisionalId })
    act(() => { root.unmount() })
  })

  test('local delete failure does not claim success or exit reportMode', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    mockDiscardNeverUploadedDrafts.mockResolvedValue({
      ok: false,
      deleted: [],
      code: 'QUEUE_WRITE_FAILED',
    })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    await queueReportModePhoto(container)
    const provisionalId = capturedQueueOptions.provisionalId
    const back = findBackButton(container)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('Add collection photo')
    expect(container.querySelector('img')).toBeTruthy()
    expect(capturedQueueOptions.provisionalId).toBe(provisionalId)
    expect(container.textContent).not.toContain('Report submitted successfully')
    expect(mockUpload).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('REPORT_LINK_UNKNOWN back stays fail-closed and does not delete', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    insertResult.data = {}
    insertResult.error = null
    mockDiscardNeverUploadedDrafts.mockResolvedValue({
      ok: false,
      deleted: [],
      code: 'UNSAFE_COMPOSITION',
    })
    const { container, root } = await renderPortal()
    await openReportMode(container)
    await queueReportModePhoto(container)
    const submit = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Submit Report')
    await act(async () => { submit.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockMarkAmbiguous).toHaveBeenCalled()
    const provisionalId = capturedQueueOptions.provisionalId
    const back = findBackButton(container)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockDiscardNeverUploadedDrafts).toHaveBeenCalledWith({ provisionalId })
    expect(container.textContent).toContain('Add collection photo')
    expect(capturedQueueOptions.provisionalId).toBe(provisionalId)
    act(() => { root.unmount() })
  })

  test('DriverReportTab and Driver Evidence are not the reportMode discard surface', async () => {
    const { container, root } = await renderPortal()
    await openReportMode(container)
    expect(capturedQueueOptions.sourceSurface).toBe('driver_report_mode')
    expect(capturedQueueOptions.sourceSurface).not.toBe('driver_report_tab')
    expect(capturedQueueOptions.sourceSurface).not.toBe('driver_evidence')
    const back = findBackButton(container)
    await act(async () => { back.click() })
    await act(async () => { await Promise.resolve() })
    expect(mockDiscardNeverUploadedDrafts).toHaveBeenCalledTimes(1)
    act(() => { root.unmount() })
  })
})

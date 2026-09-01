import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ReportTab } from './Schedule'
import { useOfficeReportPhotoUploadQueue } from '../hooks/useOfficeReportPhotoUploadQueue'

jest.mock('../hooks/useOfficeReportPhotoUploadQueue')
jest.mock('../components/EvidenceUpload', () => () => <div>office-evidence-untouched</div>)
jest.mock('../components/JobNotes', () => () => <div>job-notes-untouched</div>)

const mockUpload = jest.fn()
const mockInsert = jest.fn()
const mockJobReportsInsert = jest.fn(() => ({
  select: () => ({
    single: () => Promise.resolve({ data: { id: 'new-report' }, error: null }),
  }),
}))
const galleryFetch = { count: 0 }
const uxSequence = []
let capturedQueueOptions = {}
const mockEnqueueFiles = jest.fn()

function makeSupabase({ hasReport = true } = {}) {
  const report = hasReport
    ? {
      id: 'report-77',
      driver_name: 'Pat',
      submitted_at: '2026-01-01T00:00:00.000Z',
      driver_notes: null,
      client_signature: null,
      job_report_items: [],
    }
    : null
  function makeChain(table) {
    const chain = {}
    chain.select = jest.fn(() => chain)
    chain.eq = jest.fn(() => chain)
    chain.maybeSingle = jest.fn(() => Promise.resolve({ data: table === 'job_reports' ? report : null }))
    chain.insert = table === 'job_reports' ? mockJobReportsInsert : mockInsert
    chain.delete = jest.fn(() => chain)
    chain.then = (onFulfilled, onRejected) => {
      if (table === 'evidence_photos') {
        galleryFetch.count += 1
        uxSequence.push({ type: 'refresh', gallery: galleryFetch.count })
      }
      return Promise.resolve({ data: table === 'evidence_photos' ? [] : [] }).then(onFulfilled, onRejected)
    }
    return chain
  }
  return {
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
  }
}

const job = {
  id: 'job-88',
  event_name: 'Gala',
  crms_ref: 'CRMS-9',
}

async function renderTab(overrides = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const showToast = overrides.showToast || jest.fn()
  const supabase = overrides.supabase || makeSupabase(overrides)
  await act(async () => {
    root.render(
      <ReportTab
        job={job}
        runType="COL"
        profile={{ id: 'profile-uuid-NOT-session', name: 'Admin Ada' }}
        supabase={supabase}
        showToast={showToast}
      />,
    )
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { container, root, showToast, supabase }
}

describe('Schedule ReportTab photo upload v1', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockUpload.mockReset()
    mockInsert.mockReset()
    mockJobReportsInsert.mockClear()
    mockEnqueueFiles.mockReset()
    galleryFetch.count = 0
    uxSequence.length = 0
    capturedQueueOptions = {}
    mockEnqueueFiles.mockResolvedValue({ accepted: [], rejected: [] })
    useOfficeReportPhotoUploadQueue.mockImplementation((options) => {
      capturedQueueOptions = options
      return { enqueueFiles: mockEnqueueFiles, busy: false, lastResult: null }
    })
  })

  test('ReportTab still renders submitted report', async () => {
    const { container, root } = await renderTab()
    expect(container.textContent).toContain('COL Report Submitted')
    expect(container.textContent).toContain('Collection Photos')
    act(() => { root.unmount() })
  })

  test('only ReportTab photo path uses P9 hook with schedule source', async () => {
    const { container, root } = await renderTab()
    const input = container.querySelector('[data-testid="office-schedule-report-photo-input"]')
    expect(input).toBeTruthy()
    expect(input.multiple).toBe(false)
    expect(capturedQueueOptions.sourceSurface).toBe('office_schedule_report')
    expect(capturedQueueOptions.reportId).toBe('report-77')
    expect(capturedQueueOptions.eventName).toBe('Gala')
    expect(capturedQueueOptions.crmsRef).toBe('CRMS-9')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockEnqueueFiles).toHaveBeenCalledTimes(1)
    act(() => { root.unmount() })
  })

  test('target direct Storage upload and evidence_photos insert are zero', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderTab()
    const input = container.querySelector('[data-testid="office-schedule-report-photo-input"]')
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

  test('ReportTab does not render office evidence or other schedule tabs', async () => {
    const { container, root } = await renderTab()
    expect(container.textContent).not.toContain('office-evidence-untouched')
    expect(container.textContent).not.toContain('job-notes-untouched')
    expect(container.querySelector('[data-testid="office-schedule-report-photo-input"]')).toBeTruthy()
    act(() => { root.unmount() })
  })

  test('empty report still offers Create Report through existing authority', async () => {
    const { container, root } = await renderTab({ hasReport: false })
    expect(container.textContent).toContain('No COL report yet for this job.')
    expect(container.textContent).toContain('+ Create COL Report')
    const create = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '+ Create COL Report')
    await act(async () => {
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('COL Report — Gala')
    act(() => { root.unmount() })
  })

  test('photo queue does not insert a job_reports row', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const { container, root } = await renderTab()
    const input = container.querySelector('[data-testid="office-schedule-report-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mockJobReportsInsert).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('local acceptance does not imply remote completion', async () => {
    mockEnqueueFiles.mockResolvedValue({ accepted: [{ queueId: 'q1' }], rejected: [] })
    const showToast = jest.fn()
    const { container, root } = await renderTab({ showToast })
    const afterMount = galleryFetch.count
    const input = container.querySelector('[data-testid="office-schedule-report-photo-input"]')
    Object.defineProperty(input, 'files', {
      value: [new File([Uint8Array.from([1])], 'a.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(showToast).toHaveBeenCalledWith('Photos queued for upload.')
    expect(showToast).not.toHaveBeenCalledWith('Photo uploaded')
    expect(galleryFetch.count).toBe(afterMount)
    act(() => { root.unmount() })
  })

  test('exact report-id linkage is MODE_A at selection', async () => {
    const { container, root } = await renderTab()
    expect(capturedQueueOptions.reportId).toBe('report-77')
    expect(capturedQueueOptions.provisionalId).toBeUndefined()
    expect(container.querySelector('[data-testid="office-schedule-report-photo-input"]')).toBeTruthy()
    act(() => { root.unmount() })
  })

  test('ambiguous result does not upload because this surface never selects before report id', async () => {
    const { container, root } = await renderTab({ hasReport: false })
    expect(container.querySelector('[data-testid="office-schedule-report-photo-input"]')).toBeNull()
    expect(mockUpload).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  test('metadata preserved from job and profile', async () => {
    const { root } = await renderTab()
    expect(capturedQueueOptions.eventName).toBe('Gala')
    expect(capturedQueueOptions.crmsRef).toBe('CRMS-9')
    expect(capturedQueueOptions.profile.name).toBe('Admin Ada')
    act(() => { root.unmount() })
  })

  test('remote DONE for current report refreshes photos then toasts Photo uploaded', async () => {
    const showToast = jest.fn((msg) => {
      uxSequence.push({ type: 'toast', msg, gallery: galleryFetch.count })
    })
    const { root } = await renderTab({ showToast })
    const afterMount = galleryFetch.count
    const before = uxSequence.length
    await act(async () => {
      await capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'report-77',
        status: 'DONE',
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(galleryFetch.count).toBeGreaterThan(afterMount)
    const after = uxSequence.slice(before)
    expect(after[0]).toEqual(expect.objectContaining({ type: 'refresh' }))
    expect(after[1]).toEqual(expect.objectContaining({ type: 'toast', msg: 'Photo uploaded' }))
    expect(showToast).toHaveBeenCalledWith('Photo uploaded')
    act(() => { root.unmount() })
  })

  test('one current-report DONE yields one success toast', async () => {
    const showToast = jest.fn()
    const { root } = await renderTab({ showToast })
    await act(async () => {
      await capturedQueueOptions.onRemoteDone({
        queue_id: 'q1',
        entity_id: 'report-77',
        status: 'DONE',
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(showToast.mock.calls.filter((call) => call[0] === 'Photo uploaded')).toHaveLength(1)
    act(() => { root.unmount() })
  })

  test('wrong report DONE does not refresh current report or toast success', async () => {
    const showToast = jest.fn()
    const { root } = await renderTab({ showToast })
    const afterMount = galleryFetch.count
    await act(async () => {
      await capturedQueueOptions.onRemoteDone({
        queue_id: 'q-other',
        entity_id: 'report-OTHER',
        status: 'DONE',
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(galleryFetch.count).toBe(afterMount)
    expect(showToast).not.toHaveBeenCalledWith('Photo uploaded')
    act(() => { root.unmount() })
  })
})

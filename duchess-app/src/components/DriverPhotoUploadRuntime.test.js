import { createRoot } from 'react-dom/client'
import { act } from 'react'
import DriverPhotoUploadRuntime from './DriverPhotoUploadRuntime'

const mockRetain = jest.fn()
const mockSchedule = jest.fn()

jest.mock('../lib/driverUploadSession', () => ({
  retainDriverUploadRuntime: (...args) => mockRetain(...args),
  scheduleDriverUploadRuntimeRelease: (...args) => mockSchedule(...args),
}))

jest.mock('../lib/driverPortalSupabase', () => ({
  driverPortalSupabase: {
    auth: {
      getSession: async () => ({ data: { session: null } }),
    },
  },
}))

jest.mock('../hooks/useDriverPhotoUploadQueue', () => ({
  resolveDriverSupabaseBearer: async () => 'synthetic-token',
}))

function Session({ driverId, screen }) {
  return (
    <>
      <DriverPhotoUploadRuntime driverId={driverId} />
      <div>{screen}</div>
    </>
  )
}

describe('DriverPhotoUploadRuntime mount scope', () => {
  let root
  let container

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true
    mockRetain.mockClear()
    mockSchedule.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  test('switching screens keeps the same driver runtime', () => {
    act(() => {
      root.render(<Session driverId="driver-a" screen="jobs" />)
    })
    act(() => {
      root.render(<Session driverId="driver-a" screen="report" />)
    })
    expect(mockRetain).toHaveBeenCalledTimes(1)
    expect(mockRetain.mock.calls[0][0]).toBe('driver-a')
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  test('unmounting the screen shell schedules one release and an identity change swaps actors', () => {
    act(() => {
      root.render(<Session driverId="driver-a" screen="jobs" />)
    })
    act(() => {
      root.render(<Session driverId="driver-b" screen="jobs" />)
    })
    expect(mockSchedule).toHaveBeenCalledWith('driver-a')
    expect(mockRetain).toHaveBeenCalledWith('driver-b', expect.any(Object))
    const releasesBeforeUnmount = mockSchedule.mock.calls.length
    act(() => {
      root.render(<div>logged-out</div>)
    })
    expect(mockSchedule).toHaveBeenCalledWith('driver-b')
    expect(mockSchedule.mock.calls.length).toBe(releasesBeforeUnmount + 1)
  })
})

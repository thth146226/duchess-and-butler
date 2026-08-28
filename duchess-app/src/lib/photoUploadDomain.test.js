import {
  PHOTO_UPLOAD_EVENTS,
  PHOTO_UPLOAD_STATUSES,
  InvalidPhotoUploadTransitionError,
  isPhotoUploadStatus,
  isUploadTransportPermitted,
  transitionPhotoUpload,
} from './photoUploadDomain'

const S = PHOTO_UPLOAD_STATUSES
const E = PHOTO_UPLOAD_EVENTS

const ALLOWED_TRANSITIONS = [
  [S.DRAFT_QUEUED, E.REPORT_ID_PROVEN, { kind: 'STATE', status: S.QUEUED }],
  [S.DRAFT_QUEUED, E.REPORT_RESULT_AMBIGUOUS, { kind: 'STATE', status: S.REPORT_LINK_UNKNOWN }],
  [S.DRAFT_QUEUED, E.DISCARD_REQUESTED, { kind: 'DELETE_LOCAL' }],

  [S.REPORT_LINK_UNKNOWN, E.REPORT_ID_PROVEN, { kind: 'STATE', status: S.QUEUED }],
  [S.REPORT_LINK_UNKNOWN, E.DISCARD_REQUESTED, { kind: 'DELETE_LOCAL' }],

  [S.QUEUED, E.WORKER_CLAIMED, { kind: 'STATE', status: S.UPLOADING }],
  [S.QUEUED, E.DISCARD_REQUESTED, { kind: 'DELETE_LOCAL' }],

  [S.UPLOADING, E.TUS_COMPLETED, { kind: 'STATE', status: S.STORAGE_COMPLETE }],
  [S.UPLOADING, E.UPLOAD_AUTH_OR_OFFLINE_PAUSE, { kind: 'STATE', status: S.UPLOAD_PAUSED }],
  [S.UPLOADING, E.UPLOAD_RETRYABLE_FAILURE, { kind: 'STATE', status: S.UPLOAD_RETRY_WAIT }],
  [S.UPLOADING, E.UPLOAD_PERMANENT_FAILURE, { kind: 'STATE', status: S.FAILED_UPLOAD }],
  [S.UPLOADING, E.REMOTE_COMPLETE_RECONCILED, { kind: 'STATE', status: S.STORAGE_COMPLETE }],
  [S.UPLOADING, E.REMOTE_INCOMPLETE_RECONCILED, { kind: 'STATE', status: S.QUEUED }],
  [S.UPLOADING, E.DISCARD_REQUESTED, { kind: 'STATE', status: S.DISCARD_PENDING }],

  [S.UPLOAD_PAUSED, E.UPLOAD_RESUME_READY, { kind: 'STATE', status: S.QUEUED }],
  [S.UPLOAD_PAUSED, E.DISCARD_REQUESTED, { kind: 'DELETE_LOCAL' }],

  [S.UPLOAD_RETRY_WAIT, E.UPLOAD_RETRY_DUE, { kind: 'STATE', status: S.UPLOADING }],
  [S.UPLOAD_RETRY_WAIT, E.DISCARD_REQUESTED, { kind: 'DELETE_LOCAL' }],

  [S.FAILED_UPLOAD, E.MANUAL_UPLOAD_RETRY, { kind: 'STATE', status: S.QUEUED }],
  [S.FAILED_UPLOAD, E.DISCARD_REQUESTED, { kind: 'DELETE_LOCAL' }],

  [S.STORAGE_COMPLETE, E.BEGIN_DB_PHASE, { kind: 'STATE', status: S.DB_PENDING }],
  [S.STORAGE_COMPLETE, E.DISCARD_REQUESTED, { kind: 'STATE', status: S.DISCARD_PENDING }],

  [S.DB_PENDING, E.DB_ROW_FOUND, { kind: 'STATE', status: S.DONE }],
  [S.DB_PENDING, E.DB_INSERT_SUCCEEDED, { kind: 'STATE', status: S.DONE }],
  [S.DB_PENDING, E.DB_RETRYABLE_FAILURE, { kind: 'STATE', status: S.DB_RETRY_WAIT }],
  [S.DB_PENDING, E.DB_PERMANENT_FAILURE, { kind: 'STATE', status: S.FAILED_DB }],
  [S.DB_PENDING, E.DISCARD_REQUESTED, { kind: 'STATE', status: S.DISCARD_PENDING }],

  [S.DB_RETRY_WAIT, E.DB_RETRY_DUE, { kind: 'STATE', status: S.DB_PENDING }],
  [S.DB_RETRY_WAIT, E.DISCARD_REQUESTED, { kind: 'STATE', status: S.DISCARD_PENDING }],

  [S.FAILED_DB, E.MANUAL_DB_RETRY, { kind: 'STATE', status: S.DB_PENDING }],
  [S.FAILED_DB, E.DISCARD_REQUESTED, { kind: 'STATE', status: S.DISCARD_PENDING }],

  [S.DISCARD_PENDING, E.DISCARD_CLEANUP_VERIFIED, { kind: 'DELETE_LOCAL' }],
  [S.DISCARD_PENDING, E.DISCARD_EXISTING_DB_ROW_RETAINED, { kind: 'STATE', status: S.DONE }],
]

const LOCAL_ONLY_DISCARD = [
  S.DRAFT_QUEUED,
  S.REPORT_LINK_UNKNOWN,
  S.QUEUED,
  S.UPLOAD_PAUSED,
  S.UPLOAD_RETRY_WAIT,
  S.FAILED_UPLOAD,
]

const REMOTE_MAY_EXIST_DISCARD = [
  S.UPLOADING,
  S.STORAGE_COMPLETE,
  S.DB_PENDING,
  S.DB_RETRY_WAIT,
  S.FAILED_DB,
]

function expectInvalid(status, event) {
  expect(() => transitionPhotoUpload(status, event)).toThrow(InvalidPhotoUploadTransitionError)
}

describe('photoUploadDomain', () => {
  test('allowed transition table is complete and exact', () => {
    expect(ALLOWED_TRANSITIONS).toHaveLength(33)

    ALLOWED_TRANSITIONS.forEach(([status, event, expected]) => {
      expect(transitionPhotoUpload(status, event)).toEqual(expected)
    })
  })

  test('does not mutate status or event arguments', () => {
    const status = S.QUEUED
    const event = E.WORKER_CLAIMED
    const frozenStatus = Object.freeze({ status })
    const frozenEvent = Object.freeze({ event })
    transitionPhotoUpload(frozenStatus.status, frozenEvent.event)
    expect(frozenStatus.status).toBe(S.QUEUED)
    expect(frozenEvent.event).toBe(E.WORKER_CLAIMED)
  })

  test('draft states cannot upload or skip to remote/DB/DONE', () => {
    ;[S.DRAFT_QUEUED, S.REPORT_LINK_UNKNOWN].forEach((status) => {
      expect(isUploadTransportPermitted(status)).toBe(false)
      expectInvalid(status, E.WORKER_CLAIMED)
      expectInvalid(status, E.TUS_COMPLETED)
      expectInvalid(status, E.BEGIN_DB_PHASE)
      expectInvalid(status, E.DB_INSERT_SUCCEEDED)
    })
  })

  test('DB retry and DB recovery never re-enter upload', () => {
    expectInvalid(S.DB_PENDING, E.WORKER_CLAIMED)
    expectInvalid(S.DB_RETRY_WAIT, E.UPLOAD_RETRY_DUE)
    expectInvalid(S.DB_RETRY_WAIT, E.WORKER_CLAIMED)
    expectInvalid(S.FAILED_DB, E.MANUAL_UPLOAD_RETRY)
    expectInvalid(S.FAILED_DB, E.WORKER_CLAIMED)
    expectInvalid(S.STORAGE_COMPLETE, E.WORKER_CLAIMED)
    expectInvalid(S.STORAGE_COMPLETE, E.TUS_COMPLETED)

    expect(transitionPhotoUpload(S.DB_RETRY_WAIT, E.DB_RETRY_DUE)).toEqual({
      kind: 'STATE',
      status: S.DB_PENDING,
    })
    expect(transitionPhotoUpload(S.FAILED_DB, E.MANUAL_DB_RETRY)).toEqual({
      kind: 'STATE',
      status: S.DB_PENDING,
    })
  })

  test('local-only discard deletes the record; remote-may-exist discard waits', () => {
    LOCAL_ONLY_DISCARD.forEach((status) => {
      expect(transitionPhotoUpload(status, E.DISCARD_REQUESTED)).toEqual({
        kind: 'DELETE_LOCAL',
      })
    })

    REMOTE_MAY_EXIST_DISCARD.forEach((status) => {
      expect(transitionPhotoUpload(status, E.DISCARD_REQUESTED)).toEqual({
        kind: 'STATE',
        status: S.DISCARD_PENDING,
      })
    })
  })

  test('DONE is terminal for every defined event', () => {
    Object.values(E).forEach((event) => {
      expectInvalid(S.DONE, event)
    })
  })

  test('unknown status and unknown event are rejected', () => {
    expectInvalid('NOT_A_STATUS', E.WORKER_CLAIMED)
    expectInvalid(S.QUEUED, 'NOT_AN_EVENT')
    expectInvalid(null, E.WORKER_CLAIMED)
    expectInvalid(S.QUEUED, null)
  })

  test('isUploadTransportPermitted is true only for UPLOADING', () => {
    Object.values(S).forEach((status) => {
      expect(isUploadTransportPermitted(status)).toBe(status === S.UPLOADING)
    })
  })

  test('isPhotoUploadStatus accepts only frozen statuses', () => {
    Object.values(S).forEach((status) => {
      expect(isPhotoUploadStatus(status)).toBe(true)
    })
    expect(isPhotoUploadStatus('DONE ')).toBe(false)
    expect(isPhotoUploadStatus('queued')).toBe(false)
    expect(isPhotoUploadStatus(undefined)).toBe(false)
    expect(isPhotoUploadStatus(null)).toBe(false)
    expect(isPhotoUploadStatus('')).toBe(false)
  })
})

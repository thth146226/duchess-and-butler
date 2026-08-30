/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

import fs from 'fs'
import path from 'path'
import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  createPhotoUploadDb,
} from './photoUploadDb'
import {
  RAW_LEGACY_ROLLBACK_BLOCKED_CODE,
  PhotoUploadRollbackBlockedError,
  createPhotoUploadRollbackRecovery,
} from './photoUploadRollbackRecovery'

const SOURCE_BYTES = [1, 2, 3, 4, 5, 250, 251, 252]
const SENTINEL_TOKEN = 'p6-sentinel-token-SECRET-never-persist'
const FIXED_CREATED_AT = 1_700_000_000_000
const FIXED_UPDATED_AT = 1_700_000_000_500

let testSeq = 0
let dbName
let db

function jpegBlob() {
  return new Blob([Uint8Array.from(SOURCE_BYTES)], { type: 'image/jpeg' })
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

function makeRecord(overrides = {}) {
  return {
    schema_version: PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
    queue_id: 'queue-office-a-1',
    blob: jpegBlob(),
    file_name: 'evidence.jpg',
    mime_type: 'image/jpeg',
    file_size: SOURCE_BYTES.length,
    source_surface: 'evidence_upload',
    entity_type: 'job',
    entity_id: 'job-1',
    provisional_id: null,
    actor_scope_type: 'office_user',
    actor_scope_id: 'office-a',
    run_type: 'delivery',
    storage_path: 'job-1/delivery_queue-office-a-1.jpg',
    status: PHOTO_UPLOAD_STATUSES.QUEUED,
    upload_attempt_count: 0,
    db_attempt_count: 0,
    next_retry_at: null,
    retry_phase: null,
    discard_requested: false,
    discard_requested_at: null,
    failure_stage: null,
    last_error: null,
    last_http_status: null,
    tus_upload_url: null,
    tus_created_at: null,
    bytes_uploaded: 0,
    bytes_total: SOURCE_BYTES.length,
    remote_public_url: null,
    db_row_id: null,
    metadata_payload: { nested: 'original' },
    lease_owner: null,
    lease_generation: 0,
    lease_expires_at: null,
    remote_reconciliation_status: null,
    remote_cleanup_attempt_count: 0,
    remote_cleanup_last_error: null,
    created_at: FIXED_CREATED_AT,
    updated_at: FIXED_UPDATED_AT,
    completed_at: null,
    ...overrides,
  }
}

function collectStrings(value, out, seen) {
  if (value == null) {
    return
  }
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (typeof value !== 'object') {
    return
  }
  if (typeof Blob === 'function' && value instanceof Blob) {
    return
  }
  if (seen.has(value)) {
    return
  }
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, out, seen))
    return
  }
  Object.keys(value).forEach((key) => {
    collectStrings(key, out, seen)
    collectStrings(value[key], out, seen)
  })
}

function assertNoToken(value) {
  const strings = []
  collectStrings(value, strings, new Set())
  expect(strings.join('\n')).not.toContain(SENTINEL_TOKEN)
}

function mutationSpies(instance) {
  return {
    putRecord: jest.spyOn(instance, 'putRecord'),
    putRecordFenced: jest.spyOn(instance, 'putRecordFenced'),
    deleteLocalRecord: jest.spyOn(instance, 'deleteLocalRecord'),
    clearDoneBlob: jest.spyOn(instance, 'clearDoneBlob'),
    claimLease: jest.spyOn(instance, 'claimLease'),
    releaseLease: jest.spyOn(instance, 'releaseLease'),
    heartbeatLease: jest.spyOn(instance, 'heartbeatLease'),
  }
}

describe('photoUploadRollbackRecovery', () => {
  beforeEach(() => {
    testSeq += 1
    dbName = `duchess-p6-rollback-${testSeq}`
  })

  afterEach(async () => {
    if (db) {
      await db.close()
      db = null
    }
    if (dbName) {
      await deleteDatabase(dbName)
    }
  })

  test('static rollback module is read-only queue inspection', () => {
    const source = fs.readFileSync(path.join(__dirname, 'photoUploadRollbackRecovery.js'), 'utf8')
    expect(source).not.toMatch(/transport/)
    expect(source).not.toMatch(/reconciler/)
    expect(source).not.toMatch(/supabase/)
    expect(source).not.toMatch(/tus-js-client/)
    expect(source).not.toMatch(/tus\.Upload/)
    expect(source).not.toMatch(/from ['"]tus/)
    expect(source).not.toMatch(/fetch/)
    expect(source).not.toMatch(/putRecord/)
    expect(source).not.toMatch(/putRecordFenced/)
    expect(source).not.toMatch(/deleteLocalRecord/)
    expect(source).not.toMatch(/clearDoneBlob/)
    expect(source).not.toMatch(/claimLease/)
    expect(source).not.toMatch(/releaseLease/)
    expect(source).not.toMatch(/setTimeout/)
    expect(source).not.toMatch(/React/)
  })

  test('no queue records allows raw legacy rollback', async () => {
    db = createPhotoUploadDb({ dbName })
    const recovery = createPhotoUploadRollbackRecovery({ db })
    const spies = mutationSpies(db)
    const report = await recovery.inspectRollbackSafety({
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(report.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(true)
    expect(report.PHOTO_UPLOAD_RUNTIME_REQUIRED).toBe(false)
    expect(report.blockingCount).toBe(0)
    expect(report.queueIds).toEqual([])
    expect(report.hasRetainedLocalBlob).toBe(false)
    Object.values(spies).forEach((spy) => expect(spy).not.toHaveBeenCalled())
  })

  test('only DONE records allow raw legacy rollback even with retained Blob', async () => {
    db = createPhotoUploadDb({ dbName })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.DONE,
      completed_at: FIXED_UPDATED_AT,
      remote_public_url: 'https://example.test/photo.jpg',
      db_row_id: 'row-1',
    }))
    const recovery = createPhotoUploadRollbackRecovery({ db })
    const report = await recovery.inspectRollbackSafety({
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(report.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(true)
    expect(report.PHOTO_UPLOAD_RUNTIME_REQUIRED).toBe(false)
    expect(report.blockingCount).toBe(0)
    expect(report.hasRetainedLocalBlob).toBe(true)
    expect(report.statusCounts).toEqual({ [PHOTO_UPLOAD_STATUSES.DONE]: 1 })
    expect(JSON.stringify(report)).not.toMatch(/1,2,3,4,5/)
    assertNoToken(report)
  })

  test.each([
    ['QUEUED', { status: PHOTO_UPLOAD_STATUSES.QUEUED }],
    ['UPLOADING', { status: PHOTO_UPLOAD_STATUSES.UPLOADING }],
    ['UPLOAD_PAUSED', { status: PHOTO_UPLOAD_STATUSES.UPLOAD_PAUSED }],
    ['FAILED_UPLOAD', { status: PHOTO_UPLOAD_STATUSES.FAILED_UPLOAD }],
    ['STORAGE_COMPLETE', { status: PHOTO_UPLOAD_STATUSES.STORAGE_COMPLETE, remote_public_url: 'https://example.test/photo.jpg' }],
    ['DB_PENDING', { status: PHOTO_UPLOAD_STATUSES.DB_PENDING, remote_public_url: 'https://example.test/photo.jpg' }],
    ['DB_RETRY_WAIT', { status: PHOTO_UPLOAD_STATUSES.DB_RETRY_WAIT, retry_phase: 'DB', next_retry_at: FIXED_UPDATED_AT + 1 }],
    ['FAILED_DB', { status: PHOTO_UPLOAD_STATUSES.FAILED_DB }],
    ['DISCARD_PENDING', { status: PHOTO_UPLOAD_STATUSES.DISCARD_PENDING, discard_requested: true, discard_requested_at: FIXED_UPDATED_AT }],
    ['DRAFT_QUEUED', { status: PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED, entity_id: null, storage_path: null }],
    ['REPORT_LINK_UNKNOWN', { status: PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN, entity_id: null, storage_path: null }],
    ['UPLOAD_RETRY_WAIT', { status: PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT, retry_phase: 'UPLOAD', next_retry_at: FIXED_UPDATED_AT + 1 }],
  ])('%s blocks raw legacy rollback', async (_name, overrides) => {
    db = createPhotoUploadDb({ dbName })
    await db.putRecord(makeRecord(overrides))
    const recovery = createPhotoUploadRollbackRecovery({ db })
    const spies = mutationSpies(db)
    const report = await recovery.inspectRollbackSafety({
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(report.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(false)
    expect(report.PHOTO_UPLOAD_RUNTIME_REQUIRED).toBe(true)
    expect(report.blockingCount).toBe(1)
    expect(report.hasRetainedLocalBlob).toBe(true)
    Object.values(spies).forEach((spy) => expect(spy).not.toHaveBeenCalled())
    const stored = await db.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.status).toBe(overrides.status)
    expect(stored.blob).toBeInstanceOf(Blob)
  })

  test('actor A records do not block actor B', async () => {
    db = createPhotoUploadDb({ dbName })
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.QUEUED,
    }))
    await db.putRecord(makeRecord({
      queue_id: 'queue-office-b-1',
      actor_scope_id: 'office-b',
      storage_path: 'job-1/delivery_queue-office-b-1.jpg',
      status: PHOTO_UPLOAD_STATUSES.DONE,
      completed_at: FIXED_UPDATED_AT,
    }))
    const recovery = createPhotoUploadRollbackRecovery({ db })
    const reportA = await recovery.inspectRollbackSafety({
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    const reportB = await recovery.inspectRollbackSafety({
      actorScopeType: 'office_user',
      actorScopeId: 'office-b',
    })
    expect(reportA.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(false)
    expect(reportB.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(true)
    expect(reportB.queueIds).toEqual(['queue-office-b-1'])
  })

  test('assertLegacyRollbackSafe throws a deterministic blocked error', async () => {
    db = createPhotoUploadDb({ dbName })
    await db.putRecord(makeRecord({
      last_error: { code: 'X', message: SENTINEL_TOKEN },
    }))
    const recovery = createPhotoUploadRollbackRecovery({ db })
    let caught
    try {
      await recovery.assertLegacyRollbackSafe({
        actorScopeType: 'office_user',
        actorScopeId: 'office-a',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PhotoUploadRollbackBlockedError)
    expect(caught.code).toBe(RAW_LEGACY_ROLLBACK_BLOCKED_CODE)
    expect(caught.message).toBe(RAW_LEGACY_ROLLBACK_BLOCKED_CODE)
    expect(caught.report.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(false)
    expect(JSON.stringify(caught.report)).not.toContain(SENTINEL_TOKEN)
    assertNoToken(caught.report)
  })

  test('assertLegacyRollbackSafe resolves when the actor queue is empty', async () => {
    db = createPhotoUploadDb({ dbName })
    const recovery = createPhotoUploadRollbackRecovery({ db })
    const report = await recovery.assertLegacyRollbackSafe({
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(report.RAW_LEGACY_ROLLBACK_ALLOWED).toBe(true)
  })
})

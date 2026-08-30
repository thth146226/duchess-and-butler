/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'
import {
  PHOTO_UPLOAD_DB_ERROR_CODES,
  PHOTO_UPLOAD_RECORD_SCHEMA_VERSION,
  createPhotoUploadDb,
} from './photoUploadDb'
import {
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  MAX_CONCURRENT_UPLOADS,
  createPhotoUploadManager,
} from './photoUploadManager'

const SOURCE_BYTES = [1, 2, 3, 4, 5, 250, 251, 252]
const FIXED_CREATED_AT = 1_700_000_000_000
const FIXED_UPDATED_AT = 1_700_000_000_500
const FIXED_NOW = 1_900_000_000_000

let testSeq = 0
let dbName
let handles

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

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function flushMany(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await flushPromises()
  }
}

async function waitFor(predicate, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) {
      return
    }
    await flushPromises()
  }
  throw new Error('waitFor timeout')
}

function createClock(startMs) {
  let nowMs = startMs
  let nextId = 1
  const timeouts = new Map()

  return {
    now: () => nowMs,
    setTimeoutImpl(fn, ms) {
      const id = nextId
      nextId += 1
      timeouts.set(id, { fn, due: nowMs + ms })
      return id
    },
    clearTimeoutImpl(id) {
      timeouts.delete(id)
    },
    openTimerCount() {
      return timeouts.size
    },
    jump(ms) {
      nowMs += ms
    },
    async advance(ms) {
      nowMs += ms
      const due = [...timeouts.entries()]
        .filter(([, timer]) => timer.due <= nowMs)
        .sort((left, right) => left[1].due - right[1].due)
      for (const [id, timer] of due) {
        timeouts.delete(id)
        timer.fn()
        await flushMany(4)
      }
    },
  }
}

function createHandleSet() {
  const dbs = []
  const managers = []
  const gates = []
  return {
    db(instance) {
      dbs.push(instance)
      return instance
    },
    manager(instance) {
      managers.push(instance)
      return instance
    },
    gate() {
      let resolve
      const promise = new Promise((res) => {
        resolve = res
      })
      gates.push(resolve)
      return { promise, resolve }
    },
    async cleanup() {
      for (const resolve of gates) {
        resolve()
      }
      await flushMany(4)
      for (const manager of managers) {
        await manager.stop()
      }
      for (const instance of dbs) {
        await instance.close()
      }
    },
  }
}

function managerOptions({ db, clock, leaseOwner = 'tab-a', executeClaimedRecord }) {
  return {
    db,
    actorScopeType: 'office_user',
    actorScopeId: 'office-a',
    leaseOwner,
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    executeClaimedRecord,
  }
}

describe('photoUploadManager', () => {
  beforeEach(() => {
    testSeq += 1
    dbName = `duchess-p3-test-${testSeq}`
    handles = createHandleSet()
  })

  afterEach(async () => {
    if (handles) {
      await handles.cleanup()
      handles = null
    }
    if (dbName) {
      await deleteDatabase(dbName)
    }
  })

  test('exports frozen P3 constants', () => {
    expect(MAX_CONCURRENT_UPLOADS).toBe(2)
    expect(LEASE_TTL_MS).toBe(30000)
    expect(LEASE_HEARTBEAT_MS).toBe(10000)
  })

  test('claims QUEUED, persists WORKER_CLAIMED -> UPLOADING before executor', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    await db.putRecord(makeRecord())
    let statusAtExecutor = null
    const started = []
    const gate = handles.gate()
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      executeClaimedRecord: async (record) => {
        const stored = await db.getRecord({
          queueId: record.queue_id,
          actorScopeType: 'office_user',
          actorScopeId: 'office-a',
        })
        statusAtExecutor = stored.status
        started.push(record.queue_id)
        await gate.promise
      },
    })))
    await manager.pump()
    await waitFor(() => started.length === 1)
    expect(statusAtExecutor).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    const stored = await db.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(stored.lease_owner).toBe('tab-a')
    expect(stored.lease_generation).toBe(1)
  })

  test('draft states never execute', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    const started = []
    await db.putRecord(makeRecord({
      queue_id: 'q-draft',
      status: PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED,
      entity_id: null,
      storage_path: null,
    }))
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      executeClaimedRecord: async (record) => {
        started.push(record.queue_id)
      },
    })))
    await manager.pump()
    await flushMany()
    expect(started).toEqual([])
    const stored = await db.getRecord({
      queueId: 'q-draft',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.DRAFT_QUEUED)
    expect(stored.lease_owner).toBeNull()
  })

  test('REPORT_LINK_UNKNOWN never executes', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    const started = []
    await db.putRecord(makeRecord({
      queue_id: 'q-unknown',
      status: PHOTO_UPLOAD_STATUSES.REPORT_LINK_UNKNOWN,
      entity_id: null,
      storage_path: null,
    }))
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      executeClaimedRecord: async (record) => {
        started.push(record.queue_id)
      },
    })))
    await manager.pump()
    await flushMany()
    expect(started).toEqual([])
  })

  test('DONE never executes', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    const started = []
    await db.putRecord(makeRecord({
      queue_id: 'q-done',
      status: PHOTO_UPLOAD_STATUSES.DONE,
    }))
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      executeClaimedRecord: async (record) => {
        started.push(record.queue_id)
      },
    })))
    await manager.pump()
    await flushMany()
    expect(started).toEqual([])
  })

  test('max concurrency is exactly 2 and the third record waits for a slot', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    const started = []
    const gates = {}
    await db.putRecord(makeRecord({ queue_id: 'q-1', created_at: FIXED_CREATED_AT, storage_path: 'job-1/delivery_q-1.jpg' }))
    await db.putRecord(makeRecord({ queue_id: 'q-2', created_at: FIXED_CREATED_AT + 1, storage_path: 'job-1/delivery_q-2.jpg' }))
    await db.putRecord(makeRecord({ queue_id: 'q-3', created_at: FIXED_CREATED_AT + 2, storage_path: 'job-1/delivery_q-3.jpg' }))
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      executeClaimedRecord: async (record) => {
        started.push(record.queue_id)
        const gate = handles.gate()
        gates[record.queue_id] = gate
        await gate.promise
      },
    })))
    await manager.pump()
    await waitFor(() => started.length === 2)
    await flushMany()
    expect(started).toEqual(['q-1', 'q-2'])
    expect(MAX_CONCURRENT_UPLOADS).toBe(2)
    gates['q-1'].resolve()
    await waitFor(() => started.length === 3)
    expect(started).toEqual(['q-1', 'q-2', 'q-3'])
  })

  test('two managers racing the same record execute it exactly once', async () => {
    const dbA = handles.db(createPhotoUploadDb({ dbName }))
    const dbB = handles.db(createPhotoUploadDb({ dbName }))
    const clockA = createClock(FIXED_NOW)
    const clockB = createClock(FIXED_NOW)
    const executions = []
    await dbA.putRecord(makeRecord())
    const managerA = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbA,
      clock: clockA,
      leaseOwner: 'tab-A',
      executeClaimedRecord: async (record) => {
        executions.push({ owner: 'tab-A', queueId: record.queue_id })
        await handles.gate().promise
      },
    })))
    const managerB = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbB,
      clock: clockB,
      leaseOwner: 'tab-B',
      executeClaimedRecord: async (record) => {
        executions.push({ owner: 'tab-B', queueId: record.queue_id })
        await handles.gate().promise
      },
    })))
    await Promise.all([managerA.pump(), managerB.pump()])
    await waitFor(() => executions.length >= 1)
    await flushMany(12)
    expect(executions).toHaveLength(1)
    expect(executions[0].queueId).toBe('queue-office-a-1')
    const stored = await dbA.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.lease_owner).toBe(executions[0].owner)
  })

  test('different eligible records may be owned by different managers', async () => {
    const dbA = handles.db(createPhotoUploadDb({ dbName }))
    const dbB = handles.db(createPhotoUploadDb({ dbName }))
    const clockA = createClock(FIXED_NOW)
    const clockB = createClock(FIXED_NOW)
    const executions = []
    await dbA.putRecord(makeRecord({
      queue_id: 'q-a',
      storage_path: 'job-1/delivery_q-a.jpg',
    }))
    const managerA = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbA,
      clock: clockA,
      leaseOwner: 'tab-A',
      executeClaimedRecord: async (record) => {
        executions.push({ owner: 'tab-A', queueId: record.queue_id })
        await handles.gate().promise
      },
    })))
    await managerA.pump()
    await waitFor(() => executions.some((row) => row.queueId === 'q-a'))
    await dbB.putRecord(makeRecord({
      queue_id: 'q-b',
      storage_path: 'job-1/delivery_q-b.jpg',
    }))
    const managerB = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbB,
      clock: clockB,
      leaseOwner: 'tab-B',
      executeClaimedRecord: async (record) => {
        executions.push({ owner: 'tab-B', queueId: record.queue_id })
        await handles.gate().promise
      },
    })))
    await managerB.pump()
    await waitFor(() => executions.length === 2)
    expect(executions).toEqual([
      { owner: 'tab-A', queueId: 'q-a' },
      { owner: 'tab-B', queueId: 'q-b' },
    ])
  })

  test('heartbeat occurs at the frozen interval and prevents reclaim while active', async () => {
    const dbA = handles.db(createPhotoUploadDb({ dbName }))
    const dbB = handles.db(createPhotoUploadDb({ dbName }))
    const clockA = createClock(FIXED_NOW)
    const clockB = createClock(FIXED_NOW)
    const started = []
    await dbA.putRecord(makeRecord({ upload_attempt_count: 4, db_attempt_count: 1 }))
    const managerA = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbA,
      clock: clockA,
      leaseOwner: 'tab-A',
      executeClaimedRecord: async (record) => {
        started.push(record.queue_id)
        await handles.gate().promise
      },
    })))
    const managerB = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbB,
      clock: clockB,
      leaseOwner: 'tab-B',
      executeClaimedRecord: async (record) => {
        started.push(`B:${record.queue_id}`)
      },
    })))
    await managerA.pump()
    await waitFor(() => started.length === 1)
    expect(clockA.openTimerCount()).toBe(1)
    await clockA.advance(LEASE_HEARTBEAT_MS)
    const afterBeat = await dbA.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(afterBeat.lease_owner).toBe('tab-A')
    expect(afterBeat.lease_generation).toBe(1)
    expect(afterBeat.lease_expires_at).toBe(FIXED_NOW + LEASE_HEARTBEAT_MS + LEASE_TTL_MS)
    expect(afterBeat.upload_attempt_count).toBe(4)
    expect(afterBeat.db_attempt_count).toBe(1)
    clockB.jump(LEASE_HEARTBEAT_MS)
    await managerB.pump()
    await flushMany()
    expect(started).toEqual(['queue-office-a-1'])
    const stillHeld = await dbA.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stillHeld.lease_owner).toBe('tab-A')
  })

  test('expired work is reclaimable and the new generation fences stale writes and heartbeats', async () => {
    const dbA = handles.db(createPhotoUploadDb({ dbName }))
    const dbB = handles.db(createPhotoUploadDb({ dbName }))
    const clockA = createClock(FIXED_NOW)
    const clockB = createClock(FIXED_NOW)
    const started = []
    let staleHeartbeatCalls = 0
    const heartbeatLease = dbA.heartbeatLease.bind(dbA)
    dbA.heartbeatLease = async (args) => {
      staleHeartbeatCalls += 1
      return heartbeatLease(args)
    }
    await dbA.putRecord(makeRecord({ upload_attempt_count: 5, db_attempt_count: 2 }))
    const managerA = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbA,
      clock: clockA,
      leaseOwner: 'tab-A',
      executeClaimedRecord: async (record) => {
        started.push({ owner: 'tab-A', generation: record.lease_generation })
        await handles.gate().promise
      },
    })))
    const managerB = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbB,
      clock: clockB,
      leaseOwner: 'tab-B',
      executeClaimedRecord: async (record) => {
        started.push({ owner: 'tab-B', generation: record.lease_generation })
        await handles.gate().promise
      },
    })))
    await managerA.pump()
    await waitFor(() => started.some((row) => row.owner === 'tab-A'))
    const stale = await dbA.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stale.lease_generation).toBe(1)
    clockA.jump(LEASE_TTL_MS)
    clockB.jump(LEASE_TTL_MS)
    await managerB.pump()
    await waitFor(() => started.some((row) => row.owner === 'tab-B'))
    const reclaimed = await dbB.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(reclaimed.lease_owner).toBe('tab-B')
    expect(reclaimed.lease_generation).toBe(2)
    expect(reclaimed.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(reclaimed.upload_attempt_count).toBe(5)
    expect(reclaimed.db_attempt_count).toBe(2)
    await expect(dbA.putRecordFenced({
      record: {
        ...stale,
        file_name: 'stale.jpg',
      },
      leaseOwner: 'tab-A',
      leaseGeneration: stale.lease_generation,
    })).rejects.toMatchObject({
      code: PHOTO_UPLOAD_DB_ERROR_CODES.LEASE_FENCE_CONFLICT,
    })
    const heartbeatsBefore = staleHeartbeatCalls
    await clockA.advance(LEASE_HEARTBEAT_MS)
    expect(staleHeartbeatCalls).toBeGreaterThan(heartbeatsBefore)
    const afterStaleBeat = await dbB.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(afterStaleBeat.lease_owner).toBe('tab-B')
    expect(afterStaleBeat.lease_generation).toBe(2)
    expect(afterStaleBeat.file_name).toBe('evidence.jpg')
    const laterBeats = staleHeartbeatCalls
    await clockA.advance(LEASE_HEARTBEAT_MS)
    expect(staleHeartbeatCalls).toBe(laterBeats)
  })

  test('manager stop stops new claims and clears timers', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    const started = []
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      executeClaimedRecord: async (record) => {
        started.push(record.queue_id)
        await handles.gate().promise
      },
    })))
    await db.putRecord(makeRecord({ queue_id: 'q-before', storage_path: 'job-1/delivery_q-before.jpg' }))
    await manager.pump()
    await waitFor(() => started.length === 1)
    expect(clock.openTimerCount()).toBe(1)
    await manager.stop()
    expect(clock.openTimerCount()).toBe(0)
    await db.putRecord(makeRecord({ queue_id: 'q-after', storage_path: 'job-1/delivery_q-after.jpg' }))
    await manager.pump()
    await flushMany()
    expect(started).toEqual(['q-before'])
    const after = await db.getRecord({
      queueId: 'q-after',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(after.lease_owner).toBeNull()
    expect(after.status).toBe(PHOTO_UPLOAD_STATUSES.QUEUED)
  })

  test('claim heartbeat and reclaim do not burn upload or db attempt counters', async () => {
    const dbA = handles.db(createPhotoUploadDb({ dbName }))
    const dbB = handles.db(createPhotoUploadDb({ dbName }))
    const clockA = createClock(FIXED_NOW)
    const clockB = createClock(FIXED_NOW)
    await dbA.putRecord(makeRecord({
      upload_attempt_count: 7,
      db_attempt_count: 3,
    }))
    const managerA = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbA,
      clock: clockA,
      leaseOwner: 'tab-A',
      executeClaimedRecord: async () => {
        await handles.gate().promise
      },
    })))
    const managerB = handles.manager(createPhotoUploadManager(managerOptions({
      db: dbB,
      clock: clockB,
      leaseOwner: 'tab-B',
      executeClaimedRecord: async () => {
        await handles.gate().promise
      },
    })))
    await managerA.pump()
    await waitFor(async () => {
      const row = await dbA.getRecord({
        queueId: 'queue-office-a-1',
        actorScopeType: 'office_user',
        actorScopeId: 'office-a',
      })
      return row && row.lease_owner === 'tab-A'
    })
    await clockA.advance(LEASE_HEARTBEAT_MS)
    clockA.jump(LEASE_TTL_MS)
    clockB.jump(LEASE_TTL_MS + LEASE_HEARTBEAT_MS)
    await managerB.pump()
    await waitFor(async () => {
      const row = await dbB.getRecord({
        queueId: 'queue-office-a-1',
        actorScopeType: 'office_user',
        actorScopeId: 'office-a',
      })
      return row && row.lease_owner === 'tab-B'
    })
    const stored = await dbB.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.upload_attempt_count).toBe(7)
    expect(stored.db_attempt_count).toBe(3)
  })

  test('UPLOAD_RETRY_WAIT not due does not execute', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    const started = []
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT,
      next_retry_at: FIXED_NOW + 5_000,
    }))
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      executeClaimedRecord: async (record) => {
        started.push(record.queue_id)
      },
    })))
    await manager.pump()
    await flushMany()
    expect(started).toEqual([])
  })

  test('UPLOAD_RETRY_WAIT due transitions legally and executes', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    let statusAtExecutor = null
    const started = []
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.UPLOAD_RETRY_WAIT,
      next_retry_at: FIXED_NOW,
    }))
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      executeClaimedRecord: async (record) => {
        const stored = await db.getRecord({
          queueId: record.queue_id,
          actorScopeType: 'office_user',
          actorScopeId: 'office-a',
        })
        statusAtExecutor = stored.status
        started.push(record.queue_id)
      },
    })))
    await manager.pump()
    await waitFor(() => started.length === 1)
    expect(statusAtExecutor).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
  })

  test('stale UPLOADING is reclaimed without an invented domain transition', async () => {
    const db = handles.db(createPhotoUploadDb({ dbName }))
    const clock = createClock(FIXED_NOW)
    const started = []
    const gate = handles.gate()
    await db.putRecord(makeRecord({
      status: PHOTO_UPLOAD_STATUSES.UPLOADING,
      lease_owner: 'dead-tab',
      lease_generation: 4,
      lease_expires_at: FIXED_NOW - 1,
    }))
    const manager = handles.manager(createPhotoUploadManager(managerOptions({
      db,
      clock,
      leaseOwner: 'tab-a',
      executeClaimedRecord: async (record) => {
        started.push({
          queueId: record.queue_id,
          status: record.status,
          generation: record.lease_generation,
        })
        await gate.promise
      },
    })))
    await manager.pump()
    await waitFor(() => started.length === 1)
    expect(started[0].status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(started[0].generation).toBe(5)
    const stored = await db.getRecord({
      queueId: 'queue-office-a-1',
      actorScopeType: 'office_user',
      actorScopeId: 'office-a',
    })
    expect(stored.status).toBe(PHOTO_UPLOAD_STATUSES.UPLOADING)
    expect(stored.lease_owner).toBe('tab-a')
    expect(stored.lease_generation).toBe(5)
  })
})

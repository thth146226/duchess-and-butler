/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
require('fake-indexeddb/auto')

import { PHOTO_UPLOAD_DB_NAME } from './lib/photoUploadDb'
import {
  HARNESS_META_DB_NAME,
  SAFARI_S12_MIN_BACKGROUND_MS,
  classifyBackgroundCycle,
  closeStaleWorkers,
  combineScenarioNine,
  createVisibilityCycle,
  hasDuplicateActiveWorker,
  noteWorkerEnd,
  noteWorkerStart,
  readRecoverableCycle,
  saveArmedSnapshot,
  readVisibilityCycle,
  recordHiddenTransition,
  recordVisibleReturn,
} from './safariS12Recovery'

const RUN_ID = 'run-s12'
const QUEUE_ID = 's12-04-upload-a'

function worker(overrides) {
  return {
    queue_id: QUEUE_ID,
    run_id: RUN_ID,
    started_at: 1,
    ended_at: null,
    in_flight: true,
    ...overrides,
  }
}

function classify(overrides) {
  return classifyBackgroundCycle({
    hiddenAt: 1_000,
    hiddenVisibilityState: 'hidden',
    visibleAt: 1_000 + SAFARI_S12_MIN_BACKGROUND_MS,
    now: 1_000 + SAFARI_S12_MIN_BACKGROUND_MS,
    workers: [worker()],
    runId: RUN_ID,
    bytesMatch: true,
    armedRecords: [{ queue_id: QUEUE_ID, start_count: 1 }],
    leaseTtlMs: 30000,
    ...overrides,
  })
}

function deleteMeta() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(HARNESS_META_DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve()
  })
}

beforeEach(async () => {
  await deleteMeta()
})

afterEach(async () => {
  await deleteMeta()
})

test('the synthetic visibility database is not the real photo queue', () => {
  expect(HARNESS_META_DB_NAME).not.toBe(PHOTO_UPLOAD_DB_NAME)
  expect(SAFARI_S12_MIN_BACKGROUND_MS).toBe(600000)
})

test('a return without a real hidden transition is inconclusive', () => {
  expect(classify({
    hiddenAt: null,
    hiddenVisibilityState: null,
    visibleAt: null,
    now: 5_000,
  })).toEqual({
    result: 'inconclusive',
    hidden_duration_ms: null,
    reason: 'no_hidden_transition',
  })
  expect(classify({
    hiddenAt: 1_000,
    hiddenVisibilityState: 'visible',
    visibleAt: 1_000,
    now: 1_000,
  }).result).toBe('inconclusive')
  expect(classify({
    visibleAt: 1_000,
    now: 1_000,
  })).toMatchObject({
    result: 'inconclusive',
    hidden_duration_ms: 0,
    reason: 'background_shorter_than_required',
  })
})

test('a real background shorter than 10 minutes does not pass', () => {
  const decision = classify({
    visibleAt: 1_000 + SAFARI_S12_MIN_BACKGROUND_MS - 1,
    now: 1_000 + SAFARI_S12_MIN_BACKGROUND_MS - 1,
  })
  expect(decision.result).toBe('inconclusive')
  expect(decision.hidden_duration_ms).toBe(SAFARI_S12_MIN_BACKGROUND_MS - 1)
  expect(decision.result).not.toBe('pass')
})

test('ten minutes with one active worker for the queue passes', () => {
  expect(classify().result).toBe('pass')
})

test('two active workers for the same queue and run fail', () => {
  const workers = [worker({ started_at: 1 }), worker({ started_at: 2 })]
  expect(hasDuplicateActiveWorker(workers, RUN_ID)).toBe(true)
  expect(classify({ workers }).reason).toBe('duplicate_worker')
})

test('a single resume after the lease window is not a duplicate', () => {
  const decision = classify({
    workers: [
      worker({ started_at: 1, in_flight: false, ended_at: 2 }),
      worker({ started_at: 3, in_flight: true }),
    ],
  })
  expect(decision.result).toBe('pass')
})

test('an extra start without a long background is an improper resume', () => {
  const decision = classify({
    hiddenAt: null,
    hiddenVisibilityState: null,
    visibleAt: null,
    now: 5_000,
    workers: [
      worker({ started_at: 1, in_flight: false, ended_at: 2 }),
      worker({ started_at: 3, in_flight: true }),
    ],
  })
  expect(decision.result).toBe('fail')
  expect(decision.reason).toBe('improper_resume')
})

test('workers from another run do not count as duplicates', () => {
  const decision = classify({
    workers: [
      worker(),
      worker({ run_id: 'other-run', started_at: 2 }),
      worker({ run_id: 'other-run', started_at: 3 }),
    ],
  })
  expect(decision.result).toBe('pass')
})

test('a foreground failure stays failed after the background cycle', () => {
  expect(combineScenarioNine('fail', 'pass')).toBe('fail')
  expect(combineScenarioNine('fail', 'inconclusive')).toBe('fail')
  expect(combineScenarioNine('pass', 'inconclusive')).toBe('inconclusive')
  expect(combineScenarioNine('pass', 'pass')).toBe('pass')
})

test('lost bytes fail even without a hidden timestamp', () => {
  expect(classify({
    hiddenAt: null,
    hiddenVisibilityState: null,
    visibleAt: null,
    bytesMatch: false,
  }).result).toBe('fail')
})

test('hidden and visible timestamps survive a new database connection', async () => {
  const names = []
  const nativeOpen = indexedDB.open.bind(indexedDB)
  indexedDB.open = function openObserved(name, version) {
    names.push(name)
    return nativeOpen(name, version)
  }
  try {
    await createVisibilityCycle(RUN_ID)
    expect(await recordHiddenTransition(RUN_ID, 5_000, 'visible')).toMatchObject({ hidden_at: null })
    await recordHiddenTransition(RUN_ID, 8_000, 'hidden')
    await recordHiddenTransition(RUN_ID, 9_000, 'hidden')
    expect(await readVisibilityCycle(RUN_ID)).toMatchObject({
      hidden_at: 8_000,
      hidden_visibility_state: 'hidden',
      visible_at: null,
    })
    expect((await readRecoverableCycle()).run_id).toBe(RUN_ID)
    const returned = await recordVisibleReturn(RUN_ID, 8_000 + SAFARI_S12_MIN_BACKGROUND_MS)
    expect(returned.hidden_duration_ms).toBe(SAFARI_S12_MIN_BACKGROUND_MS)
    const kept = await recordVisibleReturn(RUN_ID, 99_000)
    expect(kept.visible_at).toBe(returned.visible_at)
    expect(await readRecoverableCycle()).toBeNull()
    expect(names.every((name) => name === HARNESS_META_DB_NAME)).toBe(true)
    await saveArmedSnapshot(RUN_ID, [{ queue_id: QUEUE_ID, start_count: 1 }], 'page-token', 'fail')
    expect(await readVisibilityCycle(RUN_ID)).toMatchObject({ foreground_result: 'fail' })
    expect(names).not.toContain(PHOTO_UPLOAD_DB_NAME)
  } finally {
    indexedDB.open = nativeOpen
  }
})

test('worker notes keep one active worker per queue inside the run', async () => {
  await createVisibilityCycle(RUN_ID)
  await Promise.all([
    noteWorkerStart(RUN_ID, QUEUE_ID, 11),
    noteWorkerStart(RUN_ID, 's12-05-upload-b', 12),
  ])
  await noteWorkerStart(RUN_ID, QUEUE_ID, 11)
  let cycle = await readVisibilityCycle(RUN_ID)
  expect(cycle.workers).toHaveLength(2)
  expect(hasDuplicateActiveWorker(cycle.workers, RUN_ID)).toBe(false)
  await noteWorkerStart(RUN_ID, QUEUE_ID, 13)
  cycle = await readVisibilityCycle(RUN_ID)
  expect(hasDuplicateActiveWorker(cycle.workers, RUN_ID)).toBe(true)
  await noteWorkerEnd(RUN_ID, QUEUE_ID, 11, 14)
  cycle = await readVisibilityCycle(RUN_ID)
  expect(hasDuplicateActiveWorker(cycle.workers, RUN_ID)).toBe(false)
  cycle = await closeStaleWorkers(RUN_ID, 15)
  expect(cycle.workers.some((entry) => entry.in_flight)).toBe(false)
  expect(cycle.workers.filter((entry) => entry.started_at !== 11).every((entry) => entry.ended_reason === 'reloaded')).toBe(true)
})

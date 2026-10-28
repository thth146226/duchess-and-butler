/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */

import {
  EXPECTED_INJECTED_FAULT,
  SAFARI_BLOB_PREPARATION_MESSAGE,
  backgroundCycleAllowed,
  blobOriginLabel,
  classifyScenario7,
  isExpectedInjectedFault,
} from './safariS12Scenario7'

const recovered = {
  abortBytesMatch: true,
  abortAttempts: 0,
  faultInjectionExpected: true,
  faultStore: EXPECTED_INJECTED_FAULT.store,
  callerName: EXPECTED_INJECTED_FAULT.name,
  callerMessage: EXPECTED_INJECTED_FAULT.message,
  idbBytesMatch: true,
  idbAttempts: 0,
  payloadInitialMatch: true,
  payloadObserved: true,
  payloadStarts: 0,
  payloadAttempts: 0,
  payloadDiscarded: true,
  unexpectedNative: false,
}

test('the Safari blob preparation error is not the injected fault', () => {
  expect(isExpectedInjectedFault({
    faultInjectionExpected: false,
    store: 'photo_upload_payloads',
    callerName: 'UnknownError',
    callerMessage: SAFARI_BLOB_PREPARATION_MESSAGE,
  })).toBe(false)
  expect(classifyScenario7({
    ...recovered,
    faultInjectionExpected: false,
    faultStore: 'photo_upload_payloads',
    callerMessage: SAFARI_BLOB_PREPARATION_MESSAGE,
    unexpectedNative: true,
  })).toEqual({ result: 'fail', reason: 'unexpected_native_error' })
})

test('UnknownError alone does not pass the injected fault', () => {
  expect(classifyScenario7({
    ...recovered,
    callerMessage: SAFARI_BLOB_PREPARATION_MESSAGE,
  }).result).toBe('fail')
  expect(classifyScenario7({
    ...recovered,
    faultInjectionExpected: false,
  }).result).toBe('fail')
})

test('the intentional queue fault passes only when the bytes and attempts stay intact', () => {
  expect(classifyScenario7(recovered)).toEqual({
    result: 'pass',
    reason: 'expected_fault_recovered',
  })
  expect(classifyScenario7({ ...recovered, idbAttempts: 1 }).result).toBe('fail')
  expect(classifyScenario7({ ...recovered, idbBytesMatch: false }).result).toBe('fail')
  expect(classifyScenario7({ ...recovered, payloadAttempts: 1 }).result).toBe('fail')
  expect(classifyScenario7({ ...recovered, payloadDiscarded: false }).result).toBe('fail')
  expect(classifyScenario7({ ...recovered, payloadInitialMatch: false }).result).toBe('fail')
})

test('a payload blob read from IndexedDB is not labeled as the synthetic source', () => {
  expect(blobOriginLabel({ hasBlob: true, synthetic: true, fromIndexedDb: false })).toBe('synthetic_memory')
  expect(blobOriginLabel({ hasBlob: true, synthetic: false, fromIndexedDb: true })).toBe('indexeddb_result')
  expect(blobOriginLabel({ hasBlob: false, synthetic: false, fromIndexedDb: false })).toBe('absent')
})

test('an interrupted automatic run is not a background cycle', () => {
  expect(backgroundCycleAllowed({ autoCompleted: false, runPublished: false })).toBe(false)
  expect(backgroundCycleAllowed({ autoCompleted: false, runPublished: true })).toBe(false)
  expect(backgroundCycleAllowed({ autoCompleted: true, runPublished: true })).toBe(true)
})

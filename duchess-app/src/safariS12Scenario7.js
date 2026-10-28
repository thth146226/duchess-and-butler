export const EXPECTED_INJECTED_FAULT = Object.freeze({
  store: 'photo_upload_queue',
  name: 'UnknownError',
  message: 'An internal error was encountered in the Indexed Database server',
})

export const SAFARI_BLOB_PREPARATION_MESSAGE = 'Error preparing Blob/File data to be stored in object store'

export function blobOriginLabel({ hasBlob, synthetic, fromIndexedDb }) {
  if (!hasBlob) {
    return 'absent'
  }
  if (synthetic) {
    return 'synthetic_memory'
  }
  if (fromIndexedDb) {
    return 'indexeddb_result'
  }
  return 'unknown'
}

export function isExpectedInjectedFault({ faultInjectionExpected, store, callerName, callerMessage }) {
  return faultInjectionExpected === true
    && store === EXPECTED_INJECTED_FAULT.store
    && callerName === EXPECTED_INJECTED_FAULT.name
    && callerMessage === EXPECTED_INJECTED_FAULT.message
}

export function classifyScenario7({
  abortBytesMatch,
  abortAttempts,
  faultInjectionExpected,
  faultStore,
  callerName,
  callerMessage,
  idbBytesMatch,
  idbAttempts,
  payloadInitialMatch,
  payloadObserved,
  payloadStarts,
  payloadAttempts,
  payloadDiscarded,
  unexpectedNative,
}) {
  const abortOk = abortBytesMatch === true && abortAttempts === 0
  const injectedOk = isExpectedInjectedFault({
    faultInjectionExpected,
    store: faultStore,
    callerName,
    callerMessage,
  }) && idbBytesMatch === true && idbAttempts === 0
  const payloadOk = payloadInitialMatch === true
    && payloadObserved === true
    && payloadStarts === 0
    && payloadAttempts === 0
    && payloadDiscarded === true
  if (unexpectedNative) {
    return { result: 'fail', reason: 'unexpected_native_error' }
  }
  if (abortOk && injectedOk && payloadOk) {
    return { result: 'pass', reason: 'expected_fault_recovered' }
  }
  if (faultInjectionExpected === true && !isExpectedInjectedFault({
    faultInjectionExpected,
    store: faultStore,
    callerName,
    callerMessage,
  })) {
    return { result: 'fail', reason: 'injected_fault_not_the_observed_error' }
  }
  return { result: 'fail', reason: 'contract_not_met' }
}

export function backgroundCycleAllowed({ autoCompleted, runPublished }) {
  return autoCompleted === true && runPublished === true
}

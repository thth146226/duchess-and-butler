// Server-only Alert Pipeline baseline RPC adapters (Commit 1 foundation).
// Never import from frontend/src code.
// Mutations go exclusively through reviewed SECURITY DEFINER RPCs.
// Do not call Current RMS, Auto Poll, or Telegram from this module.

export const RMS_ALERT_SOURCE = 'auto_poll_rms'

export const BOOTSTRAP_RPC = 'bootstrap_rms_alert_job_state'
export const OBSERVATION_EVIDENCE_RPC = 'record_rms_alert_item_observation_evidence'
export const TRANSITION_RPC = 'commit_rms_alert_item_transition'

function requireSupabase(supabase) {
  if (!supabase || typeof supabase.rpc !== 'function') {
    throw new Error('Supabase client with rpc() is required for rms alert baseline operations.')
  }
}

function asIsoTimestamp(value) {
  if (value == null) return new Date().toISOString()
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * Bootstrap alert baseline for one job from a pre-validated RMS snapshot.
 * Does not fetch Current RMS. Does not emit operational events.
 */
export async function bootstrapRmsAlertJobState(supabase, {
  jobId,
  observedAt,
  items,
  allowEmpty = false,
} = {}) {
  requireSupabase(supabase)

  if (!jobId) {
    return { status: 'INVALID_INPUT', error: 'jobId is required' }
  }
  if (!Array.isArray(items)) {
    return { status: 'INVALID_INPUT', error: 'items must be an array' }
  }

  const { data, error } = await supabase.rpc(BOOTSTRAP_RPC, {
    p_job_id: jobId,
    p_observed_at: asIsoTimestamp(observedAt),
    p_items: items,
    p_allow_empty: Boolean(allowEmpty),
  })

  if (error) {
    throw new Error(error.message || 'bootstrap_rms_alert_job_state failed')
  }

  return data
}

/**
 * Record removal-candidate / presence-clear evidence only.
 * Does not advance committed baseline generations.
 */
export async function recordRmsAlertItemObservationEvidence(supabase, {
  jobId,
  crmsItemId,
  pollRunId,
  isMissing,
  observedAt,
} = {}) {
  requireSupabase(supabase)

  if (!jobId || !crmsItemId || !pollRunId || typeof isMissing !== 'boolean') {
    return { status: 'INVALID_INPUT' }
  }

  const { data, error } = await supabase.rpc(OBSERVATION_EVIDENCE_RPC, {
    p_job_id: jobId,
    p_crms_item_id: String(crmsItemId),
    p_poll_run_id: pollRunId,
    p_is_missing: isMissing,
    p_observed_at: asIsoTimestamp(observedAt),
  })

  if (error) {
    throw new Error(error.message || 'record_rms_alert_item_observation_evidence failed')
  }

  return data
}

/**
 * Commit one eligible alert-item transition atomically via RPC.
 * Observation completeness (G-G) must be enforced by the caller before removal.
 */
export async function commitRmsAlertItemTransition(supabase, {
  jobId,
  crmsItemId,
  expectedStateVersion,
  observedIsPresent,
  observedItemName = '',
  observedItemCategory = '',
  observedQuantity = 0,
  observedAt,
} = {}) {
  requireSupabase(supabase)

  if (
    !jobId ||
    !crmsItemId ||
    expectedStateVersion == null ||
    typeof observedIsPresent !== 'boolean'
  ) {
    return { status: 'INVALID_INPUT' }
  }

  const { data, error } = await supabase.rpc(TRANSITION_RPC, {
    p_job_id: jobId,
    p_crms_item_id: String(crmsItemId),
    p_expected_state_version: Number(expectedStateVersion),
    p_observed_is_present: observedIsPresent,
    p_observed_item_name: observedItemName == null ? '' : String(observedItemName),
    p_observed_item_category: observedItemCategory == null ? '' : String(observedItemCategory),
    p_observed_quantity: Number.isFinite(Number(observedQuantity))
      ? Number(observedQuantity)
      : 0,
    p_observed_at: asIsoTimestamp(observedAt),
  })

  if (error) {
    throw new Error(error.message || 'commit_rms_alert_item_transition failed')
  }

  return data
}

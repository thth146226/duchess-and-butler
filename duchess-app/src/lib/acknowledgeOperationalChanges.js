import { supabase } from './supabase'

export function canAcknowledgeOperationalChanges(role) {
  return role === 'admin' || role === 'operations'
}

export async function acknowledgeOperationalChanges({ eventIds } = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  const token = session?.access_token
  if (!token) {
    throw new Error('Session expired. Please reload and sign in again.')
  }

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    throw new Error('At least one event id is required.')
  }

  const res = await fetch('/api/operational-change-events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: 'acknowledge',
      eventIds,
    }),
  })

  let json = {}
  try {
    json = await res.json()
  } catch {
    json = {}
  }

  if (!res.ok) {
    throw new Error(json.error || 'Failed to acknowledge operational change events.')
  }

  return json
}

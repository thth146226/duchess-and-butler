import { createClient } from '@supabase/supabase-js'

export class HttpError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.statusCode = statusCode
  }
}

export function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase server credentials are not configured.')
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

export async function requireAdminOrOperations(req) {
  const authHeader = req.headers.authorization || ''

  if (!authHeader.startsWith('Bearer ')) {
    throw new HttpError('Unauthorised', 401)
  }

  const token = authHeader.slice(7).trim()
  if (!token) {
    throw new HttpError('Unauthorised', 401)
  }

  const supabase = getSupabaseAdminClient()

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token)

  if (userError || !user) {
    throw new HttpError('Unauthorised', 401)
  }

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('id, role, active, name')
    .eq('id', user.id)
    .single()

  if (profileError || !profile) {
    throw new HttpError('Forbidden', 403)
  }

  if (profile.active === false) {
    throw new HttpError('Your account is inactive.', 403)
  }

  if (profile.role !== 'admin' && profile.role !== 'operations') {
    throw new HttpError('Only admin and operations users can refresh from RMS.', 403)
  }

  return { supabase, user, profile }
}

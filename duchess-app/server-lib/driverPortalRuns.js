const { createClient } = require('@supabase/supabase-js')

const TOKEN_MAX_AGE_DAYS = 7
const LONDON_TZ = 'Europe/London'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class HttpError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.statusCode = statusCode
  }
}

function normaliseScheduleText(value) {
  return String(value || '').trim().toLowerCase()
}

function isManualTdsScheduleOrder(job) {
  return (
    job?.is_manual === true &&
    normaliseScheduleText(job.event_name) === 'tds' &&
    normaliseScheduleText(job.client_name) === 'tds' &&
    normaliseScheduleText(job.venue) === 'tds'
  )
}

function isUuid(value) {
  return UUID_RE.test(String(value || '').trim())
}

/** Current calendar date in Europe/London as YYYY-MM-DD. Optional Date for tests. */
function getLondonDateString(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  if (!year || !month || !day) {
    throw new Error('Failed to resolve Europe/London calendar date.')
  }
  return `${year}-${month}-${day}`
}

/**
 * Accept YYYY-MM-DD, or YYYY-MM-DD plus a strict ISO-style time suffix.
 * Separator must be literal T or a single normal space (not tab/newline).
 * Optional :ss, fractional seconds, Z, or numeric offset in exact +/-HH:MM form.
 * Rejects malformed / impossible calendar dates and arbitrary trailing text.
 */
function normaliseRunDate(value) {
  if (value == null || value === '') return null
  const text = String(value).trim()

  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const dateTime = text.match(
    /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?$/,
  )
  const match = dateOnly || dateTime
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null
  }

  if (dateTime) {
    const hour = Number(match[5])
    const minute = Number(match[6])
    const second = match[7] == null ? 0 : Number(match[7])
    if (
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      !Number.isFinite(second)
    ) {
      return null
    }

    // Groups: 9 = sign, 10 = offset hour, 11 = offset minute (exact +/-HH:MM only).
    if (match[9] != null) {
      const offsetHour = Number(match[10])
      const offsetMinute = Number(match[11])
      if (
        !Number.isFinite(offsetHour) ||
        !Number.isFinite(offsetMinute) ||
        offsetHour > 14 ||
        offsetMinute > 59 ||
        (offsetHour === 14 && offsetMinute !== 0)
      ) {
        return null
      }
    }
  }

  return `${match[1]}-${match[2]}-${match[3]}`
}

function isRunDateCurrentOrFuture(dateValue, today = getLondonDateString()) {
  const date = normaliseRunDate(dateValue)
  if (!date) return false
  return date >= today
}

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase server credentials are not configured.')
  }

  return createClient(supabaseUrl, supabaseServiceKey)
}

function normaliseToken(token) {
  if (token == null) return ''
  return String(token).trim()
}

async function resolveDriverByToken(supabase, token) {
  const normalized = normaliseToken(token)
  if (!normalized) {
    throw new HttpError('Missing access token.', 400)
  }

  const { data, error } = await supabase
    .from('drivers')
    .select('id, name, colour, active, token_created_at, access_token')
    .eq('access_token', normalized)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || 'Failed to validate driver token.')
  }

  if (!data) {
    throw new HttpError('Invalid or expired link.', 401)
  }

  if (data.active === false) {
    throw new HttpError('This driver link is no longer active. Please ask your manager for a new link.', 403)
  }

  if (data.token_created_at) {
    const created = new Date(data.token_created_at)
    const daysSince = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince > TOKEN_MAX_AGE_DAYS) {
      throw new HttpError('This link has expired. Please ask your manager for a new link.', 403)
    }
  }

  return {
    id: data.id,
    name: data.name,
    colour: data.colour,
  }
}

function driverNameMatches(field, driverName) {
  return Boolean(field && driverName && field === driverName)
}

function driverIdMatches(field, driverId) {
  return Boolean(field && driverId && field === driverId)
}

function isJobAssignedToDriver(job, driver) {
  return (
    driverNameMatches(job.assigned_driver_name, driver.name) ||
    driverNameMatches(job.assigned_driver_name_2, driver.name) ||
    driverNameMatches(job.col_driver_name, driver.name) ||
    driverNameMatches(job.col_driver_name_2, driver.name) ||
    driverIdMatches(job.assigned_driver_id, driver.id) ||
    driverIdMatches(job.assigned_driver_id_2, driver.id)
  )
}

/** Same job-level filter as DriverPortal fetchJobs — at least one pending run for this driver. */
function jobHasPendingRunForDriver(job, driver) {
  const delPending = isDelRunForDriver(job, driver) && !job.delivery_done
  const colPending = isColRunForDriver(job, driver) && !job.collection_done
  return delPending || colPending
}

/** True when a collection-driver field has a non-blank value. */
function hasExplicitCollectionDriverName(value) {
  return String(value ?? '').trim() !== ''
}

function hasExplicitCollectionDriver(job) {
  return (
    hasExplicitCollectionDriverName(job?.col_driver_name) ||
    hasExplicitCollectionDriverName(job?.col_driver_name_2)
  )
}

function shouldSkipJobForRunBuild(job) {
  if (job.deleted) return true
  if (job.status === 'cancelled') return true

  if (job.crms_id !== null && job.crms_id !== undefined) {
    if (!job.delivery_date && !job.collection_date) return true
  } else if (job.status === 'pending') {
    return true
  }

  return false
}

function isDelRunForDriver(job, driver) {
  return (
    driverNameMatches(job.assigned_driver_name, driver.name) ||
    driverNameMatches(job.assigned_driver_name_2, driver.name) ||
    driverIdMatches(job.assigned_driver_id, driver.id) ||
    driverIdMatches(job.assigned_driver_id_2, driver.id)
  )
}

function isColRunForDriver(job, driver) {
  // Explicit COL assignment takes precedence over delivery-driver fallback.
  if (hasExplicitCollectionDriver(job)) {
    return (
      driverNameMatches(job.col_driver_name, driver.name) ||
      driverNameMatches(job.col_driver_name_2, driver.name)
    )
  }

  // Legacy jobs with no collection driver still fall back to assigned DEL drivers.
  return (
    driverNameMatches(job.assigned_driver_name, driver.name) ||
    driverNameMatches(job.assigned_driver_name_2, driver.name)
  )
}

function getEffectiveDelDate(job) {
  return normaliseRunDate(job.manual_delivery_date || job.delivery_date)
}

function getEffectiveColDate(job) {
  return normaliseRunDate(job.manual_collection_date || job.collection_date)
}

/** True when the driver has at least one incomplete DEL/COL run dated today or later (London). */
function jobHasVisiblePortalRunForDriver(job, driver, today = getLondonDateString()) {
  if (shouldSkipJobForRunBuild(job)) return false

  const delVisible =
    isRunDateCurrentOrFuture(job.manual_delivery_date || job.delivery_date, today) &&
    !job.delivery_done &&
    isDelRunForDriver(job, driver)

  const colVisible =
    isRunDateCurrentOrFuture(job.manual_collection_date || job.collection_date, today) &&
    !job.collection_done &&
    isColRunForDriver(job, driver)

  return Boolean(delVisible || colVisible)
}

function buildPortalRuns(jobs, driver, today = getLondonDateString()) {
  const runs = []

  for (const job of jobs) {
    if (shouldSkipJobForRunBuild(job)) continue

    const delDate = getEffectiveDelDate(job)
    const delTime = job.manual_delivery_time || job.delivery_time
    const colDate = getEffectiveColDate(job)
    const colTime = job.manual_collection_time || job.collection_time

    let delEndTime = job.manual_delivery_time
      ? null
      : job.delivery_end_time?.substring(0, 5) || null
    if (
      isManualTdsScheduleOrder(job) &&
      delTime &&
      !delEndTime &&
      !job.manual_delivery_time
    ) {
      delEndTime = '17:00'
    }

    let colEndTime = job.manual_collection_time
      ? null
      : job.collection_end_time?.substring(0, 5) || null
    if (
      isManualTdsScheduleOrder(job) &&
      colTime &&
      !colEndTime &&
      !job.manual_collection_time
    ) {
      colEndTime = '17:00'
    }

    const isDelTimed = !!(delEndTime && !['17:00', '18:00', '00:00'].includes(delEndTime))
    const isColTimed = !!(colEndTime && !['17:00', '18:00', '00:00'].includes(colEndTime))

    if (
      isRunDateCurrentOrFuture(job.manual_delivery_date || job.delivery_date, today) &&
      !job.delivery_done &&
      isDelRunForDriver(job, driver)
    ) {
      runs.push({
        job,
        type: 'DEL',
        date: delDate,
        time: delTime?.substring(0, 5) || null,
        endTime: delEndTime || null,
        isTimed: isDelTimed,
        sortOrder: job.manual_sort_order || 0,
      })
    }

    if (
      isRunDateCurrentOrFuture(job.manual_collection_date || job.collection_date, today) &&
      !job.collection_done &&
      isColRunForDriver(job, driver)
    ) {
      runs.push({
        job,
        type: 'COL',
        date: colDate,
        time: colTime?.substring(0, 5) || null,
        endTime: colEndTime || null,
        isTimed: isColTimed,
        sortOrder: job.manual_sort_order || 0,
      })
    }
  }

  runs.sort((a, b) => {
    const d = (a.date || '').localeCompare(b.date || '')
    if (d !== 0) return d
    const aHasOrder = (a.sortOrder || 0) > 0
    const bHasOrder = (b.sortOrder || 0) > 0
    if (aHasOrder || bHasOrder) return (a.sortOrder || 0) - (b.sortOrder || 0)
    return (a.time || '99:99').localeCompare(b.time || '99:99')
  })

  return runs
}

function sanitizeJobForPortal(job) {
  if (!job || typeof job !== 'object') return job
  const { crms_raw, ...safe } = job
  return safe
}

function runToResponse(run) {
  return {
    id: `${run.job.id}-${run.type}`,
    type: run.type,
    date: run.date,
    time: run.time,
    endTime: run.endTime,
    isTimed: run.isTimed,
    sortOrder: run.sortOrder,
    job: sanitizeJobForPortal(run.job),
  }
}

async function fetchMergedJobsForDriver(supabase, driver) {
  const [crmsRes, ordersRes] = await Promise.all([
    supabase
      .from('crms_jobs')
      .select('*')
      .not('status', 'eq', 'cancelled')
      .order('delivery_date', { ascending: true, nullsFirst: false }),
    supabase
      .from('orders')
      .select('*')
      .eq('deleted', false)
      .order('delivery_date', { ascending: true, nullsFirst: false }),
  ])

  if (crmsRes.error) {
    throw new Error(crmsRes.error.message || 'Failed to load CRMS jobs.')
  }
  if (ordersRes.error) {
    throw new Error(ordersRes.error.message || 'Failed to load manual orders.')
  }

  const manualJobs = (ordersRes.data || []).map((order) => ({
    ...order,
    crms_id: null,
    crms_ref: order.ref,
    is_manual: true,
  }))

  const merged = [...(crmsRes.data || []), ...manualJobs]

  return merged.filter(
    (job) => isJobAssignedToDriver(job, driver) && jobHasPendingRunForDriver(job, driver),
  )
}

async function attachItemsToJobs(supabase, jobs) {
  if (!jobs.length) return jobs

  const crmsJobIds = jobs.filter((j) => j.crms_id != null).map((j) => j.id)
  const manualOrderIds = jobs.filter((j) => j.is_manual).map((j) => j.id)

  const [crmsItemsRes, orderItemsRes] = await Promise.all([
    crmsJobIds.length
      ? supabase.from('crms_job_items').select('*').in('job_id', crmsJobIds)
      : Promise.resolve({ data: [], error: null }),
    manualOrderIds.length
      ? supabase.from('order_items').select('*').in('order_id', manualOrderIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (crmsItemsRes.error) {
    throw new Error(crmsItemsRes.error.message || 'Failed to load CRMS job items.')
  }
  if (orderItemsRes.error) {
    throw new Error(orderItemsRes.error.message || 'Failed to load order items.')
  }

  const itemsByJobId = {}

  for (const item of crmsItemsRes.data || []) {
    if (!itemsByJobId[item.job_id]) itemsByJobId[item.job_id] = []
    itemsByJobId[item.job_id].push(item)
  }

  for (const item of orderItemsRes.data || []) {
    const jobId = item.order_id
    if (!itemsByJobId[jobId]) itemsByJobId[jobId] = []
    itemsByJobId[jobId].push(item)
  }

  return jobs.map((job) => ({
    ...job,
    items: itemsByJobId[job.id] || [],
  }))
}

async function getDriverPortalRuns(token, { now, supabase: injected } = {}) {
  const supabase = injected || getSupabaseAdminClient()
  const driver = await resolveDriverByToken(supabase, token)
  const assignedJobs = await fetchMergedJobsForDriver(supabase, driver)
  const today = getLondonDateString(now)
  // Drop jobs with only historical pending runs before loading line items.
  const visibleJobs = assignedJobs.filter((job) =>
    jobHasVisiblePortalRunForDriver(job, driver, today),
  )
  const jobsWithItems = await attachItemsToJobs(supabase, visibleJobs)
  const runs = buildPortalRuns(jobsWithItems, driver, today)

  return {
    ok: true,
    driver,
    runs: runs.map(runToResponse),
  }
}

function parseMarkDoneBody(body) {
  const raw = body && typeof body === 'object' ? body : {}
  const token = normaliseToken(raw.token)
  const jobId = raw.jobId == null ? '' : String(raw.jobId).trim()
  const type = raw.type == null ? '' : String(raw.type).trim().toUpperCase()

  if (!token) throw new HttpError('Missing access token.', 400)
  if (!jobId) throw new HttpError('Missing jobId.', 400)
  if (!isUuid(jobId)) throw new HttpError('Invalid jobId.', 400)
  if (type !== 'DEL' && type !== 'COL') {
    throw new HttpError('Invalid type. Expected DEL or COL.', 400)
  }

  return { token, jobId, type }
}

/** Server-side table/field selection — never trust client-supplied table or field. */
function getCompletionTarget(job, type) {
  const table = job?.is_manual === true ? 'orders' : 'crms_jobs'
  const field = type === 'DEL' ? 'delivery_done' : 'collection_done'
  return { table, field }
}

async function findAssignedJobForDriver(supabase, driver, jobId) {
  const id = String(jobId || '').trim()
  if (!id) throw new HttpError('Missing jobId.', 400)
  if (!isUuid(id)) throw new HttpError('Invalid jobId.', 400)

  const [crmsRes, orderRes] = await Promise.all([
    supabase.from('crms_jobs').select('*').eq('id', id).maybeSingle(),
    supabase.from('orders').select('*').eq('id', id).eq('deleted', false).maybeSingle(),
  ])

  if (crmsRes.error) {
    throw new Error(crmsRes.error.message || 'Failed to load job.')
  }
  if (orderRes.error) {
    throw new Error(orderRes.error.message || 'Failed to load order.')
  }

  // Prefer manual orders when present — they carry is_manual and live in public.orders.
  let job = null
  if (orderRes.data) {
    job = {
      ...orderRes.data,
      crms_id: null,
      crms_ref: orderRes.data.ref,
      is_manual: true,
    }
  } else if (crmsRes.data) {
    job = crmsRes.data
  }

  if (!job) {
    throw new HttpError('Run not found.', 404)
  }
  // Same listing eligibility: pending manual, cancelled, deleted, undated RMS, etc.
  if (shouldSkipJobForRunBuild(job)) {
    throw new HttpError('Run not found.', 404)
  }
  if (!isJobAssignedToDriver(job, driver)) {
    throw new HttpError('Run not found.', 404)
  }

  return job
}

async function markDriverPortalRunDone(input, { now, supabase: injected } = {}) {
  const { token, jobId, type } = parseMarkDoneBody(input)
  const supabase = injected || getSupabaseAdminClient()
  const driver = await resolveDriverByToken(supabase, token)
  const job = await findAssignedJobForDriver(supabase, driver, jobId)

  if (type === 'DEL') {
    if (!isDelRunForDriver(job, driver)) {
      throw new HttpError('Run not found.', 404)
    }
  } else if (!isColRunForDriver(job, driver)) {
    throw new HttpError('Run not found.', 404)
  }

  const runDate = type === 'DEL' ? getEffectiveDelDate(job) : getEffectiveColDate(job)
  if (!runDate) {
    throw new HttpError('Run date is missing.', 400)
  }

  const today = getLondonDateString(now)
  if (runDate > today) {
    throw new HttpError('Cannot mark future runs as done.', 409)
  }
  if (runDate < today) {
    throw new HttpError('Cannot mark historical runs as done.', 409)
  }

  const doneField = type === 'DEL' ? 'delivery_done' : 'collection_done'
  if (job[doneField]) {
    throw new HttpError('Run is already completed.', 409)
  }

  const { table, field } = getCompletionTarget(job, type)

  const { data, error } = await supabase
    .from(table)
    .update({ [field]: true })
    .eq('id', jobId)
    .eq(field, false)
    .select('id')

  if (error) {
    throw new Error(error.message || 'Failed to update run.')
  }

  const rows = data || []
  if (rows.length === 0) {
    // Conditional false→true matched nothing (race / already completed).
    throw new HttpError('Run is already completed.', 409)
  }
  if (rows.length !== 1) {
    throw new Error('Unexpected number of rows updated.')
  }

  return {
    ok: true,
    jobId,
    type,
  }
}

module.exports = {
  HttpError,
  getDriverPortalRuns,
  markDriverPortalRunDone,
  getLondonDateString,
  normaliseRunDate,
  isRunDateCurrentOrFuture,
  buildPortalRuns,
  jobHasVisiblePortalRunForDriver,
  getCompletionTarget,
  parseMarkDoneBody,
  getEffectiveDelDate,
  getEffectiveColDate,
  isDelRunForDriver,
  isColRunForDriver,
  shouldSkipJobForRunBuild,
}

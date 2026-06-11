const { createClient } = require('@supabase/supabase-js')

const TOKEN_MAX_AGE_DAYS = 7

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
  const delAssigned =
    driverNameMatches(job.assigned_driver_name, driver.name) ||
    driverNameMatches(job.assigned_driver_name_2, driver.name) ||
    driverIdMatches(job.assigned_driver_id, driver.id) ||
    driverIdMatches(job.assigned_driver_id_2, driver.id)

  const colAssigned =
    driverNameMatches(job.col_driver_name, driver.name) ||
    driverNameMatches(job.col_driver_name_2, driver.name) ||
    driverNameMatches(job.assigned_driver_name, driver.name) ||
    driverNameMatches(job.assigned_driver_name_2, driver.name)

  const delPending = delAssigned && !job.delivery_done
  const colPending = colAssigned && !job.collection_done

  return delPending || colPending
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
  return (
    driverNameMatches(job.assigned_driver_name, driver.name) ||
    driverNameMatches(job.assigned_driver_name_2, driver.name) ||
    driverNameMatches(job.col_driver_name, driver.name) ||
    driverNameMatches(job.col_driver_name_2, driver.name)
  )
}

function buildPortalRuns(jobs, driver) {
  const runs = []

  for (const job of jobs) {
    if (shouldSkipJobForRunBuild(job)) continue

    const delDate = job.manual_delivery_date || job.delivery_date
    const delTime = job.manual_delivery_time || job.delivery_time
    const colDate = job.manual_collection_date || job.collection_date
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

    if (delDate && !job.delivery_done && isDelRunForDriver(job, driver)) {
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

    if (colDate && !job.collection_done && isColRunForDriver(job, driver)) {
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

async function getDriverPortalRuns(token) {
  const supabase = getSupabaseAdminClient()
  const driver = await resolveDriverByToken(supabase, token)
  const assignedJobs = await fetchMergedJobsForDriver(supabase, driver)
  const jobsWithItems = await attachItemsToJobs(supabase, assignedJobs)
  const runs = buildPortalRuns(jobsWithItems, driver)

  return {
    ok: true,
    driver,
    runs: runs.map(runToResponse),
  }
}

module.exports = {
  HttpError,
  getDriverPortalRuns,
}

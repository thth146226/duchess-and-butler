const { existsSync } = require('node:fs')
const { createClient } = require('@supabase/supabase-js')
const puppeteer = require('puppeteer-core')
const chromium = require('@sparticuz/chromium')
const {
  PAPERWORK_LOGO_URL,
  buildDeliveryNoteFilename,
  buildDeliveryNoteHtml,
} = require('../src/lib/paperworkDeliveryNoteTemplate')

const DEFAULT_VIEWPORT = {
  width: 1240,
  height: 1754,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  isLandscape: false,
}

const LOCAL_BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean)

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase server credentials are not configured for PDF generation.')
  }

  return createClient(supabaseUrl, supabaseServiceKey)
}

function parseRequestBody(req) {
  try {
    if (!req.body) return {}
    if (typeof req.body === 'string') return JSON.parse(req.body)
    return req.body
  } catch {
    const error = new Error('Invalid JSON body.')
    error.statusCode = 400
    throw error
  }
}

function resolveLocalBrowserPath() {
  return LOCAL_BROWSER_CANDIDATES.find((candidate) => candidate && existsSync(candidate)) || null
}

async function launchBrowser() {
  if (process.platform === 'linux') {
    chromium.setGraphicsMode = false

    return puppeteer.launch({
      args: puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      defaultViewport: DEFAULT_VIEWPORT,
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    })
  }

  const localExecutablePath = resolveLocalBrowserPath()
  if (!localExecutablePath) {
    throw new Error('Local Chromium or Chrome was not found. Set PUPPETEER_EXECUTABLE_PATH to test PDF generation outside Vercel.')
  }

  return puppeteer.launch({
    defaultViewport: DEFAULT_VIEWPORT,
    executablePath: localExecutablePath,
    headless: true,
  })
}

async function getLogoDataUrl() {
  try {
    const response = await fetch(PAPERWORK_LOGO_URL)
    if (!response.ok) return null

    const arrayBuffer = await response.arrayBuffer()
    const mimeType = response.headers.get('content-type') || 'image/png'
    return `data:${mimeType};base64,${Buffer.from(arrayBuffer).toString('base64')}`
  } catch {
    return null
  }
}

async function fetchPaperworkJobData(jobId) {
  const supabase = getSupabaseAdminClient()

  const [{ data: job, error: jobError }, { data: notes, error: notesError }] = await Promise.all([
    supabase
      .from('crms_jobs')
      .select('*, crms_job_items(*)')
      .eq('id', jobId)
      .single(),
    supabase
      .from('job_notes')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true }),
  ])

  if (jobError) {
    if (jobError.code === 'PGRST116') return { job: null, notes: [] }
    throw new Error(jobError.message)
  }

  return {
    job,
    notes: notesError ? [] : (notes || []),
  }
}

function buildPdfFooterTemplate() {
  return `
    <div style="width:100%;padding:0 17mm 3mm;font-family:Arial, Helvetica, sans-serif;font-size:8px;color:#6B6860;text-align:right;">
      Page <span class="pageNumber"></span> of <span class="totalPages"></span>
    </div>
  `
}

function buildDispositionHeader(filename) {
  const safeFilename = filename.replace(/"/g, '')
  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let browser = null

  try {
    const body = parseRequestBody(req)
    const jobId = typeof body?.jobId === 'string' ? body.jobId.trim() : ''

    if (!jobId) {
      return res.status(400).json({ error: 'Missing required jobId.' })
    }

    const { job, notes } = await fetchPaperworkJobData(jobId)

    if (!job) {
      return res.status(404).json({ error: 'Paperwork job not found.' })
    }

    if (!job.delivery_date) {
      return res.status(400).json({ error: 'This job does not have a delivery note to export.' })
    }

    const logoDataUrl = await getLogoDataUrl()
    const html = buildDeliveryNoteHtml({
      job,
      notes,
      type: 'DEL',
      logoSrc: logoDataUrl || PAPERWORK_LOGO_URL,
      autoPrint: false,
    })

    browser = await launchBrowser()
    const page = await browser.newPage()

    await page.setContent(html, { waitUntil: 'networkidle0' })
    await page.emulateMediaType('print')

    const pdfBytes = await page.pdf({
      format: 'A4',
      landscape: false,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: buildPdfFooterTemplate(),
      margin: {
        top: '24mm',
        right: '17mm',
        bottom: '22mm',
        left: '17mm',
      },
    })

    const filename = buildDeliveryNoteFilename(job, 'DEL')
    const pdfBuffer = Buffer.from(pdfBytes)

    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', buildDispositionHeader(filename))
    res.setHeader('Content-Length', pdfBuffer.length)

    return res.status(200).send(pdfBuffer)
  } catch (error) {
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to generate delivery note PDF.' })
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {}
    }
  }
}

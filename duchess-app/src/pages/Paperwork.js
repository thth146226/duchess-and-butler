import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const {
  PAPERWORK_LOGO_URL,
  buildDeliveryNoteFilename,
  cleanTime,
} = require('../lib/paperworkDeliveryNoteTemplate')

function getFilenameFromDisposition(headerValue) {
  if (!headerValue) return null

  const utfMatch = headerValue.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1])
    } catch {
      return utfMatch[1]
    }
  }

  const asciiMatch = headerValue.match(/filename="?([^"]+)"?/i)
  return asciiMatch?.[1] || null
}

export default function Paperwork() {
  const [jobs, setJobs] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [pdfLoadingJobId, setPdfLoadingJobId] = useState(null)

  useEffect(() => {
    fetchJobs()
  }, [])

  async function fetchJobs() {
    const { data } = await supabase
      .from('crms_jobs')
      .select('*, crms_job_items(*)')
      .not('status', 'eq', 'cancelled')
      .order('delivery_date', { ascending: true, nullsLast: true })

    if (data) setJobs(data)
    setLoading(false)
  }

  async function getLogoBase64() {
    try {
      const response = await fetch(PAPERWORK_LOGO_URL)
      const blob = await response.blob()

      return new Promise((resolve) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result)
        reader.readAsDataURL(blob)
      })
    } catch {
      return null
    }
  }

  async function downloadDeliveryNotePdf(job) {
    if (!job?.id) {
      alert('Missing job id for PDF generation.')
      return
    }

    setPdfLoadingJobId(job.id)

    try {
      const response = await fetch('/api/paperwork-delivery-note-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      })

      if (!response.ok) {
        let message = 'Unable to generate the delivery note PDF.'

        try {
          const errorPayload = await response.clone().json()
          if (errorPayload?.error) message = errorPayload.error
        } catch {
          const fallbackText = await response.text()
          if (fallbackText) message = fallbackText
        }

        throw new Error(message)
      }

      const pdfBlob = await response.blob()
      const pdfUrl = window.URL.createObjectURL(pdfBlob)
      const filename = getFilenameFromDisposition(response.headers.get('content-disposition')) || buildDeliveryNoteFilename(job)
      const link = document.createElement('a')

      link.href = pdfUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()

      window.setTimeout(() => {
        window.URL.revokeObjectURL(pdfUrl)
      }, 1000)
    } catch (error) {
      alert(error?.message || 'Unable to generate the delivery note PDF.')
    } finally {
      setPdfLoadingJobId((currentJobId) => (currentJobId === job.id ? null : currentJobId))
    }
  }

  async function printRunSheet(date) {
    const win = window.open('', '_blank')
    if (!win) {
      alert('Please allow popups for this site to open documents.')
      return
    }

    win.document.write('<html><body><p style="font-family:sans-serif;padding:40px;color:#666">Loading run sheet...</p></body></html>')

    const logoBase64 = await getLogoBase64()
    const logoHtml = logoBase64
      ? `<img src="${logoBase64}" alt="Duchess & Butler" style="height:60px" />`
      : `<div style="font-family:Georgia,serif;font-size:22px;font-weight:600;letter-spacing:0.04em;color:#1a1a1a">
          Duchess & Butler
          <div style="font-size:10px;letter-spacing:0.2em;color:#B8965A;font-weight:400;margin-top:4px">LUXURY TABLESCAPES & EVENT DECOR</div>
        </div>`

    const dayJobs = jobs.filter((job) => job.delivery_date === date || job.collection_date === date)
    const runs = []

    for (const job of dayJobs) {
      if (job.delivery_date === date) {
        runs.push({ job, type: 'DEL', time: cleanTime(job.delivery_time) })
      }

      if (job.collection_date === date) {
        runs.push({ job, type: 'COL', time: cleanTime(job.collection_time) })
      }
    }

    runs.sort((left, right) => (left.time || '99:99').localeCompare(right.time || '99:99'))

    const dateFormatted = new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })

    const runsHtml = runs.map((run) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0ebe3;vertical-align:top">
          <span style="background:${run.type === 'DEL' ? '#FCEBEB' : '#EAF3DE'};color:${run.type === 'DEL' ? '#A32D2D' : '#3B6D11'};font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px">${run.type}</span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0ebe3;vertical-align:top">
          <div style="font-weight:600;font-size:13px">${run.job.event_name}</div>
          <div style="font-size:11px;color:#666;margin-top:2px">${run.job.crms_ref} | ${run.job.venue || '-'}</div>
          <div style="font-size:11px;color:#666">${run.job.venue_address || ''}</div>
          ${run.job.crms_job_items?.length ? `<div style="font-size:11px;color:#444;margin-top:4px">${run.job.crms_job_items.slice(0, 3).map((item) => `${item.quantity}x ${item.item_name}`).join(' | ')}${run.job.crms_job_items.length > 3 ? ' | ...' : ''}</div>` : ''}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0ebe3;vertical-align:top;white-space:nowrap">
          <div style="font-size:13px;font-weight:600">${run.time || '-'}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0ebe3;vertical-align:top">
          <div style="font-size:12px">${[run.job.assigned_driver_name, run.job.assigned_driver_name_2].filter(Boolean).join(' + ') || '<span style="color:#92400E">Unassigned</span>'}</div>
        </td>
      </tr>
    `).join('')

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Run Sheet - ${dateFormatted}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: "Helvetica Neue", Arial, sans-serif; color: #222; }
    .page { max-width: 800px; margin: 0 auto; padding: 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; border-bottom: 2px solid #8B6914; padding-bottom: 16px; }
    .logo img { height: 60px; }
    .title { font-size: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .sub { font-size: 13px; color: #666; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #8B6914; color: white; padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
    .footer { border-top: 1px solid #ddd; padding-top: 12px; text-align: center; font-size: 10px; color: #666; margin-top: 24px; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>${logoHtml}</div>
      <div style="text-align:right">
        <div class="title">Run Sheet</div>
        <div class="sub">${dateFormatted}</div>
        <div class="sub">${runs.length} run${runs.length !== 1 ? 's' : ''}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:60px">Type</th>
          <th>Event / Venue</th>
          <th style="width:80px">Time</th>
          <th style="width:140px">Driver</th>
        </tr>
      </thead>
      <tbody>
        ${runsHtml || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#999">No runs scheduled for this date</td></tr>'}
      </tbody>
    </table>

    <div class="footer">
      Duchess & Butler Ltd | Unit 7 Oakengrove Yard | Gaddesden Home Farm | Red Lion Lane | Hemel Hempstead | Herts | HP2 6EZ
      T: 01442 262772 | www.duchessandbutler.com
    </div>
  </div>
  <script>window.onload = function(){ window.print(); }</script>
</body>
</html>`

    win.document.open()
    win.document.write(html)
    win.document.close()
  }

  const filtered = jobs.filter((job) =>
    !search || [job.event_name, job.client_name, job.crms_ref, job.venue]
      .some((field) => field?.toLowerCase().includes(search.toLowerCase()))
  )

  const today = new Date().toISOString().split('T')[0]

  if (loading) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>
        Loading paperwork...
      </div>
    )
  }

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <div style={{ fontSize: '13px', fontWeight: '500' }}>Today's run sheet</div>
          <div style={{ fontSize: '12px', color: '#6B6860' }}>
            {jobs.filter((job) => job.delivery_date === today || job.collection_date === today).length} runs scheduled today
          </div>
        </div>
        <button
          onClick={() => printRunSheet(today)}
          style={{ background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 18px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
        >
          Print today's run sheet
        </button>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search event, client, reference..."
          style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", outline: 'none', boxSizing: 'border-box' }}
        />
      </div>

      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 120px', gap: '0', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF', padding: '10px 16px' }}>
          {['Event / Client', 'PDF', 'Run Sheet'].map((heading) => (
            <div key={heading} style={{ fontSize: '11px', fontWeight: '500', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#6B6860' }}>
              {heading}
            </div>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9CA3AF', fontSize: '13px' }}>No jobs found</div>
        ) : filtered.map((job) => (
          <div key={job.id} style={{ display: 'grid', gridTemplateColumns: '1fr 160px 120px', gap: '0', padding: '12px 16px', borderBottom: '0.5px solid #EDE8E0', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: '500', marginBottom: '2px' }}>{job.event_name}</div>
              <div style={{ fontSize: '11px', color: '#6B6860' }}>
                {job.crms_ref} | DEL {job.delivery_date || '-'} | COL {job.collection_date || '-'}
              </div>
              {(job.assigned_driver_name || job.assigned_driver_name_2) && (
                <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
                  {[job.assigned_driver_name, job.assigned_driver_name_2].filter(Boolean).join(' + ')}
                </div>
              )}
            </div>

            <div>
              {job.delivery_date ? (
                <button
                  onClick={() => downloadDeliveryNotePdf(job)}
                  disabled={pdfLoadingJobId === job.id}
                  style={{
                    fontSize: '11px',
                    fontWeight: '500',
                    padding: '5px 12px',
                    borderRadius: '6px',
                    cursor: pdfLoadingJobId === job.id ? 'wait' : 'pointer',
                    fontFamily: "'DM Sans', sans-serif",
                    background: '#1C1C1E',
                    color: '#fff',
                    border: 'none',
                    opacity: pdfLoadingJobId === job.id ? 0.7 : 1,
                  }}
                >
                  {pdfLoadingJobId === job.id ? 'Generating...' : 'Download PDF'}
                </button>
              ) : <span style={{ fontSize: '11px', color: '#DDD8CF' }}>-</span>}
            </div>

            <div>
              <button
                onClick={() => {
                  const date = job.delivery_date || job.collection_date
                  if (date) printRunSheet(date)
                }}
                style={{ fontSize: '11px', fontWeight: '500', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: '#1C1C1E', color: '#fff', border: 'none' }}
              >
                Run Sheet
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const STATUS_STYLE = {
  draft:     { bg: '#FEF3C7', color: '#854F0B' },
  submitted: { bg: '#EAF3DE', color: '#3B6D11' },
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function Reports() {
  const [reports, setReports]       = useState([])
  const [loading, setLoading]       = useState(true)
  const [selected, setSelected]     = useState(null)
  const [reportItems, setReportItems] = useState([])
  const [sending, setSending]       = useState(false)
  const [toast, setToast]           = useState(null)
  const [emailForm, setEmailForm]   = useState({ to: '', subject: '', message: '' })
  const [emailPanel, setEmailPanel] = useState(false)

  useEffect(() => { fetchReports() }, [])

  async function fetchReports() {
    const { data } = await supabase
      .from('job_reports')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setReports(data)
    setLoading(false)
  }

  async function openReport(report) {
    setSelected(report)
    const { data } = await supabase
      .from('job_report_items')
      .select('*')
      .eq('report_id', report.id)
    if (data) setReportItems(data)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function sendReportEmail() {
    if (!emailForm.to || !selected) return
    setSending(true)

    const conditionSummary = reportItems.map(item => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #f0ebe3;font-size:13px">${item.item_name} (${item.quantity || '—'})</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0ebe3">
          <span style="background:${item.condition === 'good' ? '#EAF3DE' : item.condition === 'damaged' ? '#FCEBEB' : '#FEF3C7'};
            color:${item.condition === 'good' ? '#3B6D11' : item.condition === 'damaged' ? '#A32D2D' : '#854F0B'};
            font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px">
            ${item.condition?.toUpperCase() || 'GOOD'}
          </span>
          ${item.notes ? `<div style="font-size:11px;color:#6B6860;margin-top:2px">${item.notes}</div>` : ''}
        </td>
      </tr>
    `).join('')

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="font-family:Arial,sans-serif;color:#222;max-width:600px;margin:0 auto;padding:40px 20px">
        <div style="text-align:center;margin-bottom:32px">
          <img src="https://duchessandbutler.com/wp-content/uploads/2025/02/duchess-butler-logo.png" 
               alt="Duchess & Butler" style="height:60px" />
        </div>
        <h2 style="font-size:20px;font-weight:600;margin-bottom:4px">${selected.event_name}</h2>
        <p style="color:#6B6860;font-size:13px;margin-bottom:8px">Reference: ${selected.crms_ref || '—'}</p>
        <p style="color:#6B6860;font-size:13px;margin-bottom:24px">
          ${selected.run_type === 'DEL' ? 'Delivery' : 'Collection'} Report · ${fmtDate(selected.created_at)} · ${selected.driver_name || 'Driver'}
        </p>
        ${emailForm.message ? `<p style="font-size:14px;line-height:1.6;margin-bottom:24px">${emailForm.message}</p>` : ''}
        ${reportItems.length > 0 ? `
          <h3 style="font-size:15px;font-weight:600;margin-bottom:12px">Item Condition Report</h3>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            <thead>
              <tr style="background:#F7F3EE">
                <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6B6860">Item</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6B6860">Condition</th>
              </tr>
            </thead>
            <tbody>${conditionSummary}</tbody>
          </table>
        ` : ''}
        ${selected.driver_notes ? `
          <h3 style="font-size:15px;font-weight:600;margin-bottom:8px">Driver Notes</h3>
          <p style="font-size:13px;color:#444;line-height:1.6;margin-bottom:24px;padding:12px;background:#F7F3EE;border-radius:6px">
            ${selected.driver_notes}
          </p>
        ` : ''}
        ${selected.client_signature ? `
          <h3 style="font-size:15px;font-weight:600;margin-bottom:8px">Client Signature</h3>
          <p style="font-size:13px;color:#3B6D11;margin-bottom:24px">
            Signed by ${selected.client_name || 'client'} on ${fmtDate(selected.signed_at)}
          </p>
          <img src="${selected.client_signature}" alt="Client Signature" style="border:1px solid #DDD8CF;border-radius:6px;max-width:300px;display:block;margin-bottom:24px" />
        ` : ''}
        <div style="border-top:2px solid #B8965A;padding-top:20px;text-align:center">
          <p style="font-size:11px;color:#9CA3AF">
            Duchess & Butler Ltd | Unit 7 Oakengrove Yard | Hemel Hempstead | HP2 6EZ<br>
            T: 01442 262772 | recon@duchessandbutler.com
          </p>
        </div>
      </body>
      </html>
    `

    try {
      const res = await fetch('/api/send-evidence-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: emailForm.to,
          subject: emailForm.subject || `${selected.event_name} — ${selected.run_type === 'DEL' ? 'Delivery' : 'Collection'} Report`,
          message: '',
          photos: [],
          jobName: selected.event_name,
          crmsRef: selected.crms_ref,
          customHtml: html,
        }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('Report sent to client')
        setEmailPanel(false)
      } else {
        showToast('Email failed: ' + data.error, 'error')
      }
    } catch(e) {
      showToast('Email failed: ' + e.message, 'error')
    }
    setSending(false)
  }

  const CONDITION_STYLE = {
    good:    { bg: '#EAF3DE', color: '#3B6D11' },
    damaged: { bg: '#FCEBEB', color: '#A32D2D' },
    missing: { bg: '#FEF3C7', color: '#854F0B' },
  }

  if (loading) return (
    <div style={{ padding: '48px', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>Loading reports…</div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", display: 'flex', gap: '24px' }}>

      {/* Reports list */}
      <div style={{ flex: selected ? '0 0 380px' : '1', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div style={{ fontSize: '13px', color: '#6B6860' }}>{reports.length} report{reports.length !== 1 ? 's' : ''}</div>
        </div>

        {reports.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 24px', background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>📋</div>
            <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '6px' }}>No reports yet</div>
            <div style={{ fontSize: '13px', color: '#9CA3AF' }}>Reports are created by drivers after delivery or collection</div>
          </div>
        ) : reports.map(r => {
          const ss = STATUS_STYLE[r.status] || STATUS_STYLE.draft
          const isSelected = selected?.id === r.id
          return (
            <div key={r.id}
              onClick={() => openReport(r)}
              style={{ background: '#fff', border: `1px solid ${isSelected ? '#1C1C1E' : '#DDD8CF'}`, borderRadius: '8px', padding: '14px 16px', marginBottom: '8px', cursor: 'pointer', transition: 'border 0.15s' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ background: r.run_type === 'DEL' ? '#FCEBEB' : '#EAF3DE', color: r.run_type === 'DEL' ? '#A32D2D' : '#3B6D11', fontSize: '10px', fontWeight: '700', padding: '2px 7px', borderRadius: '3px' }}>{r.run_type}</span>
                  <span style={{ fontSize: '13px', fontWeight: '500' }}>{r.event_name || '—'}</span>
                </div>
                <span style={{ background: ss.bg, color: ss.color, fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '10px' }}>{r.status}</span>
              </div>
              <div style={{ fontSize: '11px', color: '#6B6860' }}>
                {r.crms_ref && `${r.crms_ref} · `}{r.driver_name} · {fmtDate(r.created_at)}
                {r.client_signature && ' · ✓ Signed'}
              </div>
            </div>
          )
        })}
      </div>

      {/* Report detail */}
      {selected && (
        <div style={{ flex: 1, minWidth: 0, background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #DDD8CF', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ background: selected.run_type === 'DEL' ? '#FCEBEB' : '#EAF3DE', color: selected.run_type === 'DEL' ? '#A32D2D' : '#3B6D11', fontSize: '10px', fontWeight: '700', padding: '2px 7px', borderRadius: '3px' }}>{selected.run_type}</span>
                <span style={{ fontSize: '15px', fontWeight: '500' }}>{selected.event_name}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#6B6860' }}>{selected.crms_ref} · {selected.driver_name} · {fmtDate(selected.created_at)}</div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {selected.status === 'submitted' && (
                <button
                  onClick={() => {
                    setEmailForm({ to: '', subject: `${selected.event_name} — ${selected.run_type === 'DEL' ? 'Delivery' : 'Collection'} Report`, message: '' })
                    setEmailPanel(true)
                  }}
                  style={{ fontSize: '12px', fontWeight: '500', padding: '7px 16px', borderRadius: '6px', border: 'none', background: '#B8965A', color: '#fff', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
                >✉ Email client</button>
              )}
              <button onClick={() => setSelected(null)} style={{ background: '#F7F3EE', border: 'none', width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer', fontSize: '13px' }}>✕</button>
            </div>
          </div>

          <div style={{ padding: '20px' }}>
            {/* Item conditions */}
            {reportItems.length > 0 && (
              <>
                <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '10px' }}>Item condition report</div>
                <div style={{ border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', marginBottom: '20px' }}>
                  {reportItems.map((item, i) => {
                    const cs = CONDITION_STYLE[item.condition] || CONDITION_STYLE.good
                    return (
                      <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: i < reportItems.length - 1 ? '1px solid #EDE8E0' : 'none' }}>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: '500' }}>{item.item_name} {item.quantity ? `(${item.quantity})` : ''}</div>
                          {item.notes && <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px', fontStyle: 'italic' }}>{item.notes}</div>}
                        </div>
                        <span style={{ background: cs.bg, color: cs.color, fontSize: '10px', fontWeight: '700', padding: '3px 10px', borderRadius: '10px' }}>
                          {item.condition?.toUpperCase() || 'GOOD'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {/* Driver notes */}
            {selected.driver_notes && (
              <>
                <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '8px' }}>Driver notes</div>
                <div style={{ background: '#F7F3EE', borderRadius: '8px', padding: '12px 14px', fontSize: '13px', color: '#1C1C1E', lineHeight: 1.6, marginBottom: '20px', fontStyle: 'italic' }}>
                  "{selected.driver_notes}"
                </div>
              </>
            )}

            {/* Signature */}
            {selected.client_signature && (
              <>
                <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#B8965A', marginBottom: '8px' }}>Client signature</div>
                <div style={{ background: '#F0FDF4', border: '1px solid #86EFAC', borderRadius: '8px', padding: '12px', marginBottom: '20px' }}>
                  <div style={{ fontSize: '12px', color: '#3B6D11', marginBottom: '8px' }}>
                    Signed by {selected.client_name || 'client'} · {fmtDate(selected.signed_at)}
                  </div>
                  <img src={selected.client_signature} alt="Signature" style={{ maxWidth: '280px', border: '1px solid #DDD8CF', borderRadius: '4px', display: 'block' }} />
                </div>
              </>
            )}

            {reportItems.length === 0 && !selected.driver_notes && !selected.client_signature && (
              <div style={{ textAlign: 'center', padding: '40px', color: '#9CA3AF', fontSize: '13px' }}>
                No details recorded for this report yet.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Email panel */}
      {emailPanel && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={e => e.target === e.currentTarget && setEmailPanel(false)}>
          <div style={{ background: '#fff', borderRadius: '12px', width: '100%', maxWidth: '480px', padding: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div style={{ fontSize: '16px', fontWeight: '500' }}>Send report to client</div>
              <button onClick={() => setEmailPanel(false)} style={{ background: '#F7F3EE', border: 'none', width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer', fontSize: '13px' }}>✕</button>
            </div>
            {[
              { label: 'To (client email)', key: 'to', type: 'email', placeholder: 'client@example.com' },
              { label: 'Subject', key: 'subject', type: 'text', placeholder: 'Report subject...' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860', marginBottom: '5px' }}>{f.label}</div>
                <input type={f.type} value={emailForm[f.key]} onChange={e => setEmailForm(ef => ({ ...ef, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
              </div>
            ))}
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6860', marginBottom: '5px' }}>Message (optional)</div>
              <textarea value={emailForm.message} onChange={e => setEmailForm(ef => ({ ...ef, message: e.target.value }))}
                placeholder="Please find attached the condition report for your event..."
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", minHeight: '80px', resize: 'vertical', boxSizing: 'border-box' }} />
            </div>
            <button onClick={sendReportEmail} disabled={sending || !emailForm.to}
              style={{ width: '100%', padding: '11px', background: !emailForm.to ? '#DDD8CF' : '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: !emailForm.to ? 'default' : 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              {sending ? 'Sending…' : 'Send report'}
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: '24px', right: '24px', background: '#1C1C1E', color: '#fff', padding: '12px 20px', borderRadius: '8px', fontSize: '13px', borderLeft: `3px solid ${toast.type === 'error' ? '#EF4444' : '#10B981'}`, zIndex: 999 }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

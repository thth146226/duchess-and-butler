module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { to, subject, message, photos, jobName, crmsRef } = req.body

  if (!to || !photos?.length) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  const photoLinks = photos.map((p, i) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0ebe3">
        <span style="background:${p.run_type === 'after_del' ? '#FCEBEB' : '#EAF3DE'};color:${p.run_type === 'after_del' ? '#A32D2D' : '#3B6D11'};font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;margin-right:8px">
          ${p.run_type === 'after_del' ? 'After DEL' : p.run_type === 'pre_col' ? 'Pre-COL' : 'After COL'}
        </span>
        <a href="${p.photo_url}" style="color:#1D4ED8;font-size:13px">View photo ${i + 1}</a>
        <span style="color:#9CA3AF;font-size:11px;margin-left:8px">· ${p.uploaded_by_name || 'Team'}</span>
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
      <h2 style="font-size:20px;font-weight:600;margin-bottom:4px">${jobName}</h2>
      <p style="color:#6B6860;font-size:13px;margin-bottom:24px">Reference: ${crmsRef || '—'}</p>
      ${message ? `<p style="font-size:14px;line-height:1.6;margin-bottom:24px">${message}</p>` : ''}
      <p style="font-size:14px;margin-bottom:16px">Please find below the evidence photos for your event:</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:32px">
        <tbody>${photoLinks}</tbody>
      </table>
      <div style="border-top:2px solid #B8965A;padding-top:20px;text-align:center">
        <p style="font-size:11px;color:#9CA3AF">
          Duchess & Butler Ltd | Unit 7 Oakengrove Yard | Hemel Hempstead | HP2 6EZ<br>
          T: 01442 262772 | hello@duchessandbutler.com
        </p>
      </div>
    </body>
    </html>
  `

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Duchess & Butler <hello@duchessandbutler.com>',
        to: [to],
        subject: subject || `${jobName} — Evidence Photos`,
        html,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      return res.status(500).json({ error: data.message || 'Email failed' })
    }

    return res.status(200).json({ success: true, id: data.id })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}


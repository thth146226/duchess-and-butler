const { createClient } = require('@supabase/supabase-js')

async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error_description || data.error)
  return data.access_token
}

function makeEmail({ to, subject, html, from }) {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    '',
    html,
  ].join('\n')
  return Buffer.from(message).toString('base64url')
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { to, subject, message, photos, jobName, crmsRef, customHtml } = req.body
  if (!to || !photos?.length) return res.status(400).json({ error: 'Missing required fields' })

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    )

    const { data: setting } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'gmail_refresh_token')
      .single()

    if (!setting?.value) {
      return res.status(400).json({ error: 'Gmail not connected. Please connect Gmail first.' })
    }

    const accessToken = await getAccessToken(setting.value)

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

    const html = customHtml || `
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
            T: 01442 262772 | recon@duchessandbutler.com
          </p>
        </div>
      </body>
      </html>
    `

    const emailB64 = makeEmail({
      to,
      subject: subject || `${jobName} — Evidence Photos`,
      html,
      from: 'Duchess & Butler <recon@duchessandbutler.com>',
    })

    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: emailB64 }),
    })

    const gmailData = await gmailRes.json()
    if (gmailData.error) throw new Error(gmailData.error.message)

    return res.status(200).json({ success: true, id: gmailData.id })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}


// Duchess Client Portal — Invite Client
// POST /api/invite-client
// Admin-only. Generates branded invite via Gmail API.
// Uses generateLink — Supabase sends nothing.
// Upserts client_profiles after auth user creation.
// 2026-05-04

const { createClient } = require('@supabase/supabase-js')

async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  const data = await res.json()

  if (data.error) {
    throw new Error(data.error_description || data.error)
  }

  return data.access_token
}

function makeEmail({ to, subject, html, fromName, fromEmail }) {
  const message = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    '',
    html,
  ].join('\n')

  return Buffer.from(message).toString('base64url')
}

function inviteEmailHtml({ clientName, inviteUrl }) {
  const firstName = clientName?.split(' ')[0] || clientName || 'there'

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #f8f5ef; font-family: Georgia, serif; }
  .wrap { max-width: 560px; margin: 40px auto; background: #ffffff; }
  .header { background: #1a1a1a; padding: 36px 40px 32px; }
  .brand { color: #f0ece4; font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; }
  .brand span { color: #c9a84c; }
  .body { padding: 44px 40px 40px; border: 1px solid #e8e2d8; border-top: none; }
  .greeting { font-size: 28px; font-weight: 400; color: #1a1a1a; line-height: 1.2; margin-bottom: 20px; }
  .intro { font-size: 15px; color: #5a5248; line-height: 1.7; margin-bottom: 28px; font-family: 'Helvetica Neue', sans-serif; font-weight: 300; }
  .divider { height: 1px; background: #e8e2d8; margin: 28px 0; }
  .cta-label { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #8a7e72; font-family: 'Helvetica Neue', sans-serif; margin-bottom: 16px; }
  .btn { display: inline-block; background: #1a1a1a; color: #e8d5a3; text-decoration: none; padding: 14px 32px; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; font-family: 'Helvetica Neue', sans-serif; font-weight: 400; }
  .note { margin-top: 24px; font-size: 12px; color: #8a7e72; font-family: 'Helvetica Neue', sans-serif; font-weight: 300; line-height: 1.6; }
  .footer { padding: 24px 40px; border: 1px solid #e8e2d8; border-top: none; }
  .footer-text { font-size: 11px; color: #b4aea8; font-family: 'Helvetica Neue', sans-serif; letter-spacing: 0.06em; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="brand">Duchess <span>&amp;</span> Butler</div>
  </div>

  <div class="body">
    <div class="greeting">Welcome,<br>${firstName}.</div>

    <div class="intro">
      You have been invited to access your private Duchess &amp; Butler client portal —
      a dedicated space to manage your rewards, explore our collection, and design your events.
    </div>

    <div class="divider"></div>

    <div class="cta-label">Set up your account</div>

    <a href="${inviteUrl}" class="btn">Access your portal</a>

    <div class="note">
      This invitation is personal to you. The link will expire in 24 hours.<br>
      If you did not expect this invitation, please disregard this email.
    </div>
  </div>

  <div class="footer">
    <div class="footer-text">Duchess &amp; Butler · Private Client Services · London</div>
  </div>
</div>
</body>
</html>`
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // ── Required server configuration ─────────────────────────────
  const requiredEnv = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GMAIL_SENDER',
    'PORTAL_URL',
  ]

  const missingEnv = requiredEnv.filter((key) => !process.env[key])

  if (missingEnv.length > 0) {
    return res.status(500).json({
      error: 'Server configuration missing',
      missing: missingEnv,
    })
  }

  const portalUrl = process.env.PORTAL_URL.replace(/\/$/, '')

  const { loyalty_client_id } = req.body || {}

  if (!loyalty_client_id) {
    return res.status(400).json({ error: 'Missing loyalty_client_id' })
  }

  // ── Service role client: server-side only ─────────────────────
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  // ── Validate caller is authenticated admin ────────────────────
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const callerToken = authHeader.split(' ')[1]

  const {
    data: { user: callerUser },
    error: callerError,
  } = await supabase.auth.getUser(callerToken)

  if (callerError || !callerUser) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const { data: callerProfile, error: callerProfileError } = await supabase
    .from('users')
    .select('role')
    .eq('id', callerUser.id)
    .single()

  if (callerProfileError || callerProfile?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  // ── Fetch loyalty client ──────────────────────────────────────
  const { data: loyaltyClient, error: loyaltyClientError } = await supabase
    .from('loyalty_clients')
    .select('id, client_name, client_email, status, invite_sent_at')
    .eq('id', loyalty_client_id)
    .single()

  if (loyaltyClientError || !loyaltyClient) {
    return res.status(404).json({ error: 'Client not found' })
  }

  if (loyaltyClient.status !== 'active') {
    return res.status(400).json({ error: 'Client is not active' })
  }

  if (!loyaltyClient.client_email) {
    return res.status(400).json({
      error: 'Client has no email address — add email before inviting',
    })
  }

  // ── Generate invite link: Supabase sends nothing ──────────────
  const { data: linkData, error: linkError } =
    await supabase.auth.admin.generateLink({
      type: 'invite',
      email: loyaltyClient.client_email,
      options: {
        redirectTo: `${portalUrl}/portal/invite`,
        data: {
          loyalty_client_id: loyaltyClient.id,
        },
      },
    })

  if (linkError || !linkData?.properties?.action_link) {
    return res.status(500).json({
      error: 'Failed to generate invite link',
      detail: linkError?.message || 'No action_link returned',
    })
  }

  const inviteUrl = linkData.properties.action_link
  const authUserId = linkData.user?.id

  if (!authUserId) {
    return res.status(500).json({
      error: 'Failed to generate invite user',
      detail: 'No auth user id returned',
    })
  }

  // ── Protect against changing an existing account link ─────────
  const { data: existingProfile, error: existingProfileError } = await supabase
    .from('client_profiles')
    .select('id, loyalty_client_id')
    .eq('id', authUserId)
    .maybeSingle()

  if (existingProfileError) {
    return res.status(500).json({
      error: 'Failed to check existing client profile',
      detail: existingProfileError.message,
    })
  }

  if (
    existingProfile?.loyalty_client_id &&
    existingProfile.loyalty_client_id !== loyaltyClient.id
  ) {
    return res.status(409).json({
      error: 'This email is already linked to another client account',
    })
  }

  // ── Prepare / update client profile link ──────────────────────
  const { error: profileError } = await supabase
    .from('client_profiles')
    .upsert(
      {
        id: authUserId,
        loyalty_client_id: loyaltyClient.id,
        display_name: loyaltyClient.client_name,
        email: loyaltyClient.client_email,
      },
      { onConflict: 'id' }
    )

  if (profileError) {
    return res.status(500).json({
      error: 'Failed to prepare client profile',
      detail: profileError.message,
    })
  }

  // ── Fetch Gmail refresh token ─────────────────────────────────
  const { data: setting, error: settingError } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'gmail_refresh_token')
    .single()

  if (settingError || !setting?.value) {
    return res.status(500).json({ error: 'Gmail not configured' })
  }

  // ── Send branded email through Gmail API ──────────────────────
  try {
    const accessToken = await getAccessToken(setting.value)

    const html = inviteEmailHtml({
      clientName: loyaltyClient.client_name,
      inviteUrl,
    })

    const raw = makeEmail({
      to: loyaltyClient.client_email,
      subject: 'Your Duchess & Butler private client portal',
      html,
      fromName: 'Duchess & Butler',
      fromEmail: process.env.GMAIL_SENDER,
    })

    const gmailRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      }
    )

    if (!gmailRes.ok) {
      const err = await gmailRes.json()
      throw new Error(err.error?.message || 'Gmail send failed')
    }
  } catch (emailError) {
    return res.status(500).json({
      error: 'Email send failed',
      detail: emailError.message,
    })
  }

  // ── Update invite_sent_at ─────────────────────────────────────
  const { error: inviteUpdateError } = await supabase
    .from('loyalty_clients')
    .update({ invite_sent_at: new Date().toISOString() })
    .eq('id', loyalty_client_id)

  if (inviteUpdateError) {
    return res.status(200).json({
      success: true,
      email: loyaltyClient.client_email,
      warning: 'Invite email sent, but invite_sent_at was not updated',
    })
  }

  return res.status(200).json({
    success: true,
    email: loyaltyClient.client_email,
  })
}

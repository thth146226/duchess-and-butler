const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  const { code } = req.query
  
  if (!code) return res.status(400).json({ error: 'No code provided' })

  const clientId     = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri  = `${process.env.NEXT_PUBLIC_APP_URL || 'https://duchess-and-butler-59qr.vercel.app'}/api/gmail-callback`

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    const tokens = await tokenRes.json()
    
    if (tokens.error) throw new Error(tokens.error_description || tokens.error)

    // Store refresh token in Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    )

    await supabase.from('app_settings').upsert({
      key: 'gmail_refresh_token',
      value: tokens.refresh_token,
    }, { onConflict: 'key' })

    return res.redirect('/?gmail_connected=true')
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

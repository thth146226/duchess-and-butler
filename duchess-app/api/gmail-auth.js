module.exports = async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const redirectUri = 'https://duchess-and-butler-59qr.vercel.app/api/gmail-callback'
  
  const scope = 'https://www.googleapis.com/auth/gmail.send'

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId.trim()}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scope)}&` +
    `access_type=offline&` +
    `prompt=consent`

  return res.redirect(302, authUrl)
}

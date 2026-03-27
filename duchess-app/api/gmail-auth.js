module.exports = async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  
  return res.status(200).json({ 
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret,
    clientIdPrefix: clientId ? clientId.substring(0, 20) + '...' : 'MISSING',
  })
}

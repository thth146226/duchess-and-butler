const { createProxyMiddleware } = require('http-proxy-middleware')
const { startTusLocalServer } = require('./lib/tusLocalServer')

const TUS_LOCAL_PORT = 3921

module.exports = function setupTusLocalProxy(app) {
  if (process.env.REACT_APP_TUS_LOCAL_ONLY !== '1') {
    return
  }
  const ready = startTusLocalServer({ port: TUS_LOCAL_PORT })
  app.use('/tus-local', (req, res, next) => {
    ready.then(() => next(), next)
  })
  app.use('/tus-local', createProxyMiddleware({
    target: `http://127.0.0.1:${TUS_LOCAL_PORT}`,
    xfwd: true,
    pathRewrite: { '^/tus-local': '' },
    onProxyReq(proxyReq) {
      proxyReq.setHeader('x-forwarded-prefix', '/tus-local')
    },
  }))
}

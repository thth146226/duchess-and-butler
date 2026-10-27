const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

function parseMetadata(header) {
  const out = {}
  if (typeof header !== 'string' || header.length === 0) {
    return out
  }
  header.split(',').forEach((part) => {
    const bits = part.trim().split(' ')
    const key = bits[0]
    const value = bits[1]
    if (!key || !value) {
      return
    }
    out[key] = Buffer.from(value, 'base64').toString('utf8')
  })
  return out
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let taken = 0
    let settled = false
    function finish() {
      if (settled) {
        return
      }
      settled = true
      resolve(Buffer.concat(chunks))
    }
    req.on('data', (chunk) => {
      if (limit == null) {
        chunks.push(chunk)
        taken += chunk.length
        return
      }
      if (taken >= limit) {
        return
      }
      const slice = chunk.subarray(0, limit - taken)
      chunks.push(slice)
      taken += slice.length
      if (taken >= limit) {
        req.destroy()
      }
    })
    req.on('end', finish)
    req.on('close', finish)
    req.on('aborted', finish)
    req.on('error', finish)
  })
}

function publicLocation(req, id, port) {
  const forwardedHost = req.headers['x-forwarded-host']
  if (typeof forwardedHost !== 'string' || forwardedHost.length === 0) {
    return `http://127.0.0.1:${port}/files/${id}`
  }
  const host = forwardedHost.split(',')[0].trim()
  if (host.length === 0 || host.indexOf('supabase.co') !== -1) {
    return `http://127.0.0.1:${port}/files/${id}`
  }
  const protoHeader = req.headers['x-forwarded-proto']
  const proto = typeof protoHeader === 'string' && protoHeader.length > 0
    ? protoHeader.split(',')[0].trim()
    : 'http'
  const prefixHeader = req.headers['x-forwarded-prefix']
  const prefix = typeof prefixHeader === 'string' ? prefixHeader.trim().replace(/\/$/, '') : ''
  return `${proto}://${host}${prefix}/files/${id}`
}

function startTusLocalServer(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duchess-s12-tus-local-'))
  const uploads = new Map()
  const rules = new Map()
  const operations = []
  const active = new Set()
  let maxConcurrent = 0
  let port = 0

  function trackStart(id) {
    active.add(id)
    if (active.size > maxConcurrent) {
      maxConcurrent = active.size
    }
  }

  function trackEnd(id) {
    active.delete(id)
  }

  function uploadFromUrl(url) {
    const name = (url || '').split('?')[0]
    const id = name.slice(name.lastIndexOf('/') + 1)
    return uploads.get(id) || null
  }

  const server = http.createServer((req, res) => {
    const host = req.socket.remoteAddress || ''
    const local = host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1'
    if (!local) {
      res.writeHead(403)
      res.end()
      return
    }

    const pathname = (req.url || '').split('?')[0]
    if (req.method === 'POST' && pathname === '/files') {
      const length = Number(req.headers['upload-length'])
      const metadata = parseMetadata(req.headers['upload-metadata'])
      if (!Number.isInteger(length) || length < 0) {
        res.writeHead(400)
        res.end()
        return
      }
      const id = crypto.randomBytes(8).toString('hex')
      const filePath = path.join(directory, id)
      fs.writeFileSync(filePath, Buffer.alloc(0))
      uploads.set(id, {
        id,
        length,
        offset: 0,
        filePath,
        storagePath: metadata.objectName || id,
      })
      operations.push({
        method: 'POST',
        storage_path: metadata.objectName || id,
        offset_in: 0,
        offset_out: 0,
        status: 201,
        bytes: 0,
      })
      res.writeHead(201, {
        'Tus-Resumable': '1.0.0',
        Location: publicLocation(req, id, port),
        'Upload-Offset': '0',
      })
      res.end()
      req.resume()
      return
    }

    if (req.method === 'GET' && pathname === '/status') {
      const files = []
      for (const upload of uploads.values()) {
        const stored = fs.readFileSync(upload.filePath)
        files.push({
          storage_path: upload.storagePath,
          offset: upload.offset,
          length: upload.length,
          sha256: crypto.createHash('sha256').update(stored).digest('hex'),
        })
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify({
        files,
        operations,
        max_concurrent: maxConcurrent,
      }))
      return
    }

    if (req.method === 'POST' && pathname === '/control') {
      readBody(req, null).then((body) => {
        let payload = {}
        try {
          payload = JSON.parse(body.toString('utf8') || '{}')
        } catch (_error) {
          payload = {}
        }
        if (payload && typeof payload.storagePath === 'string' && payload.storagePath.length > 0) {
          rules.set(payload.storagePath, {
            cutAfterBytes: Number.isInteger(payload.cutAfterBytes) ? payload.cutAfterBytes : null,
            holdAfterFirstChunk: payload.holdAfterFirstChunk === true,
            delayMs: Number.isInteger(payload.delayMs) ? payload.delayMs : 0,
            cutUsed: false,
            holdUsed: false,
            held: false,
          })
        }
        res.writeHead(204)
        res.end()
      })
      return
    }

    if (!pathname.startsWith('/files/')) {
      res.writeHead(404)
      res.end()
      return
    }

    const upload = uploadFromUrl(pathname)
    if (!upload) {
      res.writeHead(404)
      res.end()
      return
    }

    if (req.method === 'HEAD') {
      operations.push({
        method: 'HEAD',
        storage_path: upload.storagePath,
        offset_in: null,
        offset_out: upload.offset,
        status: 200,
        bytes: 0,
      })
      res.writeHead(200, {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(upload.offset),
        'Upload-Length': String(upload.length),
        'Cache-Control': 'no-store',
      })
      res.end()
      return
    }

    if (req.method !== 'PATCH') {
      res.writeHead(405)
      res.end()
      return
    }

    const requestOffset = Number(req.headers['upload-offset'])
    if (requestOffset !== upload.offset) {
      operations.push({
        method: 'PATCH',
        storage_path: upload.storagePath,
        offset_in: requestOffset,
        offset_out: upload.offset,
        status: 409,
        bytes: 0,
      })
      res.writeHead(409, {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(upload.offset),
      })
      res.end()
      req.resume()
      return
    }

    const rule = rules.get(upload.storagePath) || null
    trackStart(upload.id)
    const cut = Boolean(rule && rule.cutAfterBytes != null && upload.offset > 0 && !rule.cutUsed)
    if (cut) {
      rule.cutUsed = true
      readBody(req, rule.cutAfterBytes).then((body) => {
        if (body.length > 0) {
          fs.appendFileSync(upload.filePath, body)
          upload.offset += body.length
        }
        operations.push({
          method: 'PATCH',
          storage_path: upload.storagePath,
          offset_in: requestOffset,
          offset_out: upload.offset,
          status: 'closed',
          bytes: body.length,
        })
        trackEnd(upload.id)
      })
      return
    }

    readBody(req, null).then((body) => {
      const hold = Boolean(rule && rule.holdAfterFirstChunk && upload.offset > 0 && !rule.holdUsed)
      if (hold) {
        rule.holdUsed = true
        rule.held = true
        const discard = () => {
          if (!rule.held || res.writableEnded) {
            return
          }
          rule.held = false
          operations.push({
            method: 'PATCH',
            storage_path: upload.storagePath,
            offset_in: requestOffset,
            offset_out: upload.offset,
            status: 'aborted',
            bytes: 0,
          })
          trackEnd(upload.id)
        }
        req.on('aborted', discard)
        res.on('close', discard)
        return
      }

      const finish = () => {
        if (upload.offset + body.length > upload.length) {
          operations.push({
            method: 'PATCH',
            storage_path: upload.storagePath,
            offset_in: requestOffset,
            offset_out: upload.offset,
            status: 413,
            bytes: body.length,
          })
          res.writeHead(413)
          res.end()
          trackEnd(upload.id)
          return
        }
        if (body.length > 0) {
          fs.appendFileSync(upload.filePath, body)
          upload.offset += body.length
        }
        operations.push({
          method: 'PATCH',
          storage_path: upload.storagePath,
          offset_in: requestOffset,
          offset_out: upload.offset,
          status: 204,
          bytes: body.length,
        })
        res.writeHead(204, {
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(upload.offset),
        })
        res.end()
        trackEnd(upload.id)
      }
      const delayMs = rule && Number.isInteger(rule.delayMs) ? rule.delayMs : 0
      if (delayMs > 0) {
        setTimeout(finish, delayMs)
        return
      }
      finish()
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const listenPort = Number.isInteger(options.port) ? options.port : 0
    server.listen(listenPort, '127.0.0.1', () => {
      port = server.address().port
      resolve({
        endpoint: `http://127.0.0.1:${port}/files`,
        origin: `http://127.0.0.1:${port}`,
        arm(storagePath, rule) {
          rules.set(storagePath, { ...rule, cutUsed: false, holdUsed: false, held: false })
        },
        bytesFor(storagePath) {
          for (const upload of uploads.values()) {
            if (upload.storagePath === storagePath) {
              return fs.readFileSync(upload.filePath)
            }
          }
          return null
        },
        holding(storagePath) {
          const rule = rules.get(storagePath)
          return Boolean(rule && rule.held)
        },
        offsetFor(storagePath) {
          for (const upload of uploads.values()) {
            if (upload.storagePath === storagePath) {
              return upload.offset
            }
          }
          return null
        },
        uploadCount(storagePath) {
          let count = 0
          for (const upload of uploads.values()) {
            if (upload.storagePath === storagePath) {
              count += 1
            }
          }
          return count
        },
        snapshot() {
          return {
            max_concurrent: maxConcurrent,
            active: active.size,
            operations: operations.map((item) => ({ ...item })),
          }
        },
        close() {
          return new Promise((done) => {
            server.close(() => {
              fs.rmSync(directory, { recursive: true, force: true })
              done()
            })
          })
        },
      })
    })
  })
}

module.exports = { startTusLocalServer }

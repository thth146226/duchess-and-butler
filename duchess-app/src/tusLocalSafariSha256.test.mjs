import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  SHA256_NOBLE,
  SHA256_WEBCRYPTO,
  hashOriginBytes,
  webCryptoDiagnostic,
} from './tusLocalSafariSha256.mjs'

// FIPS 180-4 / NIST SHA-256 byte vectors.
const VECTORS = [
  {
    label: 'empty',
    bytes: new Uint8Array(0),
    hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    label: 'abc',
    bytes: new TextEncoder().encode('abc'),
    hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    label: '448-bit',
    bytes: new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    hex: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
  {
    label: '896-bit',
    bytes: new TextEncoder().encode(
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'
    ),
    hex: 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  },
  {
    label: 'one-million-a',
    bytes: new Uint8Array(1000000).fill(0x61),
    hex: 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  },
]

function nodeHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const insecureSafari = {
  isSecureContext: false,
  crypto: {},
}

test('insecure Safari context does not throw and matches NIST SHA-256', async () => {
  const diagnostic = webCryptoDiagnostic(insecureSafari)
  assert.match(diagnostic, /isSecureContext=false/)
  assert.match(diagnostic, /crypto\.subtle não existe/)
  assert.match(diagnostic, /@noble\/hashes/)
  assert.doesNotMatch(diagnostic, /undefined is not an object/)

  for (const vector of VECTORS) {
    const hashed = await hashOriginBytes(vector.bytes, insecureSafari)
    assert.equal(hashed.method, SHA256_NOBLE)
    assert.equal(hashed.diagnostic, diagnostic)
    assert.equal(hashed.hex, vector.hex)
    assert.equal(hashed.hex, nodeHex(vector.bytes))
  }
})

test('missing subtle.digest is not evaluated and still hashes', async () => {
  const cryptoObj = {}
  Object.defineProperty(cryptoObj, 'subtle', {
    get() {
      return undefined
    },
  })
  const scope = { isSecureContext: false, crypto: cryptoObj }
  const hashed = await hashOriginBytes(new TextEncoder().encode('abc'), scope)
  assert.equal(hashed.method, SHA256_NOBLE)
  assert.equal(hashed.hex, VECTORS[1].hex)
  assert.match(hashed.diagnostic, /isSecureContext=false/)
})

test('secure context without subtle explains the missing API', () => {
  const diagnostic = webCryptoDiagnostic({ isSecureContext: true, crypto: {} })
  assert.match(diagnostic, /crypto\.subtle\.digest não existe/)
  assert.doesNotMatch(diagnostic, /isSecureContext=false/)
})

test('Web Crypto is used when digest exists', async () => {
  const bytes = new TextEncoder().encode('abc')
  const scope = {
    isSecureContext: true,
    crypto: {
      subtle: {
        async digest(_name, input) {
          return createHash('sha256').update(input).digest()
        },
      },
    },
  }
  const hashed = await hashOriginBytes(bytes, scope)
  assert.equal(hashed.method, SHA256_WEBCRYPTO)
  assert.equal(hashed.diagnostic, null)
  assert.equal(hashed.hex, VECTORS[1].hex)
  assert.equal(webCryptoDiagnostic(scope), null)
})

test('a rejecting Web Crypto falls back without throwing', async () => {
  const bytes = Uint8Array.from([0, 1, 2, 255])
  const scope = {
    isSecureContext: true,
    crypto: {
      subtle: {
        digest() {
          throw new TypeError("undefined is not an object (evaluating 'crypto.subtle.digest')")
        },
      },
    },
  }
  const hashed = await hashOriginBytes(bytes, scope)
  assert.equal(hashed.method, SHA256_NOBLE)
  assert.equal(hashed.hex, nodeHex(bytes))
  assert.match(hashed.diagnostic, /@noble\/hashes/)
  assert.doesNotMatch(hashed.diagnostic, /undefined is not an object/)
})

test('binary input matches the independent Node SHA-256', async () => {
  const bytes = new Uint8Array(4096)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 17 + 4) & 255
  }
  const hashed = await hashOriginBytes(bytes, insecureSafari)
  assert.equal(hashed.hex, nodeHex(bytes))
})

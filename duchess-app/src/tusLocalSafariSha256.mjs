import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const SHA256_NOBLE = 'noble-hashes'
export const SHA256_WEBCRYPTO = 'webcrypto'

const INSECURE_CONTEXT_DIAGNOSTIC = 'Web Crypto indisponível: esta página está em contexto inseguro (isSecureContext=false) e crypto.subtle não existe. O Safari não cria crypto.subtle em HTTP fora de localhost, então crypto.subtle.digest não pode ser chamado. Não há certificado confiável para este IP de teste; um certificado inválido não é usado. O SHA-256 de origem deste harness foi calculado com @noble/hashes. O servidor local continua calculando, à parte, o SHA-256 do arquivo recebido.'

const MISSING_SUBTLE_DIAGNOSTIC = 'Web Crypto indisponível: crypto.subtle.digest não existe neste navegador. O SHA-256 de origem deste harness foi calculado com @noble/hashes. O servidor local continua calculando, à parte, o SHA-256 do arquivo recebido.'

const REJECTED_SUBTLE_DIAGNOSTIC = 'Web Crypto recusou crypto.subtle.digest. O SHA-256 de origem deste harness foi calculado com @noble/hashes. O servidor local continua calculando, à parte, o SHA-256 do arquivo recebido.'

export function hasSubtleDigest(scope = globalThis) {
  return typeof scope?.crypto?.subtle?.digest === 'function'
}

export function webCryptoDiagnostic(scope = globalThis) {
  if (hasSubtleDigest(scope)) {
    return null
  }
  if (scope?.isSecureContext === true) {
    return MISSING_SUBTLE_DIAGNOSTIC
  }
  return INSECURE_CONTEXT_DIAGNOSTIC
}

function hexFromDigest(digest) {
  const bytes = digest instanceof Uint8Array ? digest : new Uint8Array(digest)
  return bytesToHex(bytes)
}

function nobleHex(bytes) {
  try {
    return bytesToHex(nobleSha256(bytes))
  } catch (error) {
    const reason = error && error.message ? error.message : 'falha desconhecida'
    throw new Error(`SHA-256 do harness indisponível. Web Crypto não pôde ser usado e @noble/hashes falhou: ${reason}`)
  }
}

export async function hashOriginBytes(bytes, scope = globalThis) {
  const digest = scope?.crypto?.subtle?.digest
  if (typeof digest === 'function') {
    try {
      const hashed = await digest.call(scope.crypto.subtle, 'SHA-256', bytes)
      return {
        hex: hexFromDigest(hashed),
        method: SHA256_WEBCRYPTO,
        diagnostic: null,
      }
    } catch (_error) {
      return {
        hex: nobleHex(bytes),
        method: SHA256_NOBLE,
        diagnostic: REJECTED_SUBTLE_DIAGNOSTIC,
      }
    }
  }
  return {
    hex: nobleHex(bytes),
    method: SHA256_NOBLE,
    diagnostic: webCryptoDiagnostic(scope),
  }
}

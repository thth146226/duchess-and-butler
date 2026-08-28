const NodeEnvironment = require('jest-environment-node')

const hostDOMException = globalThis.DOMException
const hostBlob = globalThis.Blob
const hostStructuredClone = globalThis.structuredClone

if (
  typeof hostDOMException !== 'function' ||
  typeof hostBlob !== 'function' ||
  typeof hostStructuredClone !== 'function'
) {
  throw new Error('Required host Node Web globals unavailable')
}

class PhotoUploadNativeNodeJestEnvironment extends NodeEnvironment {
  async setup() {
    await super.setup()
    this.global.DOMException = hostDOMException
    this.global.Blob = hostBlob
    this.global.structuredClone = hostStructuredClone
  }
}

module.exports = PhotoUploadNativeNodeJestEnvironment

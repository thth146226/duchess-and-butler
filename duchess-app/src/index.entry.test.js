/**
 * @jest-environment ./src/lib/PhotoUploadNativeNodeJestEnvironment.js
 */
const fs = require('fs')
const path = require('path')

test('the published entry mounts local harnesses only from explicit build flags', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  expect(source).not.toContain('tus_local')
  expect(source).not.toContain('safari_s12_harness')
  expect(source).not.toContain('URLSearchParams')
  expect(source).toContain("process.env.NODE_ENV !== 'production' && process.env.REACT_APP_TUS_LOCAL_ONLY === '1'")
  expect(source).toContain("process.env.NODE_ENV !== 'production' && process.env.REACT_APP_SAFARI_S12_ONLY === '1'")
  expect(source).toContain("process.env.REACT_APP_PHOTO_UPLOAD_RECOVERY === '1'")
  expect(source.indexOf('photoUploadRecoveryEntry')).toBeGreaterThan(source.indexOf('safariS12Harness'))
})

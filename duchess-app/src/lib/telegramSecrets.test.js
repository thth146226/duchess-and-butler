import fs from 'fs'
import path from 'path'

function listFilesRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath))
    } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
      files.push(fullPath)
    }
  }

  return files
}

describe('telegram secrets exposure', () => {
  test('TELEGRAM_BOT_TOKEN is not referenced in src', () => {
    const srcDir = path.resolve(__dirname, '..')
    const files = listFilesRecursive(srcDir)
    const forbidden = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALERT_CHAT_ID']

    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        expect(contents).not.toContain(pattern)
      }
    }
  })
})

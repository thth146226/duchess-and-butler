import { useState } from 'react'
import { PHOTO_UPLOAD_DB_NAME } from './lib/photoUploadDb'
import { createPhotoUploadRecoveryDb } from './lib/photoUploadCompatibleRecovery'

export function PhotoUploadRecoveryEntry() {
  const [line, setLine] = useState('Uploads are disabled. Local records stay readable.')
  const [report, setReport] = useState(null)

  async function inspectDatabase() {
    const recovery = createPhotoUploadRecoveryDb()
    try {
      const snapshot = await recovery.inspect()
      setReport({
        database: PHOTO_UPLOAD_DB_NAME,
        version: snapshot.version,
        stores: snapshot.stores,
        uploadsEnabled: snapshot.uploadsEnabled,
        rawV1Rollback: snapshot.rawV1Rollback,
      })
      setLine('Database opened at its current version. No bytes were rewritten.')
    } catch (error) {
      setLine(error && error.message ? error.message : 'recovery open failed')
    } finally {
      await recovery.close()
    }
  }

  return (
    <main style={{ fontFamily: 'sans-serif', margin: '16px', maxWidth: '720px' }}>
      <h1>Photo upload recovery</h1>
      <p>
        Compatible rollback for {PHOTO_UPLOAD_DB_NAME}. The IndexedDB version is not lowered.
        Blobs are not deleted, rewritten, or migrated. New uploads stay off.
      </p>
      <p>{line}</p>
      <button type="button" onClick={inspectDatabase}>Show database version</button>
      <textarea readOnly value={report ? JSON.stringify(report, null, 2) : ''} style={{ width: '100%', minHeight: '180px' }} />
    </main>
  )
}

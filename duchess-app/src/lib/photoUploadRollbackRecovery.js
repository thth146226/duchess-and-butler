import { PHOTO_UPLOAD_STATUSES } from './photoUploadDomain'

export const RAW_LEGACY_ROLLBACK_BLOCKED_CODE = 'RAW_LEGACY_ROLLBACK_PROHIBITED'

export class PhotoUploadRollbackBlockedError extends Error {
  constructor(report) {
    super(RAW_LEGACY_ROLLBACK_BLOCKED_CODE)
    this.name = 'PhotoUploadRollbackBlockedError'
    this.code = RAW_LEGACY_ROLLBACK_BLOCKED_CODE
    this.report = report
  }
}

function isBlobRetained(record) {
  return Boolean(record && typeof Blob === 'function' && record.blob instanceof Blob)
}

function toSafeReport(actorScopeType, actorScopeId, records) {
  const statusCounts = {}
  const queueIds = []
  let blockingCount = 0
  let hasRetainedLocalBlob = false

  for (const record of records) {
    queueIds.push(record.queue_id)
    const status = record.status
    statusCounts[status] = (statusCounts[status] || 0) + 1
    if (status !== PHOTO_UPLOAD_STATUSES.DONE) {
      blockingCount += 1
    }
    if (isBlobRetained(record)) {
      hasRetainedLocalBlob = true
    }
  }

  const allowed = blockingCount === 0
  return {
    actorScopeType,
    actorScopeId,
    blockingCount,
    statusCounts,
    queueIds,
    hasRetainedLocalBlob,
    RAW_LEGACY_ROLLBACK_ALLOWED: allowed,
    PHOTO_UPLOAD_RUNTIME_REQUIRED: !allowed,
  }
}

export function createPhotoUploadRollbackRecovery({ db } = {}) {
  if (!db || typeof db.listRecordsForActor !== 'function') {
    throw new Error('db is required')
  }

  async function inspectRollbackSafety({ actorScopeType, actorScopeId }) {
    const records = await db.listRecordsForActor({ actorScopeType, actorScopeId })
    return toSafeReport(actorScopeType, actorScopeId, records)
  }

  async function assertLegacyRollbackSafe(input) {
    const report = await inspectRollbackSafety(input)
    if (report.RAW_LEGACY_ROLLBACK_ALLOWED !== true) {
      throw new PhotoUploadRollbackBlockedError(report)
    }
    return report
  }

  return {
    inspectRollbackSafety,
    assertLegacyRollbackSafe,
  }
}

const { createClient } = require('@supabase/supabase-js')

const supabaseAdmin = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async (req, res) => {
  try {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - 45)
    const cutoff = cutoffDate.toISOString().split('T')[0]

    console.log(`[cleanup] Removing data older than ${cutoff}`)
    const stats = {}

    // 1. Get old job IDs (collection_date older than 45 days)
    const { data: oldJobs } = await supabaseAdmin
      .from('crms_jobs')
      .select('id')
      .lt('collection_date', cutoff)

    const oldJobIds = (oldJobs || []).map(j => j.id)
    stats.oldJobs = oldJobIds.length
    console.log(`[cleanup] Found ${oldJobIds.length} old jobs`)

    if (oldJobIds.length > 0) {
      // 2. Get report IDs for old jobs
      const { data: oldReports } = await supabaseAdmin
        .from('linens_reports')
        .select('id')
        .in('crms_job_id', oldJobIds)

      const oldReportIds = (oldReports || []).map(r => r.id)
      stats.oldReports = oldReportIds.length

      if (oldReportIds.length > 0) {
        // 3. Get photo paths before deleting
        const { data: photos } = await supabaseAdmin
          .from('linens_report_photos')
          .select('photo_url')
          .in('report_id', oldReportIds)

        const photoPaths = (photos || []).map(p => p.photo_url).filter(Boolean)
        stats.photos = photoPaths.length

        // 4. Delete photos from Storage
        if (photoPaths.length > 0) {
          const { error: storageErr } = await supabaseAdmin
            .storage
            .from('linens-reports')
            .remove(photoPaths)
          if (storageErr) console.warn('[cleanup] Storage delete warning:', storageErr.message)
        }

        // 5. Delete report photos from DB
        await supabaseAdmin
          .from('linens_report_photos')
          .delete()
          .in('report_id', oldReportIds)

        // 6. Delete report items
        await supabaseAdmin
          .from('linens_report_items')
          .delete()
          .in('report_id', oldReportIds)

        // 7. Delete reports
        await supabaseAdmin
          .from('linens_reports')
          .delete()
          .in('crms_job_id', oldJobIds)
      }

      // 8. Delete evidence photos for old jobs
      const { data: evidencePhotos } = await supabaseAdmin
        .from('evidence_photos')
        .select('file_path')
        .in('job_id', oldJobIds)

      const evidencePaths = (evidencePhotos || [])
        .map(p => p.file_path)
        .filter(Boolean)
      stats.evidencePhotos = evidencePaths.length

      if (evidencePaths.length > 0) {
        await supabaseAdmin
          .storage
          .from('evidence-photos')
          .remove(evidencePaths)
      }

      await supabaseAdmin
        .from('evidence_photos')
        .delete()
        .in('job_id', oldJobIds)

      // 9. Delete job notes for old jobs
      await supabaseAdmin
        .from('job_notes')
        .delete()
        .in('job_id', oldJobIds)

      // 10. Delete job items for old jobs
      await supabaseAdmin
        .from('crms_job_items')
        .delete()
        .in('job_id', oldJobIds)
    }

    // 11. Clean up old sync_runs (keep last 30 days only)
    const syncCutoff = new Date()
    syncCutoff.setDate(syncCutoff.getDate() - 30)
    await supabaseAdmin
      .from('sync_runs')
      .delete()
      .lt('created_at', syncCutoff.toISOString())
    stats.syncRunsCleaned = true

    console.log('[cleanup] Done:', stats)
    return res.status(200).json({ success: true, stats, cutoff })

  } catch (err) {
    console.error('[cleanup] Error:', err)
    return res.status(500).json({ error: err.message })
  }
}

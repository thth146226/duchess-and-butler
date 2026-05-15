import { RMS_STATUS_META, formatRmsRowStatusDetail } from '../lib/refreshJobFromRms'

export default function RmsRowStatusBadge({ scanResult }) {
  const status = scanResult?.status || 'notChecked'
  const meta = RMS_STATUS_META[status] || RMS_STATUS_META.notChecked
  const detail = formatRmsRowStatusDetail(scanResult)

  return (
    <div style={{ display: 'grid', gap: '6px', minWidth: 0 }}>
      <span
        style={{
          display: 'inline-block',
          width: 'fit-content',
          fontSize: '10px',
          fontWeight: '600',
          padding: '2px 8px',
          borderRadius: '4px',
          background: meta.bg,
          color: meta.color,
          whiteSpace: 'nowrap',
        }}
      >
        {meta.label}
      </span>
      {detail && (
        <div style={{ fontSize: '10px', color: '#6B6860', lineHeight: 1.4 }}>{detail}</div>
      )}
    </div>
  )
}

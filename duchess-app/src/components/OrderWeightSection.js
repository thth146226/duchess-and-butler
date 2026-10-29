import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  fetchAtaCatalog,
  formatKilograms,
  loadOrderWeight,
  orderWeightMessage,
  presentOrderWeight,
} from '../lib/orderWeight'

function ruleText(line) {
  if (line.disposition !== 'calculated') {
    return line.label || ''
  }
  const unit = line.unitName.toLowerCase()
  const container = line.containers === 1 ? unit : `${unit}s`
  const each = formatKilograms(line.containerMicro)
  return `${line.containers} ${container} × ${each} kg`
}

export default function OrderWeightSection({ jobId, items, itemsError }) {
  const [view, setView] = useState(null)

  useEffect(() => {
    let cancelled = false
    setView(null)
    if (itemsError) {
      setView(presentOrderWeight(null, { itemsError: true }))
      return undefined
    }
    loadOrderWeight(items, () => fetchAtaCatalog(supabase)).then((result) => {
      if (!cancelled) {
        setView(presentOrderWeight(result))
      }
    })
    return () => {
      cancelled = true
    }
  }, [jobId, items, itemsError])

  if (!view) {
    return null
  }

  const tone = view.status === 'PARTIAL'
    ? { background: '#FAEEDA', color: '#854F0B' }
    : view.overLimit
      ? { background: '#FCEBEB', color: '#A32D2D' }
      : { background: '#F7F3EE', color: '#6B6860' }
  const details = view.lines.filter((line) => line.disposition !== 'not_physical')

  return (
    <section style={{ marginTop: '16px', borderTop: '1px solid #EDE8E0', paddingTop: '14px' }}>
      <div style={{ fontSize: '10px', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#B8965A', marginBottom: '8px' }}>
        Order weight
      </div>
      <div style={{ background: tone.background, color: tone.color, borderRadius: '8px', padding: '12px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            {view.knownKg != null ? (
              <>
                <div style={{ fontSize: '20px', fontWeight: '600', color: '#1C1C1E' }}>{view.knownKg} kg</div>
                <div style={{ fontSize: '12px', marginTop: '2px' }}>
                  {view.status === 'PARTIAL' ? 'Known weight so far' : 'Calculated weight'}
                </div>
              </>
            ) : (
              <div style={{ fontSize: '16px', fontWeight: '600', color: '#1C1C1E' }}>
                {view.status === 'PARTIAL' ? 'Weight not confirmed' : 'Weight unavailable'}
              </div>
            )}
          </div>
          {view.reason == null && (
            <div style={{ fontSize: '12px', textAlign: 'right' }}>
              <div>{view.calculated} calculated</div>
              <div>{view.missing} without a confirmed weight</div>
            </div>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '8px', lineHeight: 1.5 }}>{orderWeightMessage(view)}</div>
        <div style={{ fontSize: '12px', marginTop: '6px' }}>Informed Luton limit: 1,200 kg.</div>
        {view.percent != null && (
          <div style={{ fontSize: '12px', marginTop: '4px' }}>
            {view.percent}% of that limit. Remaining capacity: {view.remainingKg} kg.
          </div>
        )}
        {view.overLimit && (
          <div style={{ fontSize: '12px', marginTop: '8px', color: '#A32D2D' }}>
            One Luton would exceed the informed 1,200 kg limit. Redistribute the load or add vehicles.
            {' '}About {view.estimateVehicles} Lutons is only an estimate. It does not account for the real payload, occupants, extra equipment, axle load, or physical space.
          </div>
        )}
        {view.status === 'COMPLETE' && !view.overLimit && (
          <div style={{ fontSize: '12px', marginTop: '8px' }}>
            This figure is the informed weight limit only. It does not confirm that one vehicle has enough space or a safe axle load.
          </div>
        )}
      </div>
      {details.length > 0 && (
        <details style={{ marginTop: '10px' }}>
          <summary style={{ fontSize: '12px', color: '#6B6860', cursor: 'pointer' }}>Line weights and packing rules</summary>
          <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
            {details.map((line) => (
              <li key={line.id || line.name} style={{ padding: '8px 0', borderBottom: '1px solid #EDE8E0', fontSize: '12px' }}>
                <div style={{ fontWeight: '600', color: '#1C1C1E' }}>{line.name}</div>
                <div style={{ color: '#6B6860', marginTop: '2px' }}>
                  {line.disposition === 'calculated' ? `${formatKilograms(line.weightMicro)} kg · ${ruleText(line)}` : line.label}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

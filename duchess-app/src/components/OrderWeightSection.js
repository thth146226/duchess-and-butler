import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  fetchAtaCatalog,
  formatKilograms,
  loadOrderWeight,
  measurementRequest,
  orderWeightMessage,
  presentOrderWeight,
  refreshAtaCatalog,
} from '../lib/orderWeight'

function ruleText(line) {
  if (line.plan && line.plan.weightState === 'unknown-partial') {
    return 'Partly filled pack. The full pack weight is not an exact weight.'
  }
  if (line.disposition !== 'calculated' && line.disposition !== 'preview') {
    return line.label || ''
  }
  if (!line.unitName || line.containerMicro == null) {
    return line.plan ? planText(line.plan) : (line.label || '')
  }
  const unit = line.unitName.toLowerCase()
  const container = line.containers === 1 ? unit : `${unit}s`
  const each = formatKilograms(line.containerMicro)
  return `${line.containers} ${container} × ${each} kg`
}

function planText(plan) {
  const boxes = (plan.boxes || []).map((box) => {
    const unit = String(box.unitName || 'pack').toLowerCase()
    if (!box.full) {
      return `${box.piecesEach} in a ${unit} of ${box.piecesPerUnit}, ${box.unfilled} empty`
    }
    const noun = box.count === 1 ? unit : (unit === 'box' ? 'boxes' : `${unit}s`)
    return `${box.count} ${noun} of ${box.piecesPerUnit}`
  }).join(' + ')
  if (plan.weightState === 'calculated') {
    return `${boxes} · ${formatKilograms(plan.calculatedMicro)} kg`
  }
  return `${boxes} · partly filled, weight unknown`
}

function alternativeText(alternative) {
  const pieces = alternative.piecesPerUnit == null ? 'unknown pack' : `${alternative.piecesPerUnit} per ${alternative.unitName.toLowerCase()}`
  const weight = alternative.weightKind === 'positive' ? `${formatKilograms(alternative.weightMicro)} kg` : 'weight not confirmed'
  return `${alternative.name} · ${pieces} · ${weight}`
}

export default function OrderWeightSection({ jobId, items, itemsError }) {
  const [packsByJob, setPacksByJob] = useState({})
  const [view, setView] = useState(null)
  const packs = packsByJob[jobId]

  useEffect(() => {
    let cancelled = false
    refreshAtaCatalog(supabase).catch(() => {
      if (cancelled) {
        return
      }
    })
    return () => {
      cancelled = true
    }
  }, [jobId])

  useEffect(() => {
    let cancelled = false
    setView(null)
    if (itemsError) {
      setView(presentOrderWeight(null, { itemsError: true }))
      return undefined
    }
    loadOrderWeight(items, () => fetchAtaCatalog(supabase), packs || {}).then((result) => {
      if (!cancelled) {
        setView(presentOrderWeight(result))
      }
    })
    return () => {
      cancelled = true
    }
  }, [jobId, items, itemsError, packs])

  function confirmPlan(lineId, plan) {
    setPacksByJob((current) => ({
      ...current,
      [jobId]: {
        ...(current[jobId] || {}),
        [lineId]: {
          confirmed: true,
          quantity: plan.fingerprint.quantity,
          rules: plan.fingerprint.rules,
        },
      },
    }))
  }

  function clearPlan(lineId) {
    setPacksByJob((current) => {
      const jobPacks = { ...(current[jobId] || {}) }
      delete jobPacks[lineId]
      return { ...current, [jobId]: jobPacks }
    })
  }

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
        {view.reason == null && (
          <div style={{ fontSize: '12px', marginTop: '6px', lineHeight: 1.5 }}>
            <div>Confirmed weight: {view.knownKg != null ? `${view.knownKg} kg` : 'not available'}</div>
            <div>Packaging preview: {view.previewKg ? `${view.previewKg} kg. This choice is not saved.` : 'not confirmed'}</div>
            <div>Unknown weight: {view.missing} {view.missing === 1 ? 'line' : 'lines'}</div>
          </div>
        )}
        {view.previewKg && (
          <div style={{ fontSize: '12px', marginTop: '6px', lineHeight: 1.5 }}>
            Packaging preview: {view.previewKg} kg. This choice is not saved.
          </div>
        )}
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
        <details style={{ marginTop: '10px' }} open>
          <summary style={{ fontSize: '12px', color: '#6B6860', cursor: 'pointer', minHeight: '44px', display: 'flex', alignItems: 'center' }}>Line weights and packing rules</summary>
          <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
            {details.map((line) => {
              const note = measurementRequest(line)
              const choices = line.alternatives || []
              return (
                <li key={line.id || line.name} style={{ padding: '8px 0', borderBottom: '1px solid #EDE8E0', fontSize: '12px' }}>
                  <div style={{ fontWeight: '600', color: '#1C1C1E' }}>{line.name}</div>
                  <div style={{ color: '#6B6860', marginTop: '2px', lineHeight: 1.45 }}>
                    {line.disposition === 'calculated' || line.disposition === 'preview'
                      ? `${formatKilograms(line.weightMicro)} kg · ${ruleText(line)}${line.disposition === 'preview' ? ' · preview' : ''}`
                      : line.label}
                  </div>
                  {note && <div style={{ color: '#6B6860', marginTop: '4px', lineHeight: 1.45 }}>{note}</div>}
                  {choices.length > 0 && (
                    <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                      {choices.map((alternative) => (
                        <li key={alternative.id} style={{ color: '#1C1C1E', lineHeight: 1.45 }}>{alternativeText(alternative)}</li>
                      ))}
                    </ul>
                  )}
                  {(line.plans || []).length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ fontSize: '12px', color: '#6B6860', marginBottom: '4px' }}>Labels / ATA packing</div>
                      {line.plans.map((plan) => {
                        const selected = line.planConfirmed && line.plan && line.plan.signature === plan.signature
                        return (
                          <button
                            key={plan.signature}
                            type="button"
                            onClick={() => confirmPlan(line.id, plan)}
                            style={{ display: 'block', minHeight: '44px', width: '100%', textAlign: 'left', marginTop: '4px', color: '#1C1C1E' }}
                          >
                            {selected ? 'Confirmed' : (plan.role === 'suggestion' ? 'Confirm Labels suggestion' : 'Confirm alternative')}
                            {' · '}
                            {plan.origin}
                            {' · '}
                            {selected ? (plan.weightState === 'calculated' ? 'confirmed weight' : 'selected, weight unknown') : 'not confirmed'}
                            {' · '}
                            {planText(plan)}
                          </button>
                        )
                      })}
                      {line.planConfirmed && (line.plans || []).length > 1 && (
                        <button
                          type="button"
                          onClick={() => clearPlan(line.id)}
                          style={{ display: 'block', minHeight: '44px', width: '100%', textAlign: 'left', marginTop: '4px' }}
                        >
                          Clear plan
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </section>
  )
}

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

const buttonStyle = {
  display: 'block',
  minHeight: '44px',
  width: '100%',
  textAlign: 'left',
  marginTop: '4px',
  color: '#1C1C1E',
}

function ruleText(line) {
  if (line.plan && line.plan.weightState === 'unknown-partial') {
    return 'Partly filled pack. The full pack weight is not an exact weight.'
  }
  if (line.disposition !== 'calculated' && line.disposition !== 'preview') {
    return line.label || ''
  }
  if (!line.unitName || line.containerMicro == null) {
    return line.plan ? boxDescription(line.plan) : (line.label || '')
  }
  const unit = line.unitName.toLowerCase()
  const container = line.containers === 1 ? unit : `${unit}s`
  const each = formatKilograms(line.containerMicro)
  return `${line.containers} ${container} × ${each} kg`
}

function boxDescription(plan) {
  return (plan.boxes || []).map((box) => {
    const unit = String(box.unitName || 'pack').toLowerCase()
    if (!box.full) {
      return `${box.piecesEach} in a ${unit} of ${box.piecesPerUnit}, ${box.unfilled} empty`
    }
    const noun = box.count === 1 ? unit : (unit === 'box' ? 'boxes' : `${unit}s`)
    return `${box.count} ${noun} of ${box.piecesPerUnit}`
  }).join(' + ')
}

function weightKey(plan) {
  if (plan.reliability === 'ATA_DERIVED_GROSS' && plan.derivedNumerator != null) {
    return `derived:${plan.derivedNumerator.toString()}/${plan.derivedDenominator.toString()}`
  }
  if (plan.weightState === 'calculated') return `verified:${plan.calculatedMicro.toString()}`
  if (plan.planningAllowanceMicro != null) return `allowance:${plan.planningAllowanceMicro.toString()}`
  return `unknown:${plan.weightState}`
}

function groupPlans(plans) {
  const groups = []
  for (const plan of plans) {
    const key = weightKey(plan)
    const existing = groups.find((group) => group.key === key)
    if (existing) existing.plans.push(plan)
    else groups.push({ key, plans: [plan] })
  }
  return groups
}

function weightCaption(plan, sameAsSuggestion, confirmed) {
  if (plan.reliability === 'ATA_DERIVED_GROSS' && plan.derivedNumerator != null) {
    const qualified = plan.qualified ? ' Partial bundle packaging is not recorded, so this remains a qualified estimate.' : ''
    const separated = plan.qualification === 'additional-material-not-separated'
      ? ' Extra packaging was not added because it is not known to be outside the full-box gross.'
      : ''
    return `Derived gross: ${formatKilograms(plan.derivedNumerator, plan.derivedDenominator)} kg. Calculated from the empty-box tare and the net content. It is not a scale measurement of this order.${qualified}${separated}`
  }
  if (plan.weightState === 'calculated') {
    const kg = formatKilograms(plan.calculatedMicro)
    if (confirmed) return `ATA full-pack total included: ${kg} kg.`
    const prefix = sameAsSuggestion ? 'Same ATA full-pack total' : 'ATA full-pack total'
    return `${prefix}: ${kg} kg. The weight is calculated from ATA full-pack records. It is not a scale measurement of this order.`
  }
  if (plan.planningAllowanceMicro != null) {
    const kg = formatKilograms(plan.planningAllowanceMicro)
    const prefix = sameAsSuggestion ? 'Same planning allowance' : 'Planning allowance'
    return `${prefix}: ${kg} kg. This is the gross weight of the full boxes, not a confirmed weight. It is not a scale measurement of this order.`
  }
  return 'Exact weight unknown. No planning allowance is available.'
}

function planIsSelected(line, plan) {
  return Boolean((line.planSelected || line.planConfirmed) && line.plan && line.plan.signature === plan.signature)
}

function PlanOption({ line, plan, onSelect, hideCaption }) {
  const selected = planIsSelected(line, plan)
  const confirmed = selected && line.planConfirmed && plan.weightState === 'calculated'
  return (
    <div>
      {(!hideCaption || confirmed) && (
        <div style={{ color: '#6B6860', marginTop: '4px', lineHeight: 1.45 }}>
          {weightCaption(plan, false, confirmed)}
        </div>
      )}
      <button type="button" onClick={() => onSelect(plan)} style={buttonStyle}>
        {selected ? 'Selected packing' : 'Use this packing'}
        {' · '}
        {boxDescription(plan)}
      </button>
    </div>
  )
}

function PackingChoices({ line, onSelect, onClear }) {
  const plans = line.plans || []
  const current = line.plan
  if (!current && !plans.length) return null
  const truncation = (line.packingTruncation || []).map((reason) => (
    <div key={reason} style={{ color: '#854F0B', marginTop: '4px', lineHeight: 1.45 }}>{reason}</div>
  ))
  const alternatives = plans.filter((plan) => !current || plan.signature !== current.signature)
  const needsTare = current && current.reliability === 'GROSS_PACKING_ALLOWANCE'
  return (
    <div style={{ marginTop: '8px' }}>
      {current && (
        <div style={{ color: '#6B6860', lineHeight: 1.45 }}>
          <div>{line.planSelected ? 'Selected packing' : 'Automatic packing'} · {boxDescription(current)}</div>
          <div style={{ marginTop: '4px' }}>{weightCaption(current, false, line.planConfirmed && current.weightState === 'calculated')}</div>
          {needsTare && (
            <div style={{ marginTop: '4px', color: '#854F0B' }}>Needs empty-box tare before a derived weight can be calculated.</div>
          )}
          {current.catalogInconsistent && (
            <div style={{ marginTop: '4px', color: '#854F0B' }}>Catalog net weights disagree after each box tare. Each box keeps its own weight.</div>
          )}
        </div>
      )}
      {needsTare && (
        <div style={{ color: '#6B6860', marginTop: '4px', lineHeight: 1.45 }}>
          A planning allowance counts every box at the full gross weight recorded for that box size. It does not divide that weight by the number of pieces.
        </div>
      )}
      {alternatives.length > 0 && (
        <details style={{ marginTop: '8px' }}>
          <summary style={{ fontSize: '12px', color: '#6B6860', cursor: 'pointer', minHeight: '44px', display: 'flex', alignItems: 'center' }}>
            Change packing
          </summary>
          {groupPlans(alternatives).map((group) => (
            <div key={group.key} style={{ marginTop: '8px' }}>
              <div style={{ color: '#6B6860', lineHeight: 1.45 }}>
                {weightCaption(group.plans[0], current ? weightKey(group.plans[0]) === weightKey(current) : false)}
              </div>
              {group.plans.map((plan) => (
                <PlanOption
                  key={plan.signature}
                  line={line}
                  plan={plan}
                  onSelect={onSelect}
                  hideCaption
                />
              ))}
            </div>
          ))}
        </details>
      )}
      {truncation}
      {line.planSelected && (
        <button type="button" onClick={onClear} style={buttonStyle}>
          Use automatic packing
        </button>
      )}
    </div>
  )
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

  function writePack(lineId, plan, weightConfirmed) {
    setPacksByJob((current) => ({
      ...current,
      [jobId]: {
        ...(current[jobId] || {}),
        [lineId]: {
          selected: true,
          weightConfirmed: Boolean(weightConfirmed),
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
                  {view.status === 'PARTIAL' ? 'ATA total so far' : 'Calculated weight'}
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
              <div>{view.missing} without an ATA total</div>
            </div>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '8px', lineHeight: 1.5 }}>{orderWeightMessage(view)}</div>
        {view.reason == null && (
          <div style={{ fontSize: '12px', marginTop: '6px', lineHeight: 1.5 }}>
            <div>ATA full-pack total: {view.knownKg != null ? `${view.knownKg} kg` : 'not included'}</div>
            <div>
              Derived gross: {view.derivedKg
                ? `${view.derivedKg} kg. From tare and net content. It is not a scale measurement of this order.`
                : 'not available'}
            </div>
            <div>
              Planning allowance: {view.planningKg
                ? `${view.planningKg} kg. Provisional full-box gross weight. Not a confirmed weight. It is not a scale measurement of this order.`
                : 'not available'}
            </div>
            <div>Packaging preview: {view.previewKg ? `${view.previewKg} kg. This choice is not saved.` : 'not confirmed'}</div>
            <div>Unknown weight: {view.missing} {view.missing === 1 ? 'line' : 'lines'}</div>
          </div>
        )}
        <div style={{ fontSize: '12px', marginTop: '6px' }}>Informed Luton limit: 1,200 kg.</div>
        {view.percent != null && (
          <div style={{ fontSize: '12px', marginTop: '4px' }}>
            {view.percent}% of that limit. Remaining capacity: {view.remainingKg} kg.
          </div>
        )}
        {view.overLimit && view.estimateVehicles != null && (
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
                <li key={line.id || line.name} style={{ padding: '8px 0', borderBottom: '1px solid #EDE8E0', fontSize: '12px', background: line.plan && line.plan.reliability === 'GROSS_PACKING_ALLOWANCE' ? '#FAEEDA' : 'transparent' }}>
                  <div style={{ fontWeight: '600', color: '#1C1C1E' }}>{line.name}</div>
                  <div style={{ color: '#6B6860', marginTop: '2px', lineHeight: 1.45 }}>
                    {line.disposition === 'derived' && line.derivedNumerator != null
                      ? `Derived gross ${formatKilograms(line.derivedNumerator, line.derivedDenominator)} kg · ${line.plan ? boxDescription(line.plan) : line.label}`
                      : (line.disposition === 'partial_box' && line.planningAllowanceMicro != null
                        ? `Planning allowance ${formatKilograms(line.planningAllowanceMicro)} kg · ${line.plan ? boxDescription(line.plan) : ''}`
                        : (line.disposition === 'calculated' || line.disposition === 'preview'
                          ? `${formatKilograms(line.weightMicro)} kg · ${ruleText(line)}${line.disposition === 'preview' ? ' · preview' : ''}`
                          : line.label))}
                  </div>
                  {note && <div style={{ color: '#6B6860', marginTop: '4px', lineHeight: 1.45 }}>{note}</div>}
                  {choices.length > 0 && (
                    <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                      {choices.map((alternative) => (
                        <li key={alternative.id} style={{ color: '#1C1C1E', lineHeight: 1.45 }}>{alternativeText(alternative)}</li>
                      ))}
                    </ul>
                  )}
                  <PackingChoices
                    line={line}
                    onSelect={(plan) => writePack(line.id, plan, true)}
                    onClear={() => clearPlan(line.id)}
                  />
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </section>
  )
}

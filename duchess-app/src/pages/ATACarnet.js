import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

const CATEGORIES = ['glassware', 'crockery', 'cutlery', 'linens', 'furniture', 'other']
const CAT_STYLE = {
  glassware:  { bg: '#E6F1FB', color: '#0C447C' },
  crockery:   { bg: '#FAEEDA', color: '#854F0B' },
  cutlery:    { bg: '#EAF3DE', color: '#3B6D11' },
  linens:     { bg: '#EEEDFE', color: '#3C3489' },
  furniture:  { bg: '#F1EFE8', color: '#5F5E5A' },
  other:      { bg: '#F1EFE8', color: '#5F5E5A' },
}

export default function ATACarnet() {
  const { profile } = useAuth()
  const [tab, setTab]             = useState('calculator')
  const [items, setItems]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [catFilter, setCat]       = useState('all')
  const [toast, setToast]         = useState(null)
  const [itemModal, setItemModal] = useState(false)
  const [editItem, setEditItem]   = useState(null)
  const [saving, setSaving]       = useState(false)

  const emptyItem = { name: '', category: 'glassware', unit_name: 'box', pieces_per_unit: '', weight_per_unit: '', notes: '' }
  const [itemForm, setItemForm]   = useState(emptyItem)

  // Calculator state
  const [eventName, setEventName]       = useState('')
  const [destination, setDestination]   = useState('')
  const [calcItems, setCalcItems]       = useState([])
  const [savedCalcs, setSavedCalcs]     = useState([])
  const [viewCalc, setViewCalc]         = useState(null)
  const [savingCalc, setSavingCalc]     = useState(false)

  useEffect(() => { fetchItems(); fetchCalcs() }, [])

  async function fetchItems() {
    const { data } = await supabase
      .from('ata_items')
      .select('*')
      .eq('active', true)
      .order('category')
      .order('name')
    if (data) {
      setItems(data)
      setCalcItems(data.map(item => ({ ...item, boxes: 0, total_weight: 0 })))
    }
    setLoading(false)
  }

  async function fetchCalcs() {
    const { data } = await supabase
      .from('ata_calculations')
      .select('*, ata_calculation_items(*)')
      .order('created_at', { ascending: false })
    if (data) setSavedCalcs(data)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  function updateBoxes(itemId, boxes) {
    const num = Math.max(0, parseInt(boxes) || 0)
    setCalcItems(prev => prev.map(i =>
      i.id === itemId
        ? { ...i, boxes: num, total_weight: parseFloat((num * i.weight_per_unit).toFixed(3)) }
        : i
    ))
  }

  const activeCalcItems = calcItems.filter(i => i.boxes > 0)
  const totalWeight = activeCalcItems.reduce((sum, i) => sum + (i.total_weight || 0), 0)
  const totalBoxes  = activeCalcItems.reduce((sum, i) => sum + i.boxes, 0)

  async function saveCalculation() {
    if (!eventName) { showToast('Please enter an event name', 'error'); return }
    if (activeCalcItems.length === 0) { showToast('Please add at least one item', 'error'); return }
    setSavingCalc(true)
    const { data: calc, error } = await supabase
      .from('ata_calculations')
      .insert({
        event_name:      eventName,
        destination:     destination || null,
        created_by:      profile?.id || null,
        created_by_name: profile?.name || null,
        total_weight:    parseFloat(totalWeight.toFixed(3)),
        total_boxes:     totalBoxes,
        status:          'saved',
      })
      .select()
      .single()

    if (error) { showToast('Error saving: ' + error.message, 'error'); setSavingCalc(false); return }

    await supabase.from('ata_calculation_items').insert(
      activeCalcItems.map(i => ({
        calculation_id:  calc.id,
        ata_item_id:     i.id,
        item_name:       i.name,
        weight_per_unit: i.weight_per_unit,
        unit_name:       i.unit_name,
        pieces_per_unit: i.pieces_per_unit,
        boxes:           i.boxes,
        total_weight:    i.total_weight,
      }))
    )

    showToast('Calculation saved successfully')
    setSavingCalc(false)
    fetchCalcs()
    clearCalc()
  }

  function clearCalc() {
    setEventName('')
    setDestination('')
    setCalcItems(prev => prev.map(i => ({ ...i, boxes: 0, total_weight: 0 })))
  }

  async function deleteCalc(id) {
    if (!window.confirm('Delete this calculation?')) return
    await supabase.from('ata_calculations').delete().eq('id', id)
    showToast('Calculation deleted')
    setViewCalc(null)
    fetchCalcs()
  }

  function printCalc(calc) {
    const rows = (calc.ata_calculation_items || []).map(i => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #EDE8E0;font-size:13px">${i.item_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #EDE8E0;font-size:13px;text-align:center">${i.unit_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #EDE8E0;font-size:13px;text-align:center">${i.pieces_per_unit}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #EDE8E0;font-size:13px;text-align:center">${i.weight_per_unit} kg</td>
        <td style="padding:8px 12px;border-bottom:1px solid #EDE8E0;font-size:13px;text-align:center">${i.boxes}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #EDE8E0;font-size:13px;font-weight:600;text-align:right">${parseFloat(i.total_weight).toFixed(2)} kg</td>
      </tr>
    `).join('')

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>ATA Carnet — ${calc.event_name}</title>
        <style>
          body { font-family: Arial, sans-serif; color: #1C1C1E; padding: 40px; max-width: 800px; margin: 0 auto; }
          h1 { font-size: 22px; margin-bottom: 4px; }
          .meta { color: #6B6860; font-size: 13px; margin-bottom: 32px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
          th { background: #F7F3EE; padding: 10px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #6B6860; }
          th:not(:first-child) { text-align: center; }
          th:last-child { text-align: right; }
          .total { background: #1C1C1E; color: #fff; padding: 16px 20px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
          .total-label { font-size: 12px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
          .total-val { font-size: 28px; font-weight: 600; }
          .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #B8965A; text-align: center; font-size: 11px; color: #9CA3AF; }
        </style>
      </head>
      <body>
        <div style="text-align:center;margin-bottom:24px">
          <img src="https://duchessandbutler.com/wp-content/uploads/2025/02/duchess-butler-logo.png" style="height:50px" />
        </div>
        <h1>ATA Carnet Weight Declaration</h1>
        <div class="meta">
          Event: ${calc.event_name} · 
          ${calc.destination ? `Destination: ${calc.destination} · ` : ''}
          Date: ${new Date(calc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · 
          Prepared by: ${calc.created_by_name || 'Duchess & Butler'}
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th style="text-align:center">Unit</th>
              <th style="text-align:center">Pcs/Unit</th>
              <th style="text-align:center">kg/Unit</th>
              <th style="text-align:center">Units</th>
              <th style="text-align:right">Total kg</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="total">
          <div>
            <div class="total-label">Total weight</div>
            <div class="total-val">${parseFloat(calc.total_weight).toFixed(2)} kg</div>
          </div>
          <div style="text-align:right">
            <div class="total-label">Total units</div>
            <div class="total-val">${calc.total_boxes}</div>
          </div>
        </div>
        <div class="footer">
          Duchess & Butler Ltd · Unit 7 Oakengrove Yard · Hemel Hempstead · HP2 6EZ<br>
          T: 01442 262772 · recon@duchessandbutler.com
        </div>
      </body>
      </html>
    `
    const win = window.open('', '_blank')
    win.document.write(html)
    win.document.close()
    setTimeout(() => win.print(), 500)
  }

  async function saveItem() {
    if (!itemForm.name || !itemForm.weight_per_unit) {
      showToast('Name and weight are required', 'error'); return
    }
    setSaving(true)
    const payload = {
      ...itemForm,
      pieces_per_unit: parseInt(itemForm.pieces_per_unit) || 1,
      weight_per_unit: parseFloat(itemForm.weight_per_unit),
    }
    if (editItem) {
      await supabase.from('ata_items').update(payload).eq('id', editItem.id)
      showToast('Item updated')
    } else {
      await supabase.from('ata_items').insert(payload)
      showToast('Item added')
    }
    setSaving(false)
    setItemModal(false)
    setEditItem(null)
    setItemForm(emptyItem)
    fetchItems()
  }

  async function deleteItem(id) {
    if (!window.confirm('Delete this item?')) return
    await supabase.from('ata_items').update({ active: false }).eq('id', id)
    showToast('Item removed')
    fetchItems()
  }

  const filteredItems = items.filter(i => {
    const matchSearch = !search || i.name.toLowerCase().includes(search.toLowerCase())
    const matchCat = catFilter === 'all' || i.category === catFilter
    return matchSearch && matchCat
  })

  if (loading) return (
    <div style={{ padding: '48px', color: '#6B6860', fontFamily: "'DM Sans', sans-serif" }}>Loading…</div>
  )

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        {[['calculator', 'Weight Calculator'], ['library', 'Item Library'], ['history', 'Saved Calculations']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ fontSize: '13px', fontWeight: '500', padding: '8px 18px', borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", background: tab === id ? '#1C1C1E' : 'transparent', color: tab === id ? '#fff' : '#6B6860', border: `1px solid ${tab === id ? '#1C1C1E' : '#DDD8CF'}` }}
          >{label}</button>
        ))}
      </div>

      {/* ── CALCULATOR TAB ── */}
      {tab === 'calculator' && (
        <div>
          {/* Event info */}
          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px 20px', marginBottom: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', marginBottom: '5px' }}>Event name</label>
              <input value={eventName} onChange={e => setEventName(e.target.value)}
                placeholder="e.g. Paris Gala 2026"
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', marginBottom: '5px' }}>Destination</label>
              <input value={destination} onChange={e => setDestination(e.target.value)}
                placeholder="e.g. Paris, France"
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
            </div>
          </div>

          {/* Items table */}
          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 90px 90px', gap: 0, padding: '10px 16px', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF' }}>
              {['Item', 'kg/unit', 'Boxes', 'Total kg'].map((h, i) => (
                <div key={h} style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', textAlign: i > 0 ? 'center' : 'left' }}>{h}</div>
              ))}
            </div>
            {calcItems.map(item => {
              const cs = CAT_STYLE[item.category] || CAT_STYLE.other
              return (
                <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 90px 90px', gap: 0, padding: '10px 16px', borderBottom: '0.5px solid #EDE8E0', alignItems: 'center', background: item.boxes > 0 ? '#FFFEF8' : '#fff' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: item.boxes > 0 ? '500' : '400' }}>{item.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                      <span style={{ ...cs, fontSize: '9px', fontWeight: '600', padding: '1px 6px', borderRadius: '10px' }}>{item.category}</span>
                      <span style={{ fontSize: '10px', color: '#9CA3AF' }}>{item.pieces_per_unit} pcs/{item.unit_name}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: '12px', color: '#6B6860', textAlign: 'center' }}>{item.weight_per_unit}</div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <input
                      type="number"
                      min="0"
                      value={item.boxes || ''}
                      onChange={e => updateBoxes(item.id, e.target.value)}
                      placeholder="0"
                      style={{ width: '64px', padding: '6px 8px', border: `1.5px solid ${item.boxes > 0 ? '#B8965A' : '#DDD8CF'}`, borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", textAlign: 'center' }}
                    />
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: '500', color: item.boxes > 0 ? '#B8965A' : '#DDD8CF', textAlign: 'center' }}>
                    {item.boxes > 0 ? `${parseFloat(item.total_weight).toFixed(2)} kg` : '—'}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Total */}
          <div style={{ background: '#1C1C1E', borderRadius: '10px', padding: '18px 20px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '4px' }}>Total weight</div>
              <div style={{ fontSize: '36px', fontWeight: '500', color: '#fff', lineHeight: 1 }}>{totalWeight.toFixed(2)} kg</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}>{activeCalcItems.length} items · {totalBoxes} boxes</div>
              {activeCalcItems.map(i => (
                <div key={i.id} style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', marginTop: '2px' }}>
                  {i.name}: {i.boxes} × {i.weight_per_unit}kg = {parseFloat(i.total_weight).toFixed(2)}kg
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={saveCalculation} disabled={savingCalc || activeCalcItems.length === 0}
              style={{ flex: 1, padding: '11px', background: activeCalcItems.length === 0 ? '#DDD8CF' : '#B8965A', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: activeCalcItems.length === 0 ? 'default' : 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              {savingCalc ? 'Saving…' : 'Save Calculation'}
            </button>
            <button onClick={clearCalc}
              style={{ padding: '11px 20px', background: 'transparent', color: '#6B6860', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              Clear all
            </button>
          </div>
        </div>
      )}

      {/* ── LIBRARY TAB ── */}
      {tab === 'library' && (
        <div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search items..."
              style={{ flex: 1, minWidth: '160px', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif" }} />
            <select value={catFilter} onChange={e => setCat(e.target.value)}
              style={{ padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif" }}>
              <option value="all">All categories</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
            </select>
            <button onClick={() => { setEditItem(null); setItemForm(emptyItem); setItemModal(true) }}
              style={{ padding: '9px 18px', background: '#1C1C1E', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              + Add item
            </button>
          </div>

          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden' }}>
            {filteredItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px', color: '#9CA3AF', fontSize: '13px' }}>
                No items yet. Click \"+ Add item\" to add your first item.
              </div>
            ) : filteredItems.map((item, idx) => {
              const cs = CAT_STYLE[item.category] || CAT_STYLE.other
              return (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 18px', borderBottom: idx < filteredItems.length - 1 ? '0.5px solid #EDE8E0' : 'none' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: '500' }}>{item.name}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px' }}>
                      {item.pieces_per_unit} pcs per {item.unit_name}
                      {item.notes && ` · ${item.notes}`}
                    </div>
                  </div>
                  <span style={{ ...cs, fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '10px', flexShrink: 0 }}>
                    {item.category}
                  </span>
                  <div style={{ textAlign: 'right', minWidth: '80px' }}>
                    <div style={{ fontSize: '14px', fontWeight: '500' }}>{item.weight_per_unit} kg</div>
                    <div style={{ fontSize: '10px', color: '#9CA3AF' }}>per {item.unit_name}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button onClick={() => { setEditItem(item); setItemForm({ name: item.name, category: item.category, unit_name: item.unit_name, pieces_per_unit: item.pieces_per_unit, weight_per_unit: item.weight_per_unit, notes: item.notes || '' }); setItemModal(true) }}
                      style={{ fontSize: '11px', padding: '5px 10px', borderRadius: '4px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Edit</button>
                    <button onClick={() => deleteItem(item.id)}
                      style={{ fontSize: '11px', padding: '5px 10px', borderRadius: '4px', border: '1px solid #FECACA', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Delete</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {tab === 'history' && (
        <div>
          {savedCalcs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '64px 24px', background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px' }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚖️</div>
              <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '6px' }}>No saved calculations</div>
              <div style={{ fontSize: '13px', color: '#9CA3AF' }}>Go to the Calculator tab to create your first ATA Carnet calculation</div>
            </div>
          ) : savedCalcs.map(calc => (
            <div key={calc.id} style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', marginBottom: '12px', overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: viewCalc === calc.id ? '1px solid #DDD8CF' : 'none' }}>
                <div style={{ cursor: 'pointer' }} onClick={() => setViewCalc(viewCalc === calc.id ? null : calc.id)}>
                  <div style={{ fontSize: '14px', fontWeight: '500' }}>{calc.event_name}</div>
                  <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px' }}>
                    {calc.destination && `${calc.destination} · `}
                    {new Date(calc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {calc.created_by_name && ` · ${calc.created_by_name}`}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '18px', fontWeight: '500', color: '#B8965A' }}>{parseFloat(calc.total_weight).toFixed(2)} kg</div>
                    <div style={{ fontSize: '10px', color: '#9CA3AF' }}>{calc.total_boxes} boxes</div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={() => printCalc(calc)}
                      style={{ fontSize: '11px', padding: '5px 12px', borderRadius: '6px', border: 'none', background: '#B8965A', color: '#fff', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' }}>
                      Print / PDF
                    </button>
                    <button onClick={() => deleteCalc(calc.id)}
                      style={{ fontSize: '11px', padding: '5px 10px', borderRadius: '6px', border: '1px solid #FECACA', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
              {viewCalc === calc.id && (
                <div style={{ padding: '14px 18px' }}>
                  {(calc.ata_calculation_items || []).map(i => (
                    <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '0.5px solid #EDE8E0', fontSize: '13px' }}>
                      <span>{i.item_name} — {i.boxes} {i.unit_name}{i.boxes !== 1 ? 's' : ''}</span>
                      <span style={{ fontWeight: '500', color: '#B8965A' }}>{parseFloat(i.total_weight).toFixed(2)} kg</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', fontSize: '14px', fontWeight: '600' }}>
                    <span>Total</span>
                    <span style={{ color: '#B8965A' }}>{parseFloat(calc.total_weight).toFixed(2)} kg</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Item Modal */}
      {itemModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(28,28,30,0.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={e => e.target === e.currentTarget && setItemModal(false)}>
          <div style={{ background: '#fff', borderRadius: '12px', width: '100%', maxWidth: '480px' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #DDD8CF', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '16px', fontWeight: '500' }}>{editItem ? 'Edit Item' : 'Add Item'}</div>
              <button onClick={() => setItemModal(false)} style={{ background: '#F7F3EE', border: 'none', width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer', fontSize: '13px' }}>✕</button>
            </div>
            <div style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', marginBottom: '5px' }}>Item name *</label>
                <input value={itemForm.name} onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Lily Red Wine Glass"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', marginBottom: '5px' }}>Category</label>
                <select value={itemForm.category} onChange={e => setItemForm(f => ({ ...f, category: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif" }}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', marginBottom: '5px' }}>Unit name</label>
                <input value={itemForm.unit_name} onChange={e => setItemForm(f => ({ ...f, unit_name: e.target.value }))}
                  placeholder="e.g. box, crate, bag"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', marginBottom: '5px' }}>Pieces per unit</label>
                <input type="number" value={itemForm.pieces_per_unit} onChange={e => setItemForm(f => ({ ...f, pieces_per_unit: e.target.value }))}
                  placeholder="e.g. 24"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', marginBottom: '5px' }}>Weight per unit (kg) *</label>
                <input type="number" step="0.001" value={itemForm.weight_per_unit} onChange={e => setItemForm(f => ({ ...f, weight_per_unit: e.target.value }))}
                  placeholder="e.g. 12.4"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: '10px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', marginBottom: '5px' }}>Notes (optional)</label>
                <input value={itemForm.notes} onChange={e => setItemForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Any additional notes..."
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #DDD8CF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }} />
              </div>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid #DDD8CF', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setItemModal(false)} style={{ fontSize: '13px', padding: '8px 18px', borderRadius: '6px', border: '1px solid #DDD8CF', background: 'transparent', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Cancel</button>
              <button onClick={saveItem} disabled={saving}
                style={{ fontSize: '13px', padding: '8px 18px', borderRadius: '6px', border: 'none', background: '#1C1C1E', color: '#fff', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontWeight: '500' }}>
                {saving ? 'Saving…' : editItem ? 'Save changes' : 'Add item'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: '24px', right: '24px', background: '#1C1C1E', color: '#fff', padding: '12px 20px', borderRadius: '8px', fontSize: '13px', borderLeft: `3px solid ${toast.type === 'error' ? '#EF4444' : '#10B981'}`, zIndex: 999 }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

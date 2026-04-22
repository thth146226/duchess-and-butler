import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'

const CATEGORIES = ['glassware', 'charger_plates', 'dinnerware', 'cutlery', 'linens', 'furniture', 'other']
const CAT_STYLE = {
  glassware:      { bg: '#E6F1FB', color: '#0C447C' },
  charger_plates: { bg: '#FAEEDA', color: '#854F0B' },
  dinnerware:     { bg: '#FCEBEB', color: '#A32D2D' },
  cutlery:        { bg: '#EAF3DE', color: '#3B6D11' },
  linens:         { bg: '#EEEDFE', color: '#3C3489' },
  furniture:      { bg: '#F1EFE8', color: '#5F5E5A' },
  other:          { bg: '#F1EFE8', color: '#5F5E5A' },
}

function categorySelectLabel(c) {
  if (!c) return '—'
  if (c === 'charger_plates') return 'Charger Plates'
  if (c === 'dinnerware') return 'DinnerWare'
  return c.charAt(0).toUpperCase() + c.slice(1)
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
  const [editingCalcId, setEditingCalcId] = useState(null)
  const [calcCatFilter, setCalcCatFilter] = useState('all')
  const [calcSearch, setCalcSearch]       = useState('')

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

  async function openEdit(calc) {
    // Fetch the calc items from DB to get latest
    const { data: calcDbItems, error } = await supabase
      .from('ata_calculation_items')
      .select('*')
      .eq('calculation_id', calc.id)

    if (error) {
      showToast('Error loading calculation: ' + error.message, 'error')
      return
    }

    // Populate the form
    setEventName(calc.event_name || '')
    setDestination(calc.destination || '')

    // Map DB items back to calcItems shape (used by activeCalcItems)
    const mappedSelected = (calcDbItems || []).map(i => ({
      id:              i.ata_item_id,
      name:            i.item_name,
      weight_per_unit: i.weight_per_unit,
      unit_name:       i.unit_name,
      pieces_per_unit: i.pieces_per_unit,
      boxes:           i.boxes,
      total_weight:    i.total_weight,
      category:        'other',
      notes:           '',
    }))

    // Keep full library visible while marking selected rows with loaded quantities.
    setCalcItems(
      items.map(item => {
        const selected = mappedSelected.find(s => s.id === item.id)
        return selected
          ? { ...item, boxes: selected.boxes, total_weight: selected.total_weight }
          : { ...item, boxes: 0, total_weight: 0 }
      })
    )

    setEditingCalcId(calc.id)

    // Scroll to top so user sees the form
    window.scrollTo({ top: 0, behavior: 'smooth' })
    showToast('Calculation loaded for editing')
  }

  async function updateCalculation() {
    if (!eventName) { showToast('Please enter an event name', 'error'); return }
    if (activeCalcItems.length === 0) { showToast('Please add at least one item', 'error'); return }
    if (!editingCalcId) return

    setSavingCalc(true)

    // Update the header
    const { error: updateError } = await supabase
      .from('ata_calculations')
      .update({
        event_name:   eventName,
        destination:  destination || null,
        total_weight: parseFloat(totalWeight.toFixed(3)),
        total_boxes:  totalBoxes,
      })
      .eq('id', editingCalcId)

    if (updateError) {
      showToast('Error updating: ' + updateError.message, 'error')
      setSavingCalc(false)
      return
    }

    // Replace all items for this calculation.
    await supabase
      .from('ata_calculation_items')
      .delete()
      .eq('calculation_id', editingCalcId)

    await supabase.from('ata_calculation_items').insert(
      activeCalcItems.map(i => ({
        calculation_id:  editingCalcId,
        ata_item_id:     i.id,
        item_name:       i.name,
        weight_per_unit: i.weight_per_unit,
        unit_name:       i.unit_name,
        pieces_per_unit: i.pieces_per_unit,
        boxes:           i.boxes,
        total_weight:    i.total_weight,
      }))
    )

    showToast('Calculation updated successfully')
    setSavingCalc(false)
    setEditingCalcId(null)
    clearCalc()
    fetchCalcs()
  }

  function clearCalc() {
    setEventName('')
    setDestination('')
    setCalcItems(prev => prev.map(i => ({ ...i, boxes: 0, total_weight: 0 })))
    setEditingCalcId(null)
  }

  async function deleteCalc(id) {
    if (!window.confirm('Delete this calculation?')) return
    await supabase.from('ata_calculations').delete().eq('id', id)
    showToast('Calculation deleted')
    setViewCalc(null)
    fetchCalcs()
  }

  async function printCalc(calc) {
    // Fetch fresh items from DB
    const { data: items, error } = await supabase
      .from('ata_calculation_items')
      .select('*')
      .eq('calculation_id', calc.id)
      .order('item_name', { ascending: true })

    if (error) {
      showToast('Error loading items: ' + error.message, 'error')
      return
    }

    if (!items || items.length === 0) {
      showToast('No items found for this calculation', 'error')
      return
    }

    showToast('Generating PDF…')

    const rows = items.map(i => `
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid #EDE8E0;font-size:12px;font-weight:500">${i.item_name}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #EDE8E0;font-size:12px;text-align:center;color:#6B6860">${i.unit_name || '—'}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #EDE8E0;font-size:12px;text-align:center">${i.pieces_per_unit || 0}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #EDE8E0;font-size:12px;text-align:center">${parseFloat(i.weight_per_unit || 0).toFixed(2)} kg</td>
        <td style="padding:10px 14px;border-bottom:1px solid #EDE8E0;font-size:12px;text-align:center">${i.boxes || 0}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #EDE8E0;font-size:12px;font-weight:600;text-align:right;color:#1C1C1E">${parseFloat(i.total_weight || 0).toFixed(2)} kg</td>
      </tr>
    `).join('')

    const html = `
      <div style="font-family:Arial,'Helvetica Neue',sans-serif;color:#1C1C1E;padding:40px;width:760px;font-size:13px;line-height:1.5;background:#fff">
        <div style="text-align:center;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #B8965A">
          <img src="https://duchessandbutler.com/wp-content/uploads/2025/02/duchess-butler-logo.png" alt="Duchess & Butler" style="height:48px" crossorigin="anonymous" />
          <div style="font-size:10px;letter-spacing:0.2em;color:#B8965A;text-transform:uppercase;margin-top:8px">Luxury Tablescapes & Event Decor</div>
        </div>
        
        <h1 style="font-size:18px;margin:24px 0 6px 0;font-weight:600;letter-spacing:0.02em">ATA Carnet Weight Declaration</h1>
        
        <div style="background:#F7F3EE;border:1px solid #DDD8CF;border-radius:6px;padding:14px 18px;margin-bottom:24px;display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;font-size:12px">
          <div>
            <div style="color:#6B6860;font-size:10px;text-transform:uppercase;letter-spacing:0.06em">Event</div>
            <div style="color:#1C1C1E;font-weight:500;margin-top:2px">${calc.event_name}</div>
          </div>
          <div>
            <div style="color:#6B6860;font-size:10px;text-transform:uppercase;letter-spacing:0.06em">Destination</div>
            <div style="color:#1C1C1E;font-weight:500;margin-top:2px">${calc.destination || '—'}</div>
          </div>
          <div>
            <div style="color:#6B6860;font-size:10px;text-transform:uppercase;letter-spacing:0.06em">Prepared on</div>
            <div style="color:#1C1C1E;font-weight:500;margin-top:2px">${new Date(calc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
          </div>
          <div>
            <div style="color:#6B6860;font-size:10px;text-transform:uppercase;letter-spacing:0.06em">Prepared by</div>
            <div style="color:#1C1C1E;font-weight:500;margin-top:2px">${calc.created_by_name || 'Duchess & Butler'}</div>
          </div>
        </div>
        
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#B8965A;margin:24px 0 10px 0">Item Breakdown</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <thead>
            <tr>
              <th style="background:#1C1C1E;color:#fff;padding:10px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:500">Item</th>
              <th style="background:#1C1C1E;color:#fff;padding:10px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:500">Unit type</th>
              <th style="background:#1C1C1E;color:#fff;padding:10px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:500">Pcs / unit</th>
              <th style="background:#1C1C1E;color:#fff;padding:10px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:500">kg / unit</th>
              <th style="background:#1C1C1E;color:#fff;padding:10px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:500">Units</th>
              <th style="background:#1C1C1E;color:#fff;padding:10px 14px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:500">Total kg</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        
        <div style="margin-top:16px;padding:12px 14px;background:#FEF9F0;border-left:3px solid #B8965A;border-radius:4px;font-size:11px;color:#6B6860">
          Each line shows: pieces packed per unit, weight per unit, number of units, and the resulting total weight. The sum of all total weights equals the overall declared weight below.
        </div>
        
        <div style="background:#1C1C1E;color:#fff;padding:18px 22px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin-top:20px">
          <div>
            <div style="font-size:10px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Total weight</div>
            <div style="font-size:26px;font-weight:600;letter-spacing:-0.02em">${parseFloat(calc.total_weight).toFixed(2)} kg</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:10px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Total units</div>
            <div style="font-size:26px;font-weight:600;letter-spacing:-0.02em">${calc.total_boxes}</div>
          </div>
        </div>
        
        <div style="margin-top:40px;padding-top:16px;border-top:1px solid #DDD8CF;text-align:center;font-size:10px;color:#9CA3AF;line-height:1.6">
          Duchess & Butler Ltd · Unit 7 Oakengrove Yard · Hemel Hempstead · HP2 6EZ<br>
          T: 01442 262772 · recon@duchessandbutler.com · duchessandbutler.com
        </div>
      </div>
    `

    // Create a hidden container and render
    const container = document.createElement('div')
    container.style.position = 'absolute'
    container.style.left = '-9999px'
    container.style.top = '0'
    container.style.width = '760px'
    container.innerHTML = html
    document.body.appendChild(container)

    try {
      // Capture as high-resolution canvas
      const canvas = await html2canvas(container, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      })

      const imgData = canvas.toDataURL('image/png')
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      })

      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const imgWidth = pageWidth - 20 // 10mm margin each side
      const imgHeight = (canvas.height * imgWidth) / canvas.width

      // If content fits in one page
      if (imgHeight <= pageHeight - 20) {
        pdf.addImage(imgData, 'PNG', 10, 10, imgWidth, imgHeight)
      } else {
        // Split across pages
        let heightLeft = imgHeight
        let position = 10

        pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight)
        heightLeft -= (pageHeight - 20)

        while (heightLeft > 0) {
          position = heightLeft - imgHeight + 10
          pdf.addPage()
          pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight)
          heightLeft -= (pageHeight - 20)
        }
      }

      // Generate filename from event name
      const safeFilename = (calc.event_name || 'ATA_Carnet')
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_+/g, '_')
        .slice(0, 60)

      pdf.save(`ATA_Carnet_${safeFilename}.pdf`)
      showToast('PDF downloaded')
    } catch (err) {
      console.error('PDF generation error:', err)
      showToast('Error generating PDF: ' + err.message, 'error')
    } finally {
      // Clean up the hidden container
      document.body.removeChild(container)
    }
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
          {editingCalcId && (
            <div style={{
              background: '#FEF3C7',
              border: '1px solid #FDE68A',
              borderLeft: '3px solid #D97706',
              padding: '10px 14px',
              borderRadius: '6px',
              marginBottom: '14px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontFamily: "'DM Sans', sans-serif"
            }}>
              <div style={{ fontSize: '12px', color: '#92400E' }}>
                <strong>Editing calculation.</strong> Changes will replace the saved version.
              </div>
              <button
                onClick={() => { clearCalc(); showToast('Edit cancelled') }}
                style={{
                  fontSize: '11px', padding: '4px 10px',
                  borderRadius: '4px', border: '1px solid #FDE68A',
                  background: '#fff', color: '#92400E', cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif"
                }}
              >
                Cancel edit
              </button>
            </div>
          )}

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

          <input
            value={calcSearch}
            onChange={e => setCalcSearch(e.target.value)}
            placeholder="Search items..."
            style={{
              width: '100%',
              padding: '9px 12px',
              border: '1px solid #DDD8CF',
              borderRadius: '6px',
              fontSize: '13px',
              fontFamily: "'DM Sans', sans-serif",
              marginBottom: '10px',
              boxSizing: 'border-box',
            }}
          />

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            {['all', ...CATEGORIES].map(c => (
              <button key={c} onClick={() => setCalcCatFilter(c)}
                style={{
                  fontSize: '11px', fontWeight: '500', padding: '5px 12px',
                  borderRadius: '20px', cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                  background: calcCatFilter === c ? '#1C1C1E' : 'transparent',
                  color: calcCatFilter === c ? '#fff' : '#6B6860',
                  border: `1px solid ${calcCatFilter === c ? '#1C1C1E' : '#DDD8CF'}`,
                }}
              >
                {c === 'all' ? 'All'
                  : c === 'charger_plates' ? 'Charger Plates'
                    : c === 'dinnerware' ? 'DinnerWare'
                      : c.charAt(0).toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>

          {/* Items table */}
          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 90px 90px', gap: 0, padding: '10px 16px', background: '#F7F3EE', borderBottom: '1px solid #DDD8CF' }}>
              {['Item', 'kg/unit', 'Boxes', 'Total kg'].map((h, i) => (
                <div key={h} style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6B6860', textAlign: i > 0 ? 'center' : 'left' }}>{h}</div>
              ))}
            </div>
            {calcItems.filter(i => {
              const matchCat = calcCatFilter === 'all' || i.category === calcCatFilter
              const matchSearch = !calcSearch || i.name.toLowerCase().includes(calcSearch.toLowerCase())
              return matchCat && matchSearch
            }).map(item => {
              const cs = CAT_STYLE[item.category] || CAT_STYLE.other
              return (
                <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 90px 90px', gap: 0, padding: '10px 16px', borderBottom: '0.5px solid #EDE8E0', alignItems: 'center', background: item.boxes > 0 ? '#FFFEF8' : '#fff' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: item.boxes > 0 ? '500' : '400' }}>{item.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                      <span style={{ ...cs, fontSize: '9px', fontWeight: '600', padding: '1px 6px', borderRadius: '10px' }}>{categorySelectLabel(item.category)}</span>
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
            <button onClick={editingCalcId ? updateCalculation : saveCalculation} disabled={savingCalc || activeCalcItems.length === 0}
              style={{ flex: 1, padding: '11px', background: activeCalcItems.length === 0 ? '#DDD8CF' : '#B8965A', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: activeCalcItems.length === 0 ? 'default' : 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              {savingCalc ? (editingCalcId ? 'Updating…' : 'Saving…') : (editingCalcId ? 'Update calculation' : 'Save calculation')}
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
              {CATEGORIES.map(c => (
                <option key={c} value={c}>
                  {categorySelectLabel(c)}
                </option>
              ))}
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
                    {categorySelectLabel(item.category)}
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
                    <button onClick={() => openEdit(calc)}
                      style={{ fontSize: '11px', padding: '5px 10px', borderRadius: '6px', border: '1px solid #DDD8CF', background: '#F7F3EE', color: '#6B6860', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
                      Edit
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
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>
                      {categorySelectLabel(c)}
                    </option>
                  ))}
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

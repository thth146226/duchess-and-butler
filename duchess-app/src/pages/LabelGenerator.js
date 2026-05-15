import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import {
  LABEL_ORDER_COLOURS,
  buildAtaCapacityMap,
  generateLabelsForItem,
  getLabelOrderColour,
  isManualSplitValid,
  normalizeItemName,
  normalizeManualLabels,
  resolveJobItemRule,
  sumManualLabels,
} from '../lib/labelGenerator'
import { classifyJobItemWorkflow } from '../lib/itemWorkflowClassification'
import RmsJobRefreshPanel from '../components/RmsJobRefreshPanel'

const LABELS_PER_PAGE = 6

const SELF_COLLECTION_DEFAULT_POSTCODE = 'HP2 6EZ'
const UK_POSTCODE_REGEX = /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i

function chunkLabels(items, chunkSize) {
  const chunks = []
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize))
  return chunks
}

function extractUkPostcode(text) {
  if (!text) return null
  const match = String(text).match(UK_POSTCODE_REGEX)
  return match ? match[1].toUpperCase() : null
}

function confidenceStyle(level) {
  if (level === 'high') return { bg: '#EAF3DE', color: '#3B6D11' }
  if (level === 'medium') return { bg: '#FEF3C7', color: '#854F0B' }
  return { bg: '#FCEBEB', color: '#A32D2D' }
}

export default function LabelGenerator() {
  const { profile } = useAuth()
  const [orders, setOrders] = useState([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [selectedOrderLoading, setSelectedOrderLoading] = useState(false)
  const [jobItems, setJobItems] = useState([])
  const [jobItemsLoading, setJobItemsLoading] = useState(false)
  const [ataItems, setAtaItems] = useState([])
  const [ataItemsLoading, setAtaItemsLoading] = useState(false)
  const [showPastOrders, setShowPastOrders] = useState(false)
  const [search, setSearch] = useState('')
  const [error, setError] = useState(null)
  const [manualLabelsByItem, setManualLabelsByItem] = useState({})
  const [orderColourKey, setOrderColourKey] = useState('black')
  const [isPrinting, setIsPrinting] = useState(false)
  const [isExportingPdf, setIsExportingPdf] = useState(false)

  const isDev = process.env.NODE_ENV === 'development'
  function devLog(message, payload) {
    if (!isDev) return
    console.log(message, payload)
  }

  const today = new Date().toISOString().slice(0, 10)
  const orderColour = getLabelOrderColour(orderColourKey)
  const linenStudioBaseUrl = (process.env.REACT_APP_LINEN_STUDIO_URL || '').trim()
  const linenStudioJobRef =
    selectedOrder?.crms_ref || selectedOrder?.ref || selectedOrder?.job_ref || selectedOrder?.reference || null
  const linenStudioCrmsJobId = selectedOrder?.id || null
  const canOpenLinenStudio = Boolean(linenStudioBaseUrl && linenStudioJobRef && linenStudioCrmsJobId)

  if (profile?.role !== 'admin') {
    return (
      <div style={{ padding: '40px', fontFamily: "'DM Sans', sans-serif", textAlign: 'center' }}>
        <div style={{ fontSize: '14px', color: '#6B6860' }}>Access restricted to administrators.</div>
      </div>
    )
  }

  async function fetchOrders(includePast) {
    setOrdersLoading(true)
    setError(null)
    let query = supabase
      .from('crms_jobs')
      .select('id, crms_ref, event_name, client_name, venue, venue_address, delivery_date, collection_date, assigned_driver_name, status')
      .order('delivery_date', { ascending: true, nullsFirst: false })
    if (!includePast) query = query.gte('delivery_date', today)
    const { data, error: ordersError } = await query
    if (ordersError) {
      setError('Error loading orders: ' + ordersError.message)
      setOrders([])
      setOrdersLoading(false)
      return
    }
    setOrders(data || [])
    setOrdersLoading(false)
    devLog('[labels-phase2] orders loaded', { count: (data || []).length, includePast })
  }

  async function loadOrderData(orderId) {
    setSelectedOrderLoading(true)
    setJobItemsLoading(true)
    setAtaItemsLoading(true)
    setError(null)
    setManualLabelsByItem({})
    setOrderColourKey('black')

    const [{ data: orderData, error: orderError }, { data: itemsData, error: itemsError }, { data: ataData, error: ataError }] = await Promise.all([
      supabase
        .from('crms_jobs')
        .select('id, crms_ref, event_name, client_name, venue, venue_address, delivery_date, collection_date, assigned_driver_name, status')
        .eq('id', orderId)
        .single(),
      supabase
        .from('crms_job_items')
        .select('id, job_id, item_name, quantity, category')
        .eq('job_id', orderId)
        .order('item_name', { ascending: true }),
      supabase
        .from('ata_items')
        .select('id, name, category, pieces_per_unit, unit_name, active')
        .eq('active', true)
        .order('name', { ascending: true }),
    ])

    if (orderError) {
      setError('Error loading selected order: ' + orderError.message)
      setSelectedOrder(null)
    } else {
      setSelectedOrder(orderData || null)
      devLog('[labels-phase2] order selected', { id: orderData?.id, crms_ref: orderData?.crms_ref })
    }
    if (itemsError) {
      setError('Error loading job items: ' + itemsError.message)
      setJobItems([])
    } else {
      setJobItems(itemsData || [])
      devLog('[labels-phase2] job items loaded', { count: (itemsData || []).length, orderId })
    }
    if (ataError) {
      setError('Error loading ATA items: ' + ataError.message)
      setAtaItems([])
    } else {
      setAtaItems(ataData || [])
      devLog('[labels-phase2] ata items loaded', { count: (ataData || []).length })
    }
    setSelectedOrderLoading(false)
    setJobItemsLoading(false)
    setAtaItemsLoading(false)
  }

  useEffect(() => {
    fetchOrders(showPastOrders)
  }, [showPastOrders])

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return orders
    return orders.filter(order =>
      (order.crms_ref || '').toLowerCase().includes(q) ||
      (order.event_name || '').toLowerCase().includes(q) ||
      (order.client_name || '').toLowerCase().includes(q)
    )
  }, [orders, search])

  const postcodeDiagnostic = useMemo(() => {
    if (!selectedOrder) return { status: 'postcode unresolved', value: null }
    const driver = (selectedOrder.assigned_driver_name || '').toLowerCase().trim()
    if (driver === 'self collection') return { status: 'postcode resolved from self collection default', value: SELF_COLLECTION_DEFAULT_POSTCODE }
    const resolved = extractUkPostcode(selectedOrder.venue_address)
    if (resolved) return { status: 'postcode resolved from venue_address', value: resolved }
    return { status: 'postcode unresolved', value: null }
  }, [selectedOrder])

  const processing = useMemo(() => {
    const ataCapacityMap = buildAtaCapacityMap(ataItems)
    const ignoredItems = []
    const linenStudioItems = []
    const furnitureExcludedItems = []
    const serviceExcludedItems = []
    const displayPropExcludedItems = []
    const eligibleMatchedItems = []
    const outOfScopeItems = []

    for (let idx = 0; idx < jobItems.length; idx++) {
      const item = jobItems[idx]
      const itemKey = `${selectedOrder?.id || 'order'}:${normalizeItemName(item.item_name)}:${idx}`
      const candidate = { ...item, itemKey }
      const classification = classifyJobItemWorkflow(candidate)

      if (classification.workflowType === 'ignored') {
        ignoredItems.push(item)
        continue
      }

      if (classification.workflowType === 'linen') {
        devLog('[labels-linen] excluded for DB Linen Studio', {
          item_name: candidate.item_name,
          quantity: candidate.quantity,
        })
        linenStudioItems.push({
          ...candidate,
          exclusionReason: 'db-linen-studio',
        })
        continue
      }

      if (classification.workflowType === 'furniture_large_hire') {
        devLog('[labels-furniture] excluded from label workflow', {
          item_name: candidate.item_name,
          quantity: candidate.quantity,
          category: candidate.category,
        })
        furnitureExcludedItems.push({
          ...candidate,
          exclusionReason: 'furniture-large-hire',
        })
        continue
      }

      if (classification.workflowType === 'service_fee') {
        devLog('[labels-service] excluded from label workflow', {
          item_name: candidate.item_name,
          quantity: candidate.quantity,
          category: candidate.category,
        })
        serviceExcludedItems.push({
          ...candidate,
          exclusionReason: 'service-fee-non-physical',
        })
        continue
      }

      if (classification.workflowType === 'display_prop') {
        devLog('[labels-display-prop] excluded from label workflow', {
          item_name: candidate.item_name,
          quantity: candidate.quantity,
          category: candidate.category,
        })
        displayPropExcludedItems.push({
          ...candidate,
          exclusionReason: 'display-prop-non-label',
        })
        continue
      }

      const resolvedRule = resolveJobItemRule(candidate, ataCapacityMap)

      if (!resolvedRule.matched) {
        devLog('[labels-phase3b] unmatched item remained', { item_name: candidate.item_name, quantity: candidate.quantity })
        outOfScopeItems.push({ ...candidate, reason: resolvedRule.reason || 'No ATA rule found' })
        continue
      }
      if (resolvedRule.matchedBy && resolvedRule.matchedBy !== 'exact') {
        devLog('[labels-phase3b] alias match used', { item_name: candidate.item_name, matchedBy: resolvedRule.matchedBy, ata_name: resolvedRule.rule?.name })
      }
      const generated = generateLabelsForItem(candidate, resolvedRule)
      devLog('[labels-phase3b] category resolved', { item_name: generated.productName, category: generated.category })
      eligibleMatchedItems.push(generated)
    }
    return { ignoredItems, linenStudioItems, furnitureExcludedItems, serviceExcludedItems, displayPropExcludedItems, eligibleMatchedItems, outOfScopeItems }
  }, [ataItems, jobItems, selectedOrder])

  useEffect(() => {
    setManualLabelsByItem(prev => {
      const next = {}
      for (const item of processing.eligibleMatchedItems) {
        next[item.itemKey] = Array.isArray(prev[item.itemKey]) && prev[item.itemKey].length > 0
          ? prev[item.itemKey]
          : item.autoLabels.map(l => ({ id: l.id, quantity: l.quantity }))
      }
      return next
    })
  }, [processing.eligibleMatchedItems])

  const manualStateByItem = useMemo(() => {
    const map = {}
    for (const item of processing.eligibleMatchedItems) {
      const normalized = normalizeManualLabels(manualLabelsByItem[item.itemKey] || item.autoLabels, item.totalQty)
      map[item.itemKey] = { labels: normalized, total: sumManualLabels(normalized), valid: isManualSplitValid(normalized, item.totalQty) }
    }
    return map
  }, [manualLabelsByItem, processing.eligibleMatchedItems])

  const previewLabels = useMemo(() => {
    const labels = []
    for (const item of processing.eligibleMatchedItems) {
      const manual = manualStateByItem[item.itemKey]
      for (const split of manual?.labels || []) {
        labels.push({
          id: `${item.itemKey}:${split.id}`,
          productName: item.productName,
          quantity: split.quantity,
          category: item.category || 'other',
          packagingType: item.packagingType || 'unit',
        })
      }
    }
    return labels
  }, [manualStateByItem, processing.eligibleMatchedItems])

  const itemsSummaryRows = useMemo(() => (
    processing.eligibleMatchedItems.map(item => {
      const manual = manualStateByItem[item.itemKey] || { labels: [] }
      return {
        itemKey: item.itemKey,
        productName: item.productName,
        category: item.category || 'OTHER',
        totalQty: item.totalQty,
        packagingType: (item.packagingType || 'unit').toUpperCase(),
        capacity: item.capacity || 0,
        labelsCount: (manual.labels || []).length,
      }
    })
  ), [manualStateByItem, processing.eligibleMatchedItems])

  const outputSummary = useMemo(() => {
    const autoLabelsCount = processing.eligibleMatchedItems.reduce((sum, item) => sum + item.autoLabels.length, 0)
    const invalidManualCount = processing.eligibleMatchedItems.reduce((sum, item) => {
      const manual = manualStateByItem[item.itemKey]
      return sum + (manual && !manual.valid ? 1 : 0)
    }, 0)
    return {
      eligibleItems: processing.eligibleMatchedItems.length,
      generatedLabels: previewLabels.length,
      autoLabels: autoLabelsCount,
      needsAttention: invalidManualCount + processing.outOfScopeItems.length,
    }
  }, [manualStateByItem, previewLabels.length, processing.eligibleMatchedItems, processing.outOfScopeItems.length])

  const hasInvalidManualItems = useMemo(
    () => processing.eligibleMatchedItems.some(item => !manualStateByItem[item.itemKey]?.valid),
    [manualStateByItem, processing.eligibleMatchedItems]
  )

  const hasLinenStudioItems = Boolean(processing.linenStudioItems.length > 0)

  function confirmLinenLabelsBeforeOutput() {
    if (!hasLinenStudioItems) return true
    return window.confirm('This order also has linen items managed in DB Linen Studio. Have you printed the linen labels there as well?')
  }

  useEffect(() => {
    if (!selectedOrder) return
    devLog('[labels-phase2] postcode diagnostic', {
      orderId: selectedOrder.id,
      crms_ref: selectedOrder.crms_ref,
      status: postcodeDiagnostic.status,
      value: postcodeDiagnostic.value,
    })
  }, [postcodeDiagnostic, selectedOrder])

  function setItemManualQuantity(itemKey, labelId, value) {
    setManualLabelsByItem(prev => ({ ...prev, [itemKey]: (prev[itemKey] || []).map(label => (label.id === labelId ? { ...label, quantity: value } : label)) }))
  }
  function addManualLabelRow(itemKey) {
    setManualLabelsByItem(prev => {
      const current = prev[itemKey] || []
      return { ...prev, [itemKey]: [...current, { id: `${itemKey}-manual-${Date.now()}`, quantity: '' }] }
    })
  }
  function removeManualLabelRow(itemKey, labelId) {
    setManualLabelsByItem(prev => ({ ...prev, [itemKey]: (prev[itemKey] || []).filter(label => label.id !== labelId) }))
  }
  function resetItemToAutomatic(item) {
    setManualLabelsByItem(prev => ({ ...prev, [item.itemKey]: item.autoLabels.map(l => ({ id: l.id, quantity: l.quantity })) }))
  }
  function resetAllToAutomatic() {
    const next = {}
    for (const item of processing.eligibleMatchedItems) next[item.itemKey] = item.autoLabels.map(l => ({ id: l.id, quantity: l.quantity }))
    setManualLabelsByItem(next)
  }

  function getOutputBlockReason() {
    if (!selectedOrder) return 'Select an order before printing or exporting.'
    if (hasInvalidManualItems) return 'Cannot export while there are invalid manual splits.'
    if (!previewLabels.length) return 'No valid labels available to print or export.'
    return null
  }

  function renderLabelCardHtml(label, order, postcode, itemColour) {
    return `
      <div class="label-card">
        <div class="brand">Duchess & Butler</div>
        <div class="event-name">${(order?.event_name || '').toUpperCase()}</div>
        <div class="client-name">${order?.client_name || '—'}</div>
        <div class="postcode">${postcode || '—'}</div>
        <div class="support-row">
          <span>Ref: ${order?.crms_ref || '—'}</span>
          <span>${(label.packagingType || 'unit').toUpperCase()}</span>
        </div>
        <div class="item-box">
          <span class="item-text" style="color:${itemColour};">${label.quantity}x ${label.productName}</span>
        </div>
        <div class="footer-row">
          <span>${(label.category || 'OTHER').toUpperCase()}</span>
          <span>${(label.packagingType || 'unit').toUpperCase()}</span>
        </div>
      </div>
    `
  }

  function renderPrintLabelsHtml(labels) {
    const pages = chunkLabels(labels, LABELS_PER_PAGE)
    return pages
      .map((pageLabels, pageIndex) => {
        if (!pageLabels || pageLabels.length === 0) return ''
        const isLastPage = pageIndex === pages.length - 1
        const cardsHtml = pageLabels.map(label =>
          renderLabelCardHtml(label, selectedOrder, postcodeDiagnostic.value, orderColour.color)
        ).join('')
        return `
      <div class="label-print-page" data-last-page="${isLastPage ? 'true' : 'false'}">
        <div class="label-print-grid">${cardsHtml}</div>
      </div>
    `
      })
      .join('')
  }

  function renderPrintStyles() {
    return `
      @page {
        size: A4 portrait;
        margin: 0;
      }
      html {
        margin: 0;
        padding: 0;
        width: 210mm;
      }
      body {
        margin: 0;
        padding: 0;
        width: 210mm;
        font-family: 'DM Sans', Arial, sans-serif;
        background: #ffffff;
        color: #1C1C1E;
      }
      .label-print-root {
        margin: 0;
        padding: 0;
      }
      .label-print-page {
        width: 210mm;
        height: 297mm;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
        overflow: hidden;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        page-break-after: always;
        break-after: page;
        page-break-inside: avoid;
        break-inside: avoid;
        background: #fff;
      }
      .label-print-page[data-last-page="true"] {
        page-break-after: auto !important;
        break-after: auto !important;
      }
      .label-print-grid {
        display: grid;
        grid-template-columns: 98.5mm 5mm 98.5mm;
        grid-template-rows: 91.5mm 5mm 91.5mm 5mm 91.5mm;
        width: 202mm;
        height: 284.5mm;
        gap: 0 !important;
        column-gap: 0 !important;
        row-gap: 0 !important;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      .label-card {
        width: 98.5mm;
        height: 91.5mm;
        margin: 0 !important;
        box-sizing: border-box;
        justify-self: start;
        align-self: start;
        overflow: hidden;
        page-break-inside: avoid;
        break-inside: avoid;
        background: #ffffff !important;
        border: 1px solid #D3CEC3;
        border-radius: 10px;
        padding: 16px 14px;
        display: flex;
        flex-direction: column;
      }
      .label-card:nth-child(1) { grid-column: 1; grid-row: 1; }
      .label-card:nth-child(2) { grid-column: 3; grid-row: 1; }
      .label-card:nth-child(3) { grid-column: 1; grid-row: 3; }
      .label-card:nth-child(4) { grid-column: 3; grid-row: 3; }
      .label-card:nth-child(5) { grid-column: 1; grid-row: 5; }
      .label-card:nth-child(6) { grid-column: 3; grid-row: 5; }
      .brand {
        text-align: center;
        font-family: 'Times New Roman', serif;
        font-size: 20px;
        font-weight: 600;
        line-height: 1.05;
      }
      .event-name {
        text-align: center;
        margin-top: 8px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
      }
      .client-name, .postcode {
        text-align: center;
        margin-top: 4px;
        font-size: 11px;
      }
      .support-row {
        display: flex;
        justify-content: space-between;
        margin-top: 14px;
        font-size: 10px;
        letter-spacing: 0.03em;
      }
      .item-box {
        margin-top: 12px;
        border: 1.5px solid #1C1C1E;
        border-radius: 6px;
        padding: 16px 10px;
        text-align: center;
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 0;
      }
      .item-text {
        font-size: 15px;
        font-weight: 700;
        line-height: 1.35;
      }
      .footer-row {
        margin-top: 12px;
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
    `
  }

  function renderOutputMarkup(labels) {
    const labelsHtml = renderPrintLabelsHtml(labels)
    return `
      <style>${renderPrintStyles()}</style>
      <div class="label-print-root">${labelsHtml}</div>
    `
  }

  function renderOutputHtml(labels) {
    const labelsHtml = renderPrintLabelsHtml(labels)
    const styles = renderPrintStyles()

    return `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Duchess Labels - ${selectedOrder?.crms_ref || 'Order'}</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="label-print-root">${labelsHtml}</div>
        </body>
      </html>
    `
  }

  async function handlePrint() {
    const reason = getOutputBlockReason()
    if (reason) {
      setError(reason)
      return
    }
    if (!confirmLinenLabelsBeforeOutput()) return

    devLog('[labels-print-fix] print requested', { count: previewLabels.length })
    setIsPrinting(true)
    setError(null)

    const printWindow = window.open('', '_blank')
    if (!printWindow) {
      devLog('[labels-print-fix] popup blocked', {})
      setError('Printing was blocked by the browser. Please allow pop-ups for this site.')
      setIsPrinting(false)
      return
    }

    try {
      // 1) Write an immediate placeholder into the same window.
      printWindow.document.open()
      printWindow.document.write(
        '<!doctype html><html><head><meta charset="utf-8" /></head><body style="font-family: Arial, sans-serif; padding: 20px;">Preparing labels...</body></html>'
      )
      printWindow.document.close()
      devLog('[labels-print-fix] placeholder injected', {})

      const html = renderOutputHtml(previewLabels)

      // 2) Replace the contents of the same window with final printable HTML.
      printWindow.document.open()
      printWindow.document.write(html)
      printWindow.document.close()
      devLog('[labels-print-fix] printable html injected', {})

      // 3) Wait briefly to allow browser rendering before print.
      setTimeout(() => {
        printWindow.focus()
        printWindow.print()
        devLog('[labels-print-fix] print triggered', {})
      }, 300)
    } catch (err) {
      setError('Could not prepare print output: ' + err.message)
    } finally {
      setIsPrinting(false)
    }
  }

  async function handleExportPdf() {
    const reason = getOutputBlockReason()
    if (reason) {
      setError(reason)
      return
    }
    if (!confirmLinenLabelsBeforeOutput()) return

    devLog('[labels-output] pdf requested', { count: previewLabels.length })
    setIsExportingPdf(true)
    setError(null)

    const SHEET_W_MM = 210
    const SHEET_H_MM = 297

    const container = document.createElement('div')
    container.style.position = 'absolute'
    container.style.left = '-9999px'
    container.style.top = '0'
    container.style.width = `${SHEET_W_MM}mm`
    container.style.background = '#fff'
    container.innerHTML = renderOutputMarkup(previewLabels)
    document.body.appendChild(container)

    try {
      const pageNodes = container.querySelectorAll('.label-print-page')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [SHEET_W_MM, SHEET_H_MM] })

      for (let i = 0; i < pageNodes.length; i++) {
        const pageEl = pageNodes[i]
        const canvas = await html2canvas(pageEl, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff',
        })
        const imgData = canvas.toDataURL('image/png')
        if (i > 0) pdf.addPage([SHEET_W_MM, SHEET_H_MM], 'portrait')
        pdf.addImage(imgData, 'PNG', 0, 0, SHEET_W_MM, SHEET_H_MM)
      }

      const safeFilename = (selectedOrder?.event_name || selectedOrder?.crms_ref || 'labels')
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_+/g, '_')
        .slice(0, 60)
      pdf.save(`Duchess_Labels_${safeFilename}.pdf`)
      devLog('[labels-output] pdf exported', { count: previewLabels.length })
    } catch (err) {
      setError('Error exporting PDF: ' + err.message)
    } finally {
      document.body.removeChild(container)
      setIsExportingPdf(false)
    }
  }

  function openLinenLabelsForSelectedOrder() {
    if (!selectedOrder) return

    if (!linenStudioBaseUrl) {
      setError('DB Linen Studio URL is not configured (missing REACT_APP_LINEN_STUDIO_URL).')
      return
    }

    const jobRef = linenStudioJobRef
    const crmsJobId = linenStudioCrmsJobId

    if (!jobRef) {
      setError('Selected order is missing a job reference (e.g. `crms_ref`) and cannot open DB Linen Studio.')
      return
    }
    if (!crmsJobId) {
      setError('Selected order is missing `id` and cannot open DB Linen Studio.')
      return
    }

    const base = linenStudioBaseUrl.replace(/\/$/, '')
    const url = `${base}/labels?jobRef=${encodeURIComponent(jobRef)}&crmsJobId=${encodeURIComponent(crmsJobId)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div style={{ padding: '36px 42px 52px', fontFamily: "'DM Sans', sans-serif", maxWidth: '1320px', margin: '0 auto', background: '#FCFAF7' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '30px', fontWeight: '600', color: '#1C1C1E', margin: 0, letterSpacing: '-0.01em', fontFamily: "'Cormorant Garamond', serif", lineHeight: 1 }}>
          Label Generator
        </h1>
        <div style={{ fontSize: '13px', color: '#6B6860', marginTop: '10px', lineHeight: 1.5 }}>
          Generate premium operational labels from real orders with controlled manual adjustments.
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '14px', padding: '18px', marginBottom: '18px' }}>
        <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#B8965A', marginBottom: '12px' }}>Select order</div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by ref, event or client"
            style={{ flex: 1, minWidth: '240px', padding: '11px 13px', border: '1px solid #DDD8CF', borderRadius: '9px', fontSize: '13px', background: '#FFFEFC' }}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#6B6860' }}>
            <input type="checkbox" checked={showPastOrders} onChange={e => setShowPastOrders(e.target.checked)} />
            Show past orders
          </label>
        </div>
        <div style={{ border: '1px solid #E6E0D6', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '9px 12px', background: '#F7F3EE', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#6B6860', fontWeight: '600' }}>
            Orders ({filteredOrders.length})
          </div>
          <div style={{ maxHeight: '220px', overflowY: 'auto', background: '#fff' }}>
            {ordersLoading ? (
              <div style={{ padding: '20px 16px', fontSize: '13px', color: '#6B6860' }}>orders loading...</div>
            ) : filteredOrders.length === 0 ? (
              <div style={{ padding: '20px 16px', fontSize: '13px', color: '#9CA3AF' }}>empty state: no orders found.</div>
            ) : (
              filteredOrders.map(order => {
                const isSelected = selectedOrder?.id === order.id
                return (
                  <button
                    key={order.id}
                    onClick={() => loadOrderData(order.id)}
                    style={{ width: '100%', textAlign: 'left', border: 'none', borderTop: '1px solid #F3EFE7', background: isSelected ? '#FFFBF3' : '#fff', boxShadow: isSelected ? 'inset 3px 0 0 #C4A882' : 'none', padding: '12px 14px', cursor: 'pointer' }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: '600', color: '#1C1C1E', lineHeight: 1.35 }}>{order.crms_ref || '—'} · {order.event_name || '—'}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '4px', lineHeight: 1.4 }}>
                      {order.client_name || '—'} · DEL {order.delivery_date || '—'} · COL {order.collection_date || '—'} · {order.status || '—'}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>

      {!selectedOrder && !selectedOrderLoading && (
        <div style={{ background: '#FDFCFA', border: '1px dashed #DDD8CF', borderRadius: '8px', padding: '20px', fontSize: '13px', color: '#6B6860', marginBottom: '16px' }}>
          No selection state: choose an order to run the label engine.
        </div>
      )}
      {selectedOrderLoading && (
        <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '8px', padding: '16px', fontSize: '13px', color: '#6B6860', marginBottom: '16px' }}>
          selected order loading...
        </div>
      )}
      {error && (
        <div style={{ marginBottom: '16px', fontSize: '12px', color: '#A32D2D', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px' }}>
          {error}
        </div>
      )}

      {selectedOrder && (
        <>
          <div style={{ background: '#fff', border: '1px solid #D9D2C7', borderRadius: '14px', padding: '20px', marginBottom: '18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '14px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '30px', fontWeight: '600', lineHeight: 1, color: '#1C1C1E' }}>
                  {selectedOrder.event_name || 'Untitled event'}
                </div>
                <div style={{ marginTop: '7px', fontSize: '12px', color: '#6B6860' }}>Ref {selectedOrder.crms_ref || '—'}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
                <span style={{ flex: '1 1 200px', fontSize: '11px', color: '#6B6860', lineHeight: 1.45 }}>
                  Print settings: Margins None, Scale 100%, Headers and footers Off, Background graphics On.
                </span>
                <button onClick={resetAllToAutomatic} style={{ fontSize: '11px', padding: '7px 11px', borderRadius: '8px', border: '1px solid #DDD8CF', background: '#fff', color: '#6B6860', cursor: 'pointer' }}>
                  Reset all to automatic
                </button>
                <RmsJobRefreshPanel
                  job={selectedOrder}
                  disabled={!selectedOrder.crms_id}
                  onRefreshed={() => loadOrderData(selectedOrder.id)}
                />
                <button
                  onClick={handlePrint}
                  disabled={isPrinting || isExportingPdf}
                  style={{ fontSize: '11px', padding: '7px 11px', borderRadius: '8px', border: '1px solid #DDD8CF', background: isPrinting ? '#F7F3EE' : '#fff', color: '#6B6860', cursor: isPrinting || isExportingPdf ? 'not-allowed' : 'pointer' }}
                >
                  {isPrinting ? 'Preparing print...' : 'Print'}
                </button>
                <button
                  onClick={handleExportPdf}
                  disabled={isExportingPdf || isPrinting}
                  style={{ fontSize: '11px', padding: '7px 11px', borderRadius: '8px', border: '1px solid #DDD8CF', background: isExportingPdf ? '#F7F3EE' : '#fff', color: '#6B6860', cursor: isExportingPdf || isPrinting ? 'not-allowed' : 'pointer' }}
                >
                  {isExportingPdf ? 'Exporting PDF...' : 'Export PDF'}
                </button>
              </div>
            </div>
            <div style={{ marginTop: '16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '11px 20px', fontSize: '12px', color: '#6B6860', lineHeight: 1.45 }}>
              <div><strong style={{ color: '#1C1C1E' }}>Client:</strong> {selectedOrder.client_name || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>Event Date:</strong> {selectedOrder.delivery_date || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>Venue:</strong> {selectedOrder.venue || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>Venue Address:</strong> {selectedOrder.venue_address || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>Collection Date:</strong> {selectedOrder.collection_date || '—'}</div>
              <div><strong style={{ color: '#1C1C1E' }}>Order Colour:</strong> {orderColour.label}</div>
            </div>
            <div style={{ marginTop: '10px', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '20px', border: '1px solid #DDD8CF', background: '#fff', color: '#6B6860' }}>
                {postcodeDiagnostic.status}
              </span>
              <span style={{ fontSize: '12px', color: '#1C1C1E', fontWeight: '500' }}>Postcode: {postcodeDiagnostic.value || '—'}</span>
            </div>
            <div style={{ marginTop: '16px' }}>
              <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#B8965A', marginBottom: '8px' }}>Order colour</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {Object.values(LABEL_ORDER_COLOURS).map(c => (
                  <button
                    key={c.key}
                    onClick={() => setOrderColourKey(c.key)}
                    style={{ fontSize: '12px', padding: '6px 10px', borderRadius: '20px', border: `1px solid ${orderColourKey === c.key ? c.color : '#DDD8CF'}`, background: orderColourKey === c.key ? '#F7F3EE' : '#fff', color: orderColourKey === c.key ? c.color : '#6B6860', cursor: 'pointer', lineHeight: 1.2 }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {hasLinenStudioItems && (
            <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '14px', padding: '16px 18px', marginBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ minWidth: '260px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '700', color: '#92400E', marginBottom: '6px' }}>
                    Linen labels also need printing
                  </div>
                  <div style={{ fontSize: '12px', color: '#6B6860', lineHeight: 1.5 }}>
                    This order contains linen items managed in DB Linen Studio. Print those linen labels there before completing the full label workflow.
                  </div>
                  <div style={{ marginTop: '10px' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '4px 10px', borderRadius: '999px', background: '#FEF3C7', border: '1px solid #FDE68A', color: '#92400E' }}>
                      {processing.linenStudioItems.length} linen item type(s)
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
                  <button
                    onClick={openLinenLabelsForSelectedOrder}
                    disabled={!canOpenLinenStudio}
                    style={{
                      fontSize: '12px',
                      padding: '9px 12px',
                      borderRadius: '10px',
                      border: '1px solid #F59E0B',
                      background: canOpenLinenStudio ? '#F59E0B' : '#FDE68A',
                      color: canOpenLinenStudio ? '#111827' : '#92400E',
                      cursor: canOpenLinenStudio ? 'pointer' : 'not-allowed',
                      fontWeight: '700',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Open Linen Labels in DB Linen Studio
                  </button>
                  {!canOpenLinenStudio && (
                    <div style={{ fontSize: '11px', color: '#92400E', lineHeight: 1.35, maxWidth: '340px', textAlign: 'right' }}>
                      Configure <span style={{ fontFamily: 'monospace' }}>REACT_APP_LINEN_STUDIO_URL</span> to enable opening DB Linen Studio.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '16px', marginBottom: '18px', alignItems: 'stretch' }}>
            <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '14px', padding: '18px' }}>
              <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#B8965A', marginBottom: '10px' }}>Items summary</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', lineHeight: 1.4 }}>
                  <thead>
                    <tr style={{ background: '#F7F3EE', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '10px' }}>
                      <th style={{ textAlign: 'left', padding: '8px 10px' }}>Product</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px' }}>Category</th>
                      <th style={{ textAlign: 'center', padding: '8px 10px' }}>Total Qty</th>
                      <th style={{ textAlign: 'center', padding: '8px 10px' }}>Packaging</th>
                      <th style={{ textAlign: 'center', padding: '8px 10px' }}>Capacity</th>
                      <th style={{ textAlign: 'center', padding: '8px 10px' }}>Labels</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itemsSummaryRows.length === 0 ? (
                      <tr><td colSpan={6} style={{ padding: '12px 10px', color: '#9CA3AF' }}>No matched items yet.</td></tr>
                    ) : (
                      itemsSummaryRows.map(row => (
                        <tr key={row.itemKey} style={{ borderTop: '1px solid #F1EFE8', color: '#1C1C1E' }}>
                          <td style={{ padding: '9px 10px' }}>{row.productName}</td>
                          <td style={{ padding: '9px 10px', color: '#6B6860' }}>{row.category}</td>
                          <td style={{ padding: '9px 10px', textAlign: 'center' }}>{row.totalQty}</td>
                          <td style={{ padding: '9px 10px', textAlign: 'center' }}>{row.packagingType}</td>
                          <td style={{ padding: '9px 10px', textAlign: 'center' }}>{row.capacity}</td>
                          <td style={{ padding: '9px 10px', textAlign: 'center' }}>{row.labelsCount}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '14px', padding: '18px', display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#B8965A', marginBottom: '10px' }}>Output summary</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', flex: 1 }}>
                <div style={{ border: '1px solid #E6E0D6', borderRadius: '9px', padding: '12px', background: '#FFFEFC' }}><div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Eligible Items</div><div style={{ fontSize: '24px', color: '#1C1C1E', fontWeight: '600', marginTop: '6px', lineHeight: 1 }}>{outputSummary.eligibleItems}</div></div>
                <div style={{ border: '1px solid #E6E0D6', borderRadius: '9px', padding: '12px', background: '#FFFEFC' }}><div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Generated Labels</div><div style={{ fontSize: '24px', color: '#1C1C1E', fontWeight: '600', marginTop: '6px', lineHeight: 1 }}>{outputSummary.generatedLabels}</div></div>
                <div style={{ border: '1px solid #E6E0D6', borderRadius: '9px', padding: '12px', background: '#FFFEFC' }}><div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Auto Labels</div><div style={{ fontSize: '24px', color: '#1C1C1E', fontWeight: '600', marginTop: '6px', lineHeight: 1 }}>{outputSummary.autoLabels}</div></div>
                <div style={{ border: '1px solid #E6E0D6', borderRadius: '9px', padding: '12px', background: '#FFFEFC' }}><div style={{ fontSize: '10px', color: '#6B6860', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Needs Attention</div><div style={{ fontSize: '24px', color: outputSummary.needsAttention > 0 ? '#A32D2D' : '#1C1C1E', fontWeight: '600', marginTop: '6px', lineHeight: 1 }}>{outputSummary.needsAttention}</div></div>
              </div>
            </div>
          </div>

          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '14px', padding: '18px', marginBottom: '18px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#B8965A', marginBottom: '10px' }}>
              Generated labels editor
            </div>
            {jobItemsLoading || ataItemsLoading ? (
              <div style={{ fontSize: '13px', color: '#6B6860' }}>job items loading...</div>
            ) : processing.eligibleMatchedItems.length === 0 ? (
              <div style={{ fontSize: '13px', color: '#9CA3AF' }}>empty state: no matched items to generate labels.</div>
            ) : (
              <div style={{ display: 'grid', gap: '16px' }}>
                {processing.eligibleMatchedItems.map(item => {
                  const conf = confidenceStyle(item.confidence)
                  const manual = manualStateByItem[item.itemKey] || { labels: [], total: 0, valid: false }
                  return (
                    <div key={item.itemKey} style={{ border: '1px solid #E8E3D9', borderRadius: '11px', padding: '15px', background: '#FFFEFC' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' }}>
                        <div style={{ fontSize: '15px', fontWeight: '600', color: '#1C1C1E', lineHeight: 1.35 }}>{item.productName}</div>
                        <span style={{ fontSize: '10px', fontWeight: '600', padding: '3px 9px', borderRadius: '12px', background: conf.bg, color: conf.color }}>{item.confidence}</span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '12px', lineHeight: 1.5 }}>
                        total: {item.totalQty} · capacity: {item.capacity} · packaging: {(item.packagingType || 'unit').toUpperCase()} · category: {item.category || 'OTHER'}
                      </div>
                      {item.flags.length > 0 && (
                        <div style={{ marginBottom: '8px', display: 'grid', gap: '4px' }}>
                          {item.flags.map((flag, idx) => (
                            <div key={`${item.itemKey}-flag-${idx}`} style={{ fontSize: '11px', color: flag.level === 'error' ? '#A32D2D' : '#854F0B' }}>
                              {flag.level === 'error' ? 'Error:' : 'Warning:'} {flag.message}
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'grid', gap: '8px' }}>
                        {manualLabelsByItem[item.itemKey]?.map(label => (
                          <div key={label.id} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <input value={label.quantity} onChange={e => setItemManualQuantity(item.itemKey, label.id, e.target.value)} style={{ width: '96px', padding: '8px 9px', border: '1px solid #DDD8CF', borderRadius: '8px', fontSize: '12px', background: '#fff' }} />
                            <span style={{ fontSize: '11px', color: '#6B6860', lineHeight: 1.4 }}>{item.productName}</span>
                            <button onClick={() => removeManualLabelRow(item.itemKey, label.id)} style={{ marginLeft: 'auto', fontSize: '11px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #FECACA', background: '#FFF7F7', color: '#C24141', cursor: 'pointer' }}>
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
                        <button onClick={() => addManualLabelRow(item.itemKey)} style={{ fontSize: '11px', padding: '5px 9px', borderRadius: '6px', border: '1px solid #DDD8CF', background: '#fff', color: '#6B6860', cursor: 'pointer' }}>
                          Add label row
                        </button>
                        <button onClick={() => resetItemToAutomatic(item)} style={{ fontSize: '11px', padding: '5px 9px', borderRadius: '6px', border: '1px solid #DDD8CF', background: '#F7F3EE', color: '#6B6860', cursor: 'pointer' }}>
                          Reset item to automatic
                        </button>
                      </div>
                      <div style={{ marginTop: '10px', fontSize: '11px', color: manual.valid ? '#2F6A18' : '#A32D2D', fontWeight: '600', lineHeight: 1.4 }}>
                        {manual.valid ? `Valid split (${manual.total}/${item.totalQty})` : `Mismatch (${manual.total}/${item.totalQty})`}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div style={{ background: '#fff', border: '1px solid #DDD8CF', borderRadius: '14px', padding: '20px', marginBottom: '18px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#B8965A', marginBottom: '12px' }}>
              Labels preview
            </div>
            {previewLabels.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6B6860' }}>No preview labels generated yet.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
                {previewLabels.map(label => (
                  <div key={label.id} style={{ background: '#fff', border: '1px solid #D3CEC3', borderRadius: '10px', padding: '18px 16px', minHeight: '268px', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ textAlign: 'center', fontFamily: "'Cormorant Garamond', serif", fontWeight: '600', fontSize: '20px', color: '#1C1C1E', lineHeight: 1.05 }}>
                      Duchess & Butler
                    </div>
                    <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '11px', fontWeight: '700', letterSpacing: '0.08em', color: '#1C1C1E' }}>
                      {(selectedOrder.event_name || '').toUpperCase()}
                    </div>
                    <div style={{ textAlign: 'center', marginTop: '5px', fontSize: '11px', color: '#1C1C1E' }}>{selectedOrder.client_name || '—'}</div>
                    <div style={{ textAlign: 'center', marginTop: '4px', fontSize: '11px', color: '#1C1C1E' }}>{postcodeDiagnostic.value || '—'}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '14px', fontSize: '10px', color: '#1C1C1E', letterSpacing: '0.03em' }}>
                      <span>Ref: {selectedOrder.crms_ref || '—'}</span>
                      <span>{(label.packagingType || 'unit').toUpperCase()}</span>
                    </div>
                    <div style={{ marginTop: '12px', border: '1.5px solid #1C1C1E', borderRadius: '6px', padding: '16px 10px', textAlign: 'center', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: '15px', fontWeight: '700', color: orderColour.color, lineHeight: 1.35 }}>
                        {label.quantity}x {label.productName}
                      </span>
                    </div>
                    <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#1C1C1E', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                      <span>{label.category || 'OTHER'}</span>
                      <span>{(label.packagingType || 'unit').toUpperCase()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: '14px', fontSize: '11px', color: '#9CA3AF' }}>Printed output uses fixed sheets with six labels per page (same layout as exported PDF).</div>
          </div>

          <div style={{ background: '#FFFDF9', border: '1px solid #EEE7DD', borderRadius: '10px', padding: '12px 13px', marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '8px' }}>
              Out-of-scope items
            </div>
            {processing.outOfScopeItems.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6B6860' }}>No out-of-scope items.</div>
            ) : (
              <div style={{ display: 'grid', gap: '6px' }}>
                {processing.outOfScopeItems.map(item => (
                  <div key={item.itemKey} style={{ border: '1px solid #F2E7C8', background: '#FFFCF4', borderRadius: '8px', padding: '9px 10px' }}>
                    <div style={{ fontSize: '12px', color: '#1C1C1E', fontWeight: '600' }}>{item.item_name || '—'}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px', lineHeight: 1.4 }}>qty: {item.quantity ?? 0}</div>
                    <div style={{ fontSize: '11px', color: '#86653A', marginTop: '3px', lineHeight: 1.4 }}>{item.reason || 'No ATA rule found'} · Analysis check recommended.</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: '#FFFDF9', border: '1px solid #EEE7DD', borderRadius: '10px', padding: '12px 13px', marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '8px' }}>
              Linen items handled in DB Linen Studio
            </div>
            {processing.linenStudioItems.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6B6860' }}>No linen exclusions for this order.</div>
            ) : (
              <>
                {selectedOrder && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
                    <div style={{ fontSize: '11px', color: canOpenLinenStudio ? '#6B6860' : '#A16207', lineHeight: 1.4 }}>
                      {canOpenLinenStudio
                        ? 'Opens DB Linen Studio with this order pre-selected.'
                        : 'Configure REACT_APP_LINEN_STUDIO_URL to enable opening DB Linen Studio.'}
                    </div>
                    <button
                      onClick={openLinenLabelsForSelectedOrder}
                      disabled={!canOpenLinenStudio}
                      style={{
                        fontSize: '11px',
                        padding: '7px 11px',
                        borderRadius: '8px',
                        border: '1px solid #DDD8CF',
                        background: canOpenLinenStudio ? '#F7F3EE' : '#F7F3EE',
                        color: canOpenLinenStudio ? '#6B6860' : '#B39B61',
                        cursor: canOpenLinenStudio ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Open linen labels for this order
                    </button>
                  </div>
                )}
                <div style={{ display: 'grid', gap: '6px' }}>
                  {processing.linenStudioItems.map(item => (
                    <div key={item.itemKey} style={{ border: '1px solid #ECE5D9', background: '#FFFEFA', borderRadius: '8px', padding: '9px 10px' }}>
                      <div style={{ fontSize: '12px', color: '#1C1C1E', fontWeight: '600' }}>{item.item_name || '—'}</div>
                      <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px', lineHeight: 1.4 }}>qty: {item.quantity ?? 0}</div>
                      <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '3px', lineHeight: 1.4 }}>Handled in DB Linen Studio.</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={{ background: '#FFFDF9', border: '1px solid #EEE7DD', borderRadius: '10px', padding: '12px 13px', marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '8px' }}>
              Furniture and large hire items excluded from labels
            </div>
            {processing.furnitureExcludedItems.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6B6860' }}>No furniture or large-hire exclusions for this order.</div>
            ) : (
              <div style={{ display: 'grid', gap: '6px' }}>
                {processing.furnitureExcludedItems.map(item => (
                  <div key={item.itemKey} style={{ border: '1px solid #ECE5D9', background: '#FFFEFA', borderRadius: '8px', padding: '9px 10px' }}>
                    <div style={{ fontSize: '12px', color: '#1C1C1E', fontWeight: '600' }}>{item.item_name || '—'}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px', lineHeight: 1.4 }}>qty: {item.quantity ?? 0}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '3px', lineHeight: 1.4 }}>Excluded: furniture and large-hire items do not require operational labels.</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: '#FFFDF9', border: '1px solid #EEE7DD', borderRadius: '10px', padding: '12px 13px', marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '8px' }}>
              Service and fee lines excluded from labels
            </div>
            <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '8px', lineHeight: 1.4 }}>
              These non-physical order lines do not require operational labels.
            </div>
            {processing.serviceExcludedItems.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6B6860' }}>No service or fee exclusions for this order.</div>
            ) : (
              <div style={{ display: 'grid', gap: '6px' }}>
                {processing.serviceExcludedItems.map(item => (
                  <div key={item.itemKey} style={{ border: '1px solid #ECE5D9', background: '#FFFEFA', borderRadius: '8px', padding: '9px 10px' }}>
                    <div style={{ fontSize: '12px', color: '#1C1C1E', fontWeight: '600' }}>{item.item_name || '—'}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px', lineHeight: 1.4 }}>qty: {item.quantity ?? 0}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: '#FFFDF9', border: '1px solid #EEE7DD', borderRadius: '10px', padding: '12px 13px', marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', marginBottom: '8px' }}>
              Display and prop items excluded from labels
            </div>
            <div style={{ fontSize: '11px', color: '#6B6860', marginBottom: '8px', lineHeight: 1.4 }}>
              These display items do not require operational labels.
            </div>
            {processing.displayPropExcludedItems.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6B6860' }}>No display or prop exclusions for this order.</div>
            ) : (
              <div style={{ display: 'grid', gap: '6px' }}>
                {processing.displayPropExcludedItems.map(item => (
                  <div key={item.itemKey} style={{ border: '1px solid #ECE5D9', background: '#FFFEFA', borderRadius: '8px', padding: '9px 10px' }}>
                    <div style={{ fontSize: '12px', color: '#1C1C1E', fontWeight: '600' }}>{item.item_name || '—'}</div>
                    <div style={{ fontSize: '11px', color: '#6B6860', marginTop: '2px', lineHeight: 1.4 }}>qty: {item.quantity ?? 0}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <details style={{ background: '#FFFDF9', border: '1px solid #EEE7DD', borderRadius: '10px', padding: '11px 12px', marginBottom: '8px' }}>
            <summary style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#B8965A', cursor: 'pointer' }}>
              Ignored rows
            </summary>
            <div style={{ marginTop: '10px', display: 'grid', gap: '6px' }}>
              {processing.ignoredItems.length === 0 ? (
                <div style={{ fontSize: '12px', color: '#6B6860' }}>No ignored rows.</div>
              ) : (
                processing.ignoredItems.map((item, idx) => (
                  <div key={`${item.id || idx}`} style={{ fontSize: '12px', color: '#9CA3AF' }}>
                    {item.item_name || '—'} · qty: {item.quantity ?? 0}
                  </div>
                ))
              )}
            </div>
          </details>
        </>
      )}
    </div>
  )
}

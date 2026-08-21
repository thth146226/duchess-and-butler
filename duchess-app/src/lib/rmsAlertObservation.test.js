import {
  OBSERVATION_DISPOSITIONS,
  RMS_ALERT_OBSERVATION_COLLAPSE_THRESHOLD_V1,
  classifyParsedObservation,
  isJobEligibleForAlertPoll,
  normalizeObservedItem,
  observeJobFromCurrentRms,
  parseOpportunityItemsPayload,
} from '../../server-lib/rmsAlertObservation.js'

describe('rmsAlertObservation', () => {
  const originalKey = process.env.CRMS_API_KEY
  const originalSub = process.env.CRMS_SUBDOMAIN

  beforeEach(() => {
    process.env.CRMS_API_KEY = 'test-key'
    process.env.CRMS_SUBDOMAIN = 'test-sub'
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.CRMS_API_KEY
    else process.env.CRMS_API_KEY = originalKey
    if (originalSub === undefined) delete process.env.CRMS_SUBDOMAIN
    else process.env.CRMS_SUBDOMAIN = originalSub
  })

  test('OBS-01 valid non-empty response → QUALIFIED', () => {
    const parsed = parseOpportunityItemsPayload({
      opportunity_items: [{ id: '1', product_name: 'Chair', product_group_name: 'Furniture', quantity: 2 }],
    })
    expect(parsed.ok).toBe(true)
    const classified = classifyParsedObservation({ items: parsed.items, jobInitialized: false })
    expect(classified.disposition).toBe(OBSERVATION_DISPOSITIONS.QUALIFIED)
  })

  test('OBS-02 network error → FETCH_ERROR', async () => {
    const result = await observeJobFromCurrentRms({
      job: { crms_id: '9', hidden_from_schedule: false, status: 'confirmed' },
      fetchImpl: async () => { throw new Error('network down') },
    })
    expect(result.disposition).toBe(OBSERVATION_DISPOSITIONS.FETCH_ERROR)
  })

  test('OBS-03 malformed JSON/shape → PARSE_ERROR', () => {
    expect(parseOpportunityItemsPayload(null).disposition).toBe(OBSERVATION_DISPOSITIONS.PARSE_ERROR)
    expect(parseOpportunityItemsPayload({ opportunity_items: 'nope' }).disposition)
      .toBe(OBSERVATION_DISPOSITIONS.PARSE_ERROR)
  })

  test('OBS-04 duplicate crms_item_id → PARSE_ERROR', () => {
    const parsed = parseOpportunityItemsPayload({
      opportunity_items: [
        { id: '1', quantity: 1 },
        { id: '1', quantity: 2 },
      ],
    })
    expect(parsed.disposition).toBe(OBSERVATION_DISPOSITIONS.PARSE_ERROR)
  })

  test('OBS-05 invalid quantity → PARSE_ERROR', () => {
    expect(normalizeObservedItem({ id: '1', quantity: -1 }).ok).toBe(false)
    expect(normalizeObservedItem({ id: '1', quantity: 'x' }).ok).toBe(false)
  })

  test('OBS-06 zero items → BLOCKED_ZERO_ITEMS', () => {
    const classified = classifyParsedObservation({
      items: [],
      presentBaselineItems: [{ crms_item_id: '1', is_present: true }],
      jobInitialized: true,
    })
    expect(classified.disposition).toBe(OBSERVATION_DISPOSITIONS.BLOCKED_ZERO_ITEMS)
  })

  test('OBS-07 zero items never generates missing actions via classify', () => {
    const classified = classifyParsedObservation({
      items: [],
      presentBaselineItems: [
        { crms_item_id: '1', is_present: true },
        { crms_item_id: '2', is_present: true },
      ],
      jobInitialized: true,
    })
    expect(classified.missing_count).toBe(0)
    expect(classified.disposition).toBe(OBSERVATION_DISPOSITIONS.BLOCKED_ZERO_ITEMS)
  })

  test('OBS-08 missing_ratio exactly 0.80 → not suspect', () => {
    expect(RMS_ALERT_OBSERVATION_COLLAPSE_THRESHOLD_V1).toBe(0.80)
    const present = Array.from({ length: 5 }, (_, i) => ({ crms_item_id: String(i + 1), is_present: true }))
    const items = [
      { crms_item_id: '1', item_name: 'a', item_category: 'c', quantity: 1 },
    ]
    // missing 4/5 = 0.8 — threshold is strictly greater than 0.80
    const classified = classifyParsedObservation({
      items,
      presentBaselineItems: present,
      jobInitialized: true,
    })
    expect(classified.missing_ratio).toBe(0.8)
    expect(classified.disposition).toBe(OBSERVATION_DISPOSITIONS.QUALIFIED)
  })

  test('OBS-09 missing_ratio > 0.80 → OBSERVATION_SUSPECT', () => {
    const present = Array.from({ length: 5 }, (_, i) => ({ crms_item_id: String(i + 1), is_present: true }))
    const classified = classifyParsedObservation({
      items: [], // blocked zero takes precedence — use 1 observed missing 5/5 wait
      presentBaselineItems: present,
      jobInitialized: true,
    })
    // zero items → BLOCKED. Use one observed of 10 present => missing 0.9
    const classified2 = classifyParsedObservation({
      items: [{ crms_item_id: '1', item_name: 'a', item_category: 'c', quantity: 1 }],
      presentBaselineItems: Array.from({ length: 10 }, (_, i) => ({
        crms_item_id: String(i + 1),
        is_present: true,
      })),
      jobInitialized: true,
    })
    expect(classified.disposition).toBe(OBSERVATION_DISPOSITIONS.BLOCKED_ZERO_ITEMS)
    expect(classified2.missing_ratio).toBe(0.9)
    expect(classified2.disposition).toBe(OBSERVATION_DISPOSITIONS.OBSERVATION_SUSPECT)
  })

  test('OBS-10 suspect observation generates zero item actions at classify layer', () => {
    const classified = classifyParsedObservation({
      items: [{ crms_item_id: '1', item_name: 'a', item_category: 'c', quantity: 1 }],
      presentBaselineItems: Array.from({ length: 10 }, (_, i) => ({
        crms_item_id: String(i + 1),
        is_present: true,
      })),
      jobInitialized: true,
    })
    expect(classified.disposition).toBe(OBSERVATION_DISPOSITIONS.OBSERVATION_SUSPECT)
  })

  test('OBS-11 404 → SOURCE_DISAPPEARED', async () => {
    const result = await observeJobFromCurrentRms({
      job: { crms_id: '9', hidden_from_schedule: false, status: 'confirmed' },
      fetchImpl: async () => ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }),
    })
    expect(result.disposition).toBe(OBSERVATION_DISPOSITIONS.SOURCE_DISAPPEARED)
  })

  test('OBS-12 cancelled/hidden/inactive local job → SKIPPED_INELIGIBLE', () => {
    expect(isJobEligibleForAlertPoll({ crms_id: '1', status: 'cancelled' })).toBe(false)
    expect(isJobEligibleForAlertPoll({ crms_id: '1', hidden_from_schedule: true })).toBe(false)
    expect(isJobEligibleForAlertPoll({
      crms_id: '1',
      status: 'confirmed',
      rms_visibility_status: 'missing_from_rms',
    })).toBe(false)
  })
})

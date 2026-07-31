/**
 * Tests for Current RMS Full Sync relation hydration (api/sync.js).
 * Second file required: Jest lives under src/; sync.js alone cannot host CRA tests.
 */
import fs from 'fs'
import path from 'path'
import {
  buildCrmsUrl,
  extractVenueAddress,
  extractVenueName,
  mapOpportunity,
  mergeProtectedRelationFields,
} from '../../api/sync.js'

describe('sync relation hydration', () => {
  test('CASE 1 — confirmed include[] shape maps client, venue, address', () => {
    const mapped = mapOpportunity({
      id: 7962,
      number: 'QDB07887',
      name: 'Caper & Berry Cliveden Event Saturday 1st August 2026',
      state: 3,
      state_name: 'Order',
      member_id: 106,
      venue_id: 500,
      billing_address_id: 107,
      member: { id: 106, name: 'Caper & Berry' },
      venue: { id: 500, name: 'Cliveden House Hotel' },
      destination: {
        address: {
          street: 'Bourne End Road',
          city: 'Taplow',
          county: 'Berkshire',
          postcode: 'SL6 0JF',
          country_name: 'United Kingdom',
        },
      },
    })

    expect(mapped.client_name).toBe('Caper & Berry')
    expect(mapped.venue).toBe('Cliveden House Hotel')
    expect(mapped.venue_address).toBe(
      'Bourne End Road, Taplow, Berkshire, SL6 0JF, United Kingdom',
    )
  })

  test('CASE 2 — historical destination root address shape', () => {
    const address = extractVenueAddress({
      destination: {
        street: 'Bourne End Road',
        city: 'Taplow',
        county: 'Berkshire',
        postcode: 'SL6 0JF',
        country_name: 'United Kingdom',
      },
    })
    expect(address).toBe(
      'Bourne End Road, Taplow, Berkshire, SL6 0JF, United Kingdom',
    )
  })

  test('CASE 3 — partial blank mapping preserves existing non-empty relation fields', () => {
    const existing = {
      client_name: 'Caper & Berry',
      venue: 'Cliveden House Hotel',
      venue_address: 'Bourne End Road, Taplow, Berkshire, SL6 0JF, United Kingdom',
    }
    const mapped = {
      client_name: '',
      venue: '',
      venue_address: null,
      status: 'confirmed',
    }
    const merged = mergeProtectedRelationFields(existing, mapped)
    expect(merged.client_name).toBe('Caper & Berry')
    expect(merged.venue).toBe('Cliveden House Hotel')
    expect(merged.venue_address).toBe(
      'Bourne End Road, Taplow, Berkshire, SL6 0JF, United Kingdom',
    )
  })

  test('CASE 4 — legitimate resolved venue change is written', () => {
    const existing = { client_name: 'Acme', venue: 'Old Venue', venue_address: 'Old Rd' }
    const mapped = { client_name: 'Acme', venue: 'New Venue', venue_address: 'Old Rd' }
    const merged = mergeProtectedRelationFields(existing, mapped)
    expect(merged.venue).toBe('New Venue')
  })

  test('CASE 5 — no venue invented from billing_address_id', () => {
    const o = {
      id: 1,
      number: 'QDB07866',
      name: 'Some Event',
      state: 3,
      state_name: 'Order',
      member_id: 106,
      venue_id: null,
      billing_address_id: 107,
      member: { name: 'Caper & Berry' },
    }
    expect(extractVenueName(o)).toBe('')
    expect(extractVenueAddress(o)).toBeNull()
    const mapped = mapOpportunity(o)
    expect(mapped.venue).toBe('')
    expect(mapped.venue_address).toBeNull()
  })

  test('CASE 6 — query serialization repeats include[] keys', () => {
    const url = buildCrmsUrl('/opportunities', {
      'include[]': ['member', 'venue', 'destination'],
      per_page: 1,
    })
    const raw = url.toString()
    const matches = raw.match(/include%5B%5D=/g) || raw.match(/include\[\]=/g) || []
    expect(matches.length).toBe(3)
    expect(raw).toContain('member')
    expect(raw).toContain('venue')
    expect(raw).toContain('destination')
    expect(raw).not.toMatch(/include%5B%5D=member%2Cvenue%2Cdestination/)
    expect(raw).not.toMatch(/include\[\]=member,venue,destination/)
  })

  test('CASE 7 — full sync file does not create operational_change_events', () => {
    const syncPath = path.resolve(__dirname, '../../api/sync.js')
    const source = fs.readFileSync(syncPath, 'utf8')
    expect(source).not.toMatch(/operational_change_events/)
    expect(source).not.toMatch(/createOperationalItemChangeEvents/)
  })

  test('venue.name takes precedence over destination names', () => {
    expect(
      extractVenueName({
        venue: { name: 'Cliveden House Hotel' },
        destination: { name: 'Other', address: { name: 'Nested' } },
        venue_name: 'Flat',
      }),
    ).toBe('Cliveden House Hotel')
  })

  test('whitespace street falls back to address1', () => {
    expect(
      extractVenueAddress({
        destination: {
          address: {
            street: '   ',
            address1: 'Bourne End Road',
            city: 'Taplow',
            postcode: 'SL6 0JF',
          },
        },
      }),
    ).toBe('Bourne End Road, Taplow, SL6 0JF')
  })

  test('whitespace city falls back to town', () => {
    expect(
      extractVenueAddress({
        destination: {
          address: {
            street: 'Bourne End Road',
            city: '   ',
            town: 'Taplow',
            postcode: 'SL6 0JF',
          },
        },
      }),
    ).toBe('Bourne End Road, Taplow, SL6 0JF')
  })

  test('whitespace city and town fall back to town_city', () => {
    expect(
      extractVenueAddress({
        destination: {
          address: {
            street: 'Bourne End Road',
            city: '  ',
            town: '\t',
            town_city: 'Taplow',
            postcode: 'SL6 0JF',
          },
        },
      }),
    ).toBe('Bourne End Road, Taplow, SL6 0JF')
  })

  test('whitespace country_name falls back to country', () => {
    expect(
      extractVenueAddress({
        destination: {
          address: {
            street: 'Bourne End Road',
            city: 'Taplow',
            country_name: '   ',
            country: 'United Kingdom',
          },
        },
      }),
    ).toBe('Bourne End Road, Taplow, United Kingdom')
  })

  test('whitespace nested object name falls back to country_name', () => {
    expect(
      extractVenueAddress({
        destination: {
          address: {
            street: 'Bourne End Road',
            city: 'Taplow',
            country: { name: '   ', country_name: 'United Kingdom' },
          },
        },
      }),
    ).toBe('Bourne End Road, Taplow, United Kingdom')
  })

  test('non-consecutive duplicate address parts are removed preserving order', () => {
    expect(
      extractVenueAddress({
        destination: {
          address: {
            street: 'Taplow',
            address2: 'Berkshire',
            city: 'Taplow',
            county: 'Berkshire',
            postcode: 'SL6 0JF',
          },
        },
      }),
    ).toBe('Taplow, Berkshire, SL6 0JF')
  })
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AuditLog, { detailText, typeLabel, type AuditEvent } from './AuditLog'

// Phones get a card list; the tests read the table, so a wide screen is stubbed.
function stubWidth() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function event(over: Partial<AuditEvent>): AuditEvent {
  return {
    id: '1',
    type: 'auth.login_succeeded',
    actorId: 'a1b2c3d4-0000-4000-8000-000000000000',
    actorName: 'Amina Mushi',
    targetId: null,
    targetName: null,
    ip: '203.0.113.7',
    meta: {},
    createdAt: '2026-10-15T08:00:00.000Z',
    ...over,
  }
}

const price = event({
  id: '2',
  type: 'product.price_changed',
  targetId: 'b1b2c3d4-0000-4000-8000-000000000000',
  meta: { sku: 'PSP-PM-001', field: 'priceTzs', from: 1000000, to: 1200000 },
})
const failed = event({ id: '3', type: 'auth.login_failed', actorId: null, actorName: null, meta: { email: 'x@psp.test' } })

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

function pageOf(events: AuditEvent[], over: Record<string, unknown> = {}) {
  return json(200, { success: true, data: { events, total: events.length, page: 1, pageSize: 25, ...over } })
}

describe('AuditLog', () => {
  it('lists events with who, what and the details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pageOf([price, failed])))
    stubWidth()
    render(<AuditLog />)

    expect(await screen.findAllByText('Price changed')).not.toHaveLength(0)
    expect(screen.getAllByText('Price: TZS 1,000,000 to TZS 1,200,000 · SKU PSP-PM-001').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Failed sign-in').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Not signed in').length).toBeGreaterThan(0)
    expect(screen.getByText('Showing 2 of 2 events')).toBeTruthy()
  })

  it('asks for one category when its tab is chosen', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pageOf([price]))
    vi.stubGlobal('fetch', fetchMock)
    stubWidth()
    render(<AuditLog />)
    await screen.findAllByText('Price changed')

    fireEvent.click(screen.getByRole('button', { name: 'Products' }))
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('category=product'))
  })

  it('shows an empty state and a readable error with a retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(403, { success: false, error: { message: 'You do not have permission.' } }))
      .mockResolvedValueOnce(pageOf([]))
    vi.stubGlobal('fetch', fetchMock)
    stubWidth()
    render(<AuditLog />)

    expect((await screen.findByRole('alert')).textContent).toContain('You do not have permission.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/No events yet/)).toBeTruthy()
  })
})

describe('event text', () => {
  it('names known types and reads unknown ones sensibly', () => {
    expect(typeLabel('staff.role_changed')).toBe('Staff role changed')
    expect(typeLabel('stock.adjusted')).toBe('Stock adjusted')
  })

  it('summarises the details without raw JSON', () => {
    expect(detailText(event({ type: 'staff.role_changed', meta: { from: 'staff', to: 'IT' } }))).toBe('staff to IT')
    expect(detailText(event({ type: 'customer.updated', meta: { fields: ['fullName', 'phone'] } }))).toBe(
      'Changed: fullName, phone',
    )
    expect(detailText(event({ type: 'order.status_changed', meta: { status: 'confirmed', orderNumber: 'PSP-000124' } }))).toBe(
      'Order PSP-000124 · Now confirmed',
    )
  })
})

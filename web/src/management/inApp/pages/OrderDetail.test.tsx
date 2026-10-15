import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORDERS_CHANGED } from '../layout/Sidebar'
import OrderDetail, { type OrderDetailRecord } from './OrderDetail'

// Which buttons show for which permission is covered by the permissions tests; here
// the person holds everything.
vi.mock('../../auth/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/AuthProvider')>()),
  usePermission: () => true,
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const newOrder: OrderDetailRecord = {
  id: 'o1',
  orderNumber: 'PSP-000123',
  status: 'new',
  paymentStatus: 'unpaid',
  source: 'shop',
  customer: null,
  createdBy: null,
  guestName: 'Asha Mushi',
  guestPhone: '+255712345678',
  guestEmail: 'asha@example.com',
  deliveryArea: 'Kariakoo, Dar es Salaam',
  deliveryAddress: 'Msimbazi Street, near the market',
  notes: 'Call before delivery.',
  totalTzs: 1000000,
  hasQuotationLines: true,
  cancelReason: null,
  createdAt: '2026-10-14T08:30:00.000Z',
  updatedAt: '2026-10-14T08:30:00.000Z',
  confirmedAt: null,
  deliveredAt: null,
  closedAt: null,
  cancelledAt: null,
  paidAt: null,
  nextStatuses: ['confirmed', 'cancelled'],
  itemsEditable: true,
  items: [
    {
      id: 'i1',
      productId: 'p1',
      productName: 'Patient monitor',
      productSku: 'PM-12',
      unitPriceTzs: 500000,
      quantity: 2,
      lineTotalTzs: 1000000,
    },
    { id: 'i2', productId: 'p2', productName: 'CT scanner', productSku: 'CT-64', unitPriceTzs: null, quantity: 1, lineTotalTzs: null },
  ],
}

const AT = '2026-10-14T10:00:00.000Z'

function inStatus(status: OrderDetailRecord['status'], patch: Partial<OrderDetailRecord> = {}): OrderDetailRecord {
  const next: Record<string, OrderDetailRecord['nextStatuses']> = {
    new: ['confirmed', 'cancelled'],
    confirmed: ['delivered', 'cancelled'],
    delivered: ['closed'],
    closed: [],
    cancelled: [],
  }
  return {
    ...newOrder,
    status,
    nextStatuses: next[status],
    itemsEditable: status === 'new',
    confirmedAt: ['confirmed', 'delivered', 'closed'].includes(status) ? AT : null,
    deliveredAt: ['delivered', 'closed'].includes(status) ? AT : null,
    closedAt: status === 'closed' ? AT : null,
    ...patch,
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

const ok = (order: OrderDetailRecord) => json(200, { success: true, data: { order } })

type Call = { method: string; path: string; body: unknown }
type Lookup = { path: string; params: Record<string, string> }

// The customer directory, as the link card asks it (M7.5): customers with the order's
// phone or email, and a search.
type Directory = { matches?: unknown[]; search?: unknown[]; lookups?: Lookup[] }

// Answers every order API call with `handler`; returns the calls made. Customer
// lookups are answered from `directory` and recorded there, not in the calls.
function stubApi(handler: (call: Call) => Response, directory: Directory = {}) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url, 'http://localhost')
      if (parsed.pathname.startsWith('/api/office/customers')) {
        directory.lookups?.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) })
        return parsed.pathname.endsWith('/duplicates')
          ? json(200, { success: true, data: { matches: directory.matches ?? [] } })
          : json(200, { success: true, data: { customers: directory.search ?? [] } })
      }
      const call = {
        method: init?.method ?? 'GET',
        path: parsed.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(call)
      return handler(call)
    }),
  )
  return calls
}

function renderAt(path = '/office/orders/o1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/office/orders/:id" element={<OrderDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

const confirmGroup = () => screen.getByRole('group', { name: /\?$/ })

describe('OrderDetail', () => {
  it('shows the items, totals, guest details and the actions of a new order', async () => {
    const calls = stubApi(() => ok(newOrder))
    renderAt()

    expect(screen.getByLabelText('Loading order')).not.toBeNull()
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('PSP-000123')
    expect(calls.map((c) => c.path)).toEqual(['/api/office/orders/o1'])

    const table = screen.getByRole('table')
    expect(within(table).getByText('Patient monitor')).not.toBeNull()
    expect(within(table).getByText('PM-12')).not.toBeNull()
    expect(within(table).getAllByText('TZS 1,000,000')).toHaveLength(2) // line and order total
    expect(within(table).getByText('+ 1 item on request')).not.toBeNull()
    expect(screen.getByText('Quantities can change until the order is confirmed.')).not.toBeNull()

    expect(screen.getByRole('link', { name: '+255 712 345 678' }).getAttribute('href')).toBe('tel:+255712345678')
    expect(screen.getByRole('link', { name: 'asha@example.com' }).getAttribute('href')).toBe('mailto:asha@example.com')
    expect(within(screen.getByRole('region', { name: 'Customer record' })).getByText('Not linked.')).not.toBeNull()
    expect(screen.getByText('Call before delivery.')).not.toBeNull()
    expect(screen.getAllByText('Not yet')).toHaveLength(3)

    for (const name of ['Confirm order', 'Mark paid', 'Cancel order', 'Edit items']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).not.toBeNull()
    }
  })

  it('confirms after asking, then offers delivery and locks the items', async () => {
    const calls = stubApi((call) => (call.method === 'POST' ? ok(inStatus('confirmed')) : ok(newOrder)))
    const badgeRefresh = vi.fn()
    window.addEventListener(ORDERS_CHANGED, badgeRefresh)
    renderAt()

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm order' }))
    const group = confirmGroup()
    expect(within(group).getByText('Confirm order PSP-000123?')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('Not now')
    fireEvent.click(within(group).getByRole('button', { name: 'Confirm order' }))

    expect((await screen.findByRole('status')).textContent).toContain('Order confirmed.')
    expect(calls[1]).toEqual({ method: 'POST', path: '/api/office/orders/o1/status', body: { status: 'confirmed' } })
    expect(badgeRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Mark delivered' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Edit items/ })).toBeNull()
    expect(screen.getByText('Items and prices are fixed since the order was confirmed.')).not.toBeNull()
    window.removeEventListener(ORDERS_CHANGED, badgeRefresh)
  })

  it('"Not now" closes the question without a request', async () => {
    const calls = stubApi(() => ok(newOrder))
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: 'Mark paid' }))
    fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Not now' }))

    expect(screen.queryByRole('group', { name: /\?$/ })).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('marks delivered, then closes; a closed order offers no more moves', async () => {
    let current = inStatus('confirmed', { paymentStatus: 'paid', paidAt: AT })
    const calls = stubApi((call) => {
      if (call.method === 'POST') current = inStatus((call.body as { status: 'delivered' | 'closed' }).status, { paymentStatus: 'paid', paidAt: AT })
      return ok(current)
    })
    renderAt()

    fireEvent.click(await screen.findByRole('button', { name: 'Mark delivered' }))
    fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Mark delivered' }))
    expect((await screen.findByRole('status')).textContent).toContain('Marked as delivered.')

    fireEvent.click(screen.getByRole('button', { name: 'Close order' }))
    fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Close order' }))
    expect((await screen.findByRole('status')).textContent).toContain('Order closed.')

    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { status: 'delivered' },
      { status: 'closed' },
    ])
    for (const name of ['Mark delivered', 'Close order', 'Cancel order', 'Mark paid']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryAllByText('Not yet')).toHaveLength(0)
  })

  it('cancelling needs a reason; the reason is shown afterwards', async () => {
    const cancelled = inStatus('cancelled', { cancelReason: 'Ordered twice', cancelledAt: AT })
    const calls = stubApi((call) => (call.method === 'POST' ? ok(cancelled) : ok(newOrder)))
    renderAt()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel order' }))
    const reason = screen.getByLabelText('Reason for cancelling')
    expect(document.activeElement).toBe(reason)
    fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Cancel order' }))

    expect(screen.getByRole('alert').textContent).toBe('Enter the reason for cancelling.')
    expect(reason.getAttribute('aria-invalid')).toBe('true')
    expect(reason.getAttribute('aria-describedby')).toContain('order-cancel-reason-error')
    expect(calls).toHaveLength(1)

    fireEvent.change(reason, { target: { value: '  Ordered twice ' } })
    fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Cancel order' }))

    expect((await screen.findByRole('status')).textContent).toContain('Order cancelled.')
    expect(calls[1].body).toEqual({ status: 'cancelled', reason: 'Ordered twice' })
    expect(screen.getByText('Reason: Ordered twice')).not.toBeNull()
    expect(screen.getByText('Kept as they were when the order was cancelled.')).not.toBeNull()
    // A cancelled order can be neither moved nor paid.
    for (const name of ['Confirm order', 'Cancel order', 'Mark paid']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('marks the order paid', async () => {
    const calls = stubApi((call) =>
      call.method === 'POST' ? ok({ ...newOrder, paymentStatus: 'paid', paidAt: AT }) : ok(newOrder),
    )
    renderAt()

    fireEvent.click(await screen.findByRole('button', { name: 'Mark paid' }))
    fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Mark paid' }))

    expect((await screen.findByRole('status')).textContent).toContain('Marked as paid.')
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/office/orders/o1/paid' })
    expect(screen.queryByRole('button', { name: 'Mark paid' })).toBeNull()
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0)
  })

  it('a refused move shows the reason and reloads the order as it is now', async () => {
    let gets = 0
    const calls = stubApi((call) => {
      if (call.method === 'POST') {
        return json(409, {
          success: false,
          error: { message: 'This order is confirmed, so it cannot be moved to confirmed.', code: 'INVALID_TRANSITION' },
        })
      }
      gets += 1
      return ok(gets === 1 ? newOrder : inStatus('confirmed'))
    })
    renderAt()

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm order' }))
    fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Confirm order' }))

    expect(await screen.findByText('This order is confirmed, so it cannot be moved to confirmed.')).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'Mark delivered' })).not.toBeNull()
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET'])
  })

  it('a new order: change quantities and drop a line, then save', async () => {
    const saved: OrderDetailRecord = {
      ...newOrder,
      totalTzs: 1500000,
      hasQuotationLines: false,
      items: [{ ...newOrder.items[0], quantity: 3, lineTotalTzs: 1500000 }],
    }
    const calls = stubApi((call) => (call.method === 'PUT' ? ok(saved) : ok(newOrder)))
    renderAt()

    fireEvent.click(await screen.findByRole('button', { name: /Edit items/ }))
    const save = screen.getByRole('button', { name: 'Save items' }) as HTMLButtonElement
    expect(save.disabled).toBe(true) // nothing changed yet
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'More Patient monitor' }))
    expect(screen.getByText('TZS 1,500,000', { selector: '.office-order-grand-total' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove CT scanner' }))
    expect((screen.getByRole('button', { name: 'Remove Patient monitor' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/An order keeps at least one line/)).not.toBeNull()

    fireEvent.click(save)
    expect((await screen.findByRole('status')).textContent).toContain('Items saved.')
    expect(calls[1]).toEqual({ method: 'PUT', path: '/api/office/orders/o1/items', body: { items: [{ id: 'i1', quantity: 3 }] } })
    expect(screen.queryByRole('button', { name: 'Save items' })).toBeNull()
    expect(screen.queryByText('CT scanner')).toBeNull()
  })

  it('items confirmed by someone else meanwhile: the save is refused and the items lock', async () => {
    let gets = 0
    stubApi((call) => {
      if (call.method === 'PUT') {
        return json(409, {
          success: false,
          error: { message: 'This order is confirmed. Its items can no longer change.', code: 'ITEMS_LOCKED' },
        })
      }
      gets += 1
      return ok(gets === 1 ? newOrder : inStatus('confirmed'))
    })
    renderAt()

    fireEvent.click(await screen.findByRole('button', { name: /Edit items/ }))
    fireEvent.click(screen.getByRole('button', { name: 'More Patient monitor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save items' }))

    expect(await screen.findByText('This order is confirmed. Its items can no longer change.')).not.toBeNull()
    expect(await screen.findByText('Items and prices are fixed since the order was confirmed.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Edit items/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More Patient monitor' })).toBeNull()
  })

  it('a staff order linked to a customer names both', async () => {
    stubApi(() =>
      ok({
        ...inStatus('delivered'),
        source: 'staff',
        customer: { id: 'c1', type: 'company', name: 'Bugando Medical Centre' },
        createdBy: { id: 's1', fullName: 'Sam Staff' },
        guestEmail: null,
        notes: '',
      }),
    )
    renderAt()

    expect((await screen.findByRole('link', { name: 'Bugando Medical Centre' })).getAttribute('href')).toBe(
      '/office/customers/c1',
    )
    expect(screen.getByText('Sam Staff')).not.toBeNull()
    expect(screen.getByText('Not given')).not.toBeNull()
    expect(screen.getByText('No notes on this order.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Close order' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull()
    // Staff orders are not linked from here.
    expect(screen.queryByRole('region', { name: 'Customer record' })).toBeNull()
  })

  describe('linking to a customer (M7.5)', () => {
    const asha = {
      id: 'c1',
      type: 'individual',
      fullName: 'Asha Mushi',
      companyName: null,
      tin: null,
      contactPerson: null,
      phone: '+255712345678',
      email: 'asha@example.com',
      createdAt: AT,
      updatedAt: AT,
    }
    const bugando = {
      ...asha,
      id: 'c2',
      type: 'company',
      fullName: null,
      companyName: 'Bugando Medical Centre',
      phone: '+255282500000',
      email: null,
    }
    const linkedTo = (customer: OrderDetailRecord['customer']) => ({ ...newOrder, customer })
    const card = () => screen.getByRole('region', { name: 'Customer record' })

    it("suggests customers with the order's phone or email and links one", async () => {
      const lookups: Lookup[] = []
      const calls = stubApi(
        (call) => (call.method === 'PUT' ? ok(linkedTo({ id: 'c1', type: 'individual', name: 'Asha Mushi' })) : ok(newOrder)),
        { matches: [{ ...asha, matchedOn: ['phone', 'email'] }], lookups },
      )
      renderAt()

      const matches = await within(await screen.findByRole('region', { name: 'Customer record' })).findByRole('list', {
        name: 'Matching customers',
      })
      expect(lookups[0]).toEqual({
        path: '/api/office/customers/duplicates',
        params: { phone: '+255712345678', email: 'asha@example.com' },
      })
      expect(within(matches).getByText('Same phone and email')).not.toBeNull()
      expect(within(matches).getByText('+255 712 345 678 · asha@example.com')).not.toBeNull()
      expect(within(matches).getByRole('link', { name: 'Asha Mushi' }).getAttribute('href')).toBe('/office/customers/c1')

      fireEvent.click(within(matches).getByRole('button', { name: 'Link to Asha Mushi' }))
      expect((await screen.findByRole('status')).textContent).toContain('Linked to Asha Mushi.')
      expect(calls[1]).toEqual({ method: 'PUT', path: '/api/office/orders/o1/customer', body: { customerId: 'c1' } })
      expect(within(card()).getByText("This order is listed on the customer's page.")).not.toBeNull()
      expect(within(card()).getByRole('button', { name: 'Unlink' })).not.toBeNull()
      expect(document.activeElement?.textContent).toBe('Customer record')
    })

    it('with no match, finds a customer by search and links them', async () => {
      const lookups: Lookup[] = []
      const calls = stubApi(
        (call) => (call.method === 'PUT' ? ok(linkedTo({ id: 'c2', type: 'company', name: 'Bugando Medical Centre' })) : ok(newOrder)),
        { search: [bugando], lookups },
      )
      renderAt()

      expect(await screen.findByText('No customer has this phone or email yet.')).not.toBeNull()
      fireEvent.change(within(card()).getByLabelText('Find another customer'), { target: { value: 'Bugando' } })
      const results = await screen.findByRole('list', { name: 'Search results' })
      expect(lookups.at(-1)).toEqual({ path: '/api/office/customers', params: { q: 'Bugando' } })
      expect(within(results).getByText('+255 282 500 000')).not.toBeNull()

      fireEvent.click(within(results).getByRole('button', { name: 'Link to Bugando Medical Centre' }))
      expect((await screen.findByRole('status')).textContent).toContain('Linked to Bugando Medical Centre.')
      expect(calls[1].body).toEqual({ customerId: 'c2' })
    })

    it('a search with no result says so', async () => {
      stubApi(() => ok(newOrder))
      renderAt()

      fireEvent.change(await screen.findByLabelText('Find another customer'), { target: { value: 'Nobody here' } })
      expect(await screen.findByText('No customers match “Nobody here”.')).not.toBeNull()
    })

    it('creates a customer from the order after asking', async () => {
      const calls = stubApi(
        (call) => (call.method === 'POST' ? ok(linkedTo({ id: 'c9', type: 'individual', name: 'Asha Mushi' })) : ok(newOrder)),
        { matches: [{ ...bugando, matchedOn: ['phone'] }] },
      )
      renderAt()

      fireEvent.click(await screen.findByRole('button', { name: 'Create customer from this order' }))
      const group = screen.getByRole('group', { name: 'Create a customer for Asha Mushi?' })
      expect(document.activeElement?.textContent).toBe('Not now')
      expect(await within(group).findByText(/One customer already has this phone or email\./)).not.toBeNull()
      expect(calls).toHaveLength(1)

      fireEvent.click(within(group).getByRole('button', { name: 'Create and link' }))
      expect((await screen.findByRole('status')).textContent).toContain('Customer Asha Mushi created and linked.')
      expect(calls[1]).toEqual({ method: 'POST', path: '/api/office/orders/o1/customer', body: undefined })
      expect(within(card()).getByRole('link', { name: 'Asha Mushi' }).getAttribute('href')).toBe('/office/customers/c9')
    })

    it('unlinks a linked shop order', async () => {
      const calls = stubApi((call) =>
        call.method === 'DELETE' ? ok(newOrder) : ok(linkedTo({ id: 'c2', type: 'company', name: 'Bugando Medical Centre' })),
      )
      renderAt()

      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }))
      expect((await screen.findByRole('status')).textContent).toContain('Unlinked from Bugando Medical Centre.')
      expect(calls[1]).toMatchObject({ method: 'DELETE', path: '/api/office/orders/o1/customer' })
      expect(await screen.findByText('No customer has this phone or email yet.')).not.toBeNull()
    })

    it('linked by someone else meanwhile: shows why and the order as it is now', async () => {
      let gets = 0
      stubApi(
        (call) => {
          if (call.method === 'PUT') {
            return json(409, {
              success: false,
              error: {
                message: 'This order is already linked to a customer. Unlink it first to choose another.',
                code: 'ORDER_LINKED',
              },
            })
          }
          gets += 1
          return ok(gets === 1 ? newOrder : linkedTo({ id: 'c2', type: 'company', name: 'Bugando Medical Centre' }))
        },
        { matches: [{ ...asha, matchedOn: ['phone'] }] },
      )
      renderAt()

      fireEvent.click(await screen.findByRole('button', { name: 'Link to Asha Mushi' }))
      expect((await within(card()).findByRole('alert')).textContent).toBe(
        'This order is already linked to a customer. Unlink it first to choose another.',
      )
      expect(await within(card()).findByRole('link', { name: 'Bugando Medical Centre' })).not.toBeNull()
    })
  })

  it('shows "Order not found" for a 404, and an error with Try again', async () => {
    stubApi(() => json(404, { success: false, error: { message: 'Not found' } }))
    renderAt()
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Order not found')
    cleanup()

    let attempts = 0
    stubApi(() => {
      attempts += 1
      return attempts === 1 ? json(500, { success: false, error: { message: 'Internal server error' } }) : ok(newOrder)
    })
    renderAt()
    expect((await screen.findByRole('alert')).textContent).toBe('Internal server error')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('PSP-000123')
  })
})

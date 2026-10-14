import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OrdersList, { type OrderRow } from './OrdersList'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const asha: OrderRow = {
  id: 'o1',
  orderNumber: 'PSP-000124',
  status: 'new',
  paymentStatus: 'unpaid',
  source: 'shop',
  customerId: null,
  guestName: 'Asha Mushi',
  guestPhone: '+255712345678',
  deliveryArea: 'Mikocheni, Dar es Salaam',
  totalTzs: 1250000,
  hasQuotationLines: true,
  itemCount: 3,
  createdAt: '2026-10-14T08:00:00.000Z',
}
const juma: OrderRow = {
  id: 'o2',
  orderNumber: 'PSP-000123',
  status: 'confirmed',
  paymentStatus: 'paid',
  source: 'staff',
  customerId: null,
  guestName: 'Juma Said',
  guestPhone: '+254711000111',
  deliveryArea: 'Arusha',
  totalTzs: 0,
  hasQuotationLines: true,
  itemCount: 1,
  createdAt: '2026-10-13T08:00:00.000Z',
}

const COUNTS = { all: 2, new: 1, confirmed: 1, delivered: 0, closed: 0, cancelled: 0 }
const NONE = { all: 0, new: 0, confirmed: 0, delivered: 0, closed: 0, cancelled: 0 }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

function page(orders: OrderRow[], over: Record<string, unknown> = {}) {
  return json(200, {
    success: true,
    data: { orders, total: orders.length, page: 1, pageSize: 25, counts: COUNTS, ...over },
  })
}

function stubApi(handler: (url: URL) => Response) {
  const fetchMock = vi.fn(async (url: string) => handler(new URL(url, 'http://localhost')))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubWidth(compact: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: compact,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

const lastQuery = (fetchMock: ReturnType<typeof stubApi>) =>
  new URL(String(fetchMock.mock.lastCall?.[0]), 'http://localhost').searchParams

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/office/orders']}>
      <OrdersList />
    </MemoryRouter>,
  )
}

describe('OrdersList', () => {
  it('shows a loading skeleton, then the queue with status tab counts', async () => {
    stubWidth(false)
    stubApi(() => page([asha, juma]))
    renderList()

    expect(screen.getByLabelText('Loading orders')).not.toBeNull()
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(3)

    expect(within(rows[1]).getByRole('link', { name: 'PSP-000124' }).getAttribute('href')).toBe('/office/orders/o1')
    expect(within(rows[1]).getByText(/^Shop/)).not.toBeNull()
    expect(within(rows[1]).getByText('Asha Mushi')).not.toBeNull()
    expect(within(rows[1]).getByText('+255 712 345 678')).not.toBeNull()
    expect(within(rows[1]).getByText('Mikocheni, Dar es Salaam')).not.toBeNull()
    expect(within(rows[1]).getByText('3 items')).not.toBeNull()
    expect(within(rows[1]).getByText('TZS 1,250,000')).not.toBeNull()
    expect(within(rows[1]).getByText('+ items on request')).not.toBeNull()
    expect(within(rows[1]).getByText('New')).not.toBeNull()
    expect(within(rows[1]).getByText('Unpaid')).not.toBeNull()

    expect(within(rows[2]).getByText(/^Staff/)).not.toBeNull()
    expect(within(rows[2]).getByText('1 item')).not.toBeNull()
    expect(within(rows[2]).getByText('Price on request')).not.toBeNull()
    expect(within(rows[2]).getByText('Confirmed')).not.toBeNull()
    expect(within(rows[2]).getByText('Paid')).not.toBeNull()

    expect(screen.getByRole('button', { name: /^All orders\s*2$/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^New\s*1$/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /^Cancelled\s*0$/ })).not.toBeNull()
    expect(screen.getByText('Showing 2 of 2 orders')).not.toBeNull()
  })

  it('filters by status, payment and source, and searches after a pause, back on page 1', async () => {
    stubWidth(false)
    const fetchMock = stubApi((url) => (url.searchParams.get('status') === 'new' ? page([asha]) : page([asha, juma], { total: 30 })))
    renderList()
    await screen.findByText('Page 1 of 2')

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 2')
    expect(lastQuery(fetchMock).get('page')).toBe('2')

    fireEvent.click(screen.getByRole('button', { name: /^New/ }))
    await waitFor(() => expect(screen.queryByText('Juma Said')).toBeNull())
    expect(lastQuery(fetchMock).get('status')).toBe('new')
    expect(lastQuery(fetchMock).get('page')).toBe('1')

    fireEvent.change(screen.getByLabelText('Payment'), { target: { value: 'unpaid' } })
    await waitFor(() => expect(lastQuery(fetchMock).get('paymentStatus')).toBe('unpaid'))
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'shop' } })
    await waitFor(() => expect(lastQuery(fetchMock).get('source')).toBe('shop'))

    fireEvent.change(screen.getByLabelText('Search by order number, name or phone'), { target: { value: ' 000124 ' } })
    await waitFor(() => expect(lastQuery(fetchMock).get('q')).toBe('000124'))
    const params = lastQuery(fetchMock)
    expect(params.get('status')).toBe('new')
    expect(params.get('paymentStatus')).toBe('unpaid')
    expect(params.get('source')).toBe('shop')
    expect(params.get('page')).toBe('1')
  })

  it('says when nothing matches, and Clear filters brings the list back', async () => {
    stubWidth(false)
    const fetchMock = stubApi((url) =>
      url.searchParams.get('q') || url.searchParams.get('source') ? page([], { counts: NONE }) : page([asha, juma]),
    )
    renderList()
    await screen.findByRole('table')

    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'staff' } })
    const input = screen.getByLabelText('Search by order number, name or phone')
    fireEvent.change(input, { target: { value: 'nobody' } })
    fireEvent.submit(input)
    expect(await screen.findByText('No orders match “nobody”.')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await screen.findByRole('table')
    expect(lastQuery(fetchMock).get('q')).toBeNull()
    expect(lastQuery(fetchMock).get('source')).toBeNull()
    expect((input as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('')
  })

  it('names the empty status tab', async () => {
    stubWidth(false)
    stubApi((url) => (url.searchParams.get('status') === 'cancelled' ? page([]) : page([asha, juma])))
    renderList()
    await screen.findByRole('table')

    fireEvent.click(screen.getByRole('button', { name: /^Cancelled/ }))
    expect(await screen.findByText('No cancelled orders.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('has a plain empty state before the first order', async () => {
    stubWidth(false)
    stubApi(() => page([], { counts: NONE }))
    renderList()
    expect(await screen.findByText('No orders yet. Orders placed in the shop appear here.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('shows an error with Try again', async () => {
    stubWidth(false)
    let fail = true
    stubApi(() => (fail ? json(503, { success: false, error: { message: 'Service unavailable' } }) : page([asha, juma])))
    renderList()

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The service is temporarily unavailable. Please try again shortly.',
    )
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('table')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('becomes a card list on a phone', async () => {
    stubWidth(true)
    stubApi(() => page([asha, juma]))
    renderList()

    await screen.findByText('Asha Mushi')
    const cards = screen.getAllByRole('listitem')
    expect(screen.queryByRole('table')).toBeNull()
    expect(cards).toHaveLength(2)
    expect(within(cards[0]).getByText('PSP-000124')).not.toBeNull()
    expect(within(cards[0]).getByText('New')).not.toBeNull()
    expect(within(cards[0]).getByText('TZS 1,250,000')).not.toBeNull()
    expect(within(cards[1]).getByText('Paid')).not.toBeNull()
  })
})

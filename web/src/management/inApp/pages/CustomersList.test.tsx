import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CustomersList, { type Customer } from './CustomersList'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const asha: Customer = {
  id: 'c1',
  type: 'individual',
  fullName: 'Asha Mushi',
  companyName: null,
  tin: null,
  contactPerson: null,
  phone: '+255712345678',
  email: 'asha@example.com',
  createdAt: '2026-10-02T08:00:00.000Z',
  updatedAt: '2026-10-02T08:00:00.000Z',
}
const bugando: Customer = {
  id: 'c2',
  type: 'company',
  fullName: null,
  companyName: 'Bugando Medical Centre',
  tin: '123-456-789',
  contactPerson: 'Dr. Neema Kweka',
  phone: null,
  email: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

function page(customers: Customer[], over: Record<string, unknown> = {}) {
  return json(200, {
    success: true,
    data: { customers, total: customers.length, page: 1, pageSize: 25, counts: { all: 2, individual: 1, company: 1 }, ...over },
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

const lastQuery = (fetchMock: ReturnType<typeof stubApi>) => new URL(String(fetchMock.mock.lastCall?.[0]), 'http://localhost').searchParams

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/office/customers']}>
      <CustomersList />
    </MemoryRouter>,
  )
}

describe('CustomersList', () => {
  it('shows a loading skeleton, then the table with tab counts', async () => {
    stubWidth(false)
    stubApi(() => page([asha, bugando]))
    renderList()

    expect(screen.getByLabelText('Loading customers')).not.toBeNull()
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[1]).getByText('Asha Mushi')).not.toBeNull()
    expect(within(rows[1]).getByText('+255 712 345 678')).not.toBeNull()
    expect(within(rows[1]).getByText('asha@example.com')).not.toBeNull()
    expect(within(rows[1]).getByText('Individual')).not.toBeNull()
    expect(within(rows[2]).getByText('Bugando Medical Centre')).not.toBeNull()
    expect(within(rows[2]).getByText('Contact: Dr. Neema Kweka')).not.toBeNull()
    expect(within(rows[2]).getByText('TIN 123-456-789')).not.toBeNull()
    expect(within(rows[2]).getByText('No contact details')).not.toBeNull()

    expect(screen.getByRole('button', { name: /^All customers\s*2$/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^Companies\s*1$/ })).not.toBeNull()
    expect(screen.getByText('Showing 2 of 2 customers')).not.toBeNull()
  })

  it('filters by type and searches after a pause, back on page 1', async () => {
    stubWidth(false)
    const fetchMock = stubApi((url) => {
      if (url.searchParams.get('q') === 'kweka') return page([bugando], { counts: { all: 1, individual: 0, company: 1 } })
      if (url.searchParams.get('type') === 'company') return page([bugando])
      return page([asha, bugando], { total: 30 })
    })
    renderList()
    await screen.findByText('Page 1 of 2')

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 2')
    expect(lastQuery(fetchMock).get('page')).toBe('2')

    fireEvent.click(screen.getByRole('button', { name: /^Companies/ }))
    await waitFor(() => expect(screen.queryByText('Asha Mushi')).toBeNull())
    expect(lastQuery(fetchMock).get('type')).toBe('company')
    expect(lastQuery(fetchMock).get('page')).toBe('1')

    fireEvent.change(screen.getByLabelText('Search by name, company, phone or email'), { target: { value: ' kweka ' } })
    await waitFor(() => expect(lastQuery(fetchMock).get('q')).toBe('kweka'))
    expect(lastQuery(fetchMock).get('type')).toBe('company')
    expect(await screen.findByRole('button', { name: /^All customers\s*1$/ })).not.toBeNull()
  })

  it('says when nothing matches, and Clear search brings the list back', async () => {
    stubWidth(false)
    const fetchMock = stubApi((url) =>
      url.searchParams.get('q') ? page([], { counts: { all: 0, individual: 0, company: 0 } }) : page([asha, bugando]),
    )
    renderList()
    await screen.findByRole('table')

    const input = screen.getByLabelText('Search by name, company, phone or email')
    fireEvent.change(input, { target: { value: 'nobody' } })
    fireEvent.submit(input)
    expect(await screen.findByText('No customers match “nobody”.')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await screen.findByRole('table')
    expect(lastQuery(fetchMock).get('q')).toBeNull()
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('has a plain empty state before the first customer', async () => {
    stubWidth(false)
    stubApi(() => page([], { counts: { all: 0, individual: 0, company: 0 } }))
    renderList()
    expect(await screen.findByText('No customers yet.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  })

  it('shows an error with Try again', async () => {
    stubWidth(false)
    let fail = true
    stubApi(() =>
      fail
        ? json(503, { success: false, error: { message: 'Service unavailable' } })
        : page([asha, bugando]),
    )
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
    stubApi(() => page([asha, bugando]))
    renderList()

    await screen.findByText('Asha Mushi')
    const cards = screen.getAllByRole('listitem')
    expect(screen.queryByRole('table')).toBeNull()
    expect(cards).toHaveLength(2)
    expect(within(cards[0]).getByText('Asha Mushi')).not.toBeNull()
    expect(within(cards[0]).getByText('+255 712 345 678')).not.toBeNull()
    expect(within(cards[1]).getByText('Company')).not.toBeNull()
  })
})

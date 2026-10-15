import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Customer } from './CustomersList'
import OrderNew from './OrderNew'
import type { Product } from './ProductForm'

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
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
}

function product(over: Partial<Product>): Product {
  return {
    id: 'p1',
    name: 'Patient monitor M5',
    slug: 'patient-monitor-m5',
    sku: 'PM-M5',
    categoryId: 1,
    categoryName: 'Patient monitoring',
    brand: 'Mindray',
    countryOfOrigin: 'China',
    description: '',
    specs: [],
    priceTzs: 2500000,
    costPriceTzs: null,
    requestQuotation: false,
    quantityInStock: 4,
    lowStockAt: 2,
    stockStatus: 'in_stock',
    status: 'published',
    isPublished: true,
    isFeatured: false,
    isArchived: false,
    images: [],
    ...over,
  }
}

const monitor = product({})
const ct = product({ id: 'p2', name: 'CT scanner', sku: 'CT-1', priceTzs: null, requestQuotation: true })
const empty = product({ id: 'p3', name: 'Empty monitor', sku: 'PM-0', quantityInStock: 0, stockStatus: 'out_of_stock' })

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

type Call = { url: URL; method: string; body: Record<string, unknown> | null }

function stubApi(create?: (body: Record<string, unknown>) => Response) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url, 'http://localhost')
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      calls.push({ url: parsed, method: init?.method ?? 'GET', body })
      if (parsed.pathname === '/api/office/customers') {
        return json(200, { success: true, data: { customers: [asha] } })
      }
      if (parsed.pathname === '/api/office/products') {
        return json(200, { success: true, data: { products: [monitor, ct, empty] } })
      }
      if (parsed.pathname === '/api/office/orders' && init?.method === 'POST') {
        return create ? create(body ?? {}) : json(201, { success: true, data: { order: { id: 'o9' } } })
      }
      return json(404, { success: false, error: { message: 'Not found' } })
    }),
  )
  return calls
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/office/orders/new']}>
      <Routes>
        <Route path="/office/orders/new" element={<OrderNew />} />
        <Route path="/office/orders/:id" element={<p>Order page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function addProduct(term: string, name: string) {
  fireEvent.change(screen.getByLabelText('Add a product'), { target: { value: term } })
  fireEvent.click(await screen.findByRole('button', { name: `Add ${name}` }))
}

describe('OrderNew', () => {
  it('shows only published products found by search and adds them with a total preview', async () => {
    stubApi()
    renderPage()

    await addProduct('mon', 'Patient monitor M5')
    expect(screen.getByRole('button', { name: 'Add Empty monitor' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Add Patient monitor M5' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'More Patient monitor M5' }))
    expect(screen.getAllByText('TZS 5,000,000').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Add CT scanner' }))
    expect(screen.getByText('+ 1 item on request')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Remove CT scanner' }))
    expect(screen.queryByText('+ 1 item on request')).toBeNull()
  })

  it('creates an order for a chosen customer and opens it', async () => {
    const calls = stubApi()
    renderPage()

    fireEvent.change(screen.getByLabelText(/Find a customer/), { target: { value: 'asha' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Use Asha Mushi' }))
    await addProduct('mon', 'Patient monitor M5')
    fireEvent.click(screen.getByRole('button', { name: 'More Patient monitor M5' }))
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: 'Phone call' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }))

    expect(await screen.findByText('Order page')).not.toBeNull()
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.body).toMatchObject({
      customerId: 'c1',
      notes: 'Phone call',
      items: [{ productId: 'p1', quantity: 2 }],
    })
    // Prices are never sent: the server reads them from the database.
    expect(JSON.stringify(post?.body)).not.toMatch(/price|total/i)
  })

  it('sends a walk-in customer without a customer id', async () => {
    const calls = stubApi()
    renderPage()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Walk In' } })
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '0754111222' } })
    fireEvent.change(screen.getByLabelText('Area or city'), { target: { value: 'Mikocheni' } })
    fireEvent.change(screen.getByLabelText('Street or landmark'), { target: { value: 'Near the market' } })
    await addProduct('mon', 'Patient monitor M5')
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }))

    await screen.findByText('Order page')
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      guestName: 'Walk In',
      guestPhone: '0754111222',
      deliveryArea: 'Mikocheni',
      deliveryAddress: 'Near the market',
    })
  })

  it('asks for a product before sending anything', async () => {
    const calls = stubApi()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Create order' }))

    expect(await screen.findByText('Add at least one product.')).not.toBeNull()
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('shows the server’s field errors next to the fields', async () => {
    stubApi(() =>
      json(400, {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Check the highlighted fields.',
          details: { guestPhone: 'Enter a Tanzanian phone number, for example 0712 345 678.' },
        },
      }),
    )
    renderPage()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Walk In' } })
    await addProduct('mon', 'Patient monitor M5')
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }))

    expect(await screen.findByText('Enter a Tanzanian phone number, for example 0712 345 678.')).not.toBeNull()
    expect(screen.getByLabelText('Phone').getAttribute('aria-invalid')).toBe('true')
  })

  it('names the products that are no longer available and keeps the form', async () => {
    stubApi(() =>
      json(409, {
        success: false,
        error: { code: 'LINES_UNAVAILABLE', message: 'x', details: { lines: [{ index: 0, code: 'OUT_OF_STOCK' }] } },
      }),
    )
    renderPage()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Walk In' } })
    await addProduct('mon', 'Patient monitor M5')
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Not available any more: Patient monitor M5/))
    expect(screen.getByRole('button', { name: 'Remove Patient monitor M5' })).not.toBeNull()
  })
})

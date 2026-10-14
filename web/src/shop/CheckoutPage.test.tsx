import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShopProduct } from './api'
import CartPage from './CartPage'
import { CART_KEY, readCart } from './cart'
import CheckoutPage, { OrderConfirmed } from './CheckoutPage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.removeItem(CART_KEY)
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const ok = (data: unknown, status = 200) => json(status, { success: true, data })
const fail = (status: number, code: string, message: string, details?: unknown) =>
  json(status, { success: false, error: { code, message, details } })

function product(id: string, over: Partial<ShopProduct> = {}): ShopProduct {
  return {
    id,
    name: `Product ${id}`,
    slug: `product-${id}`,
    brand: 'Mindray',
    category: { name: 'Patient monitoring', slug: 'patient-monitoring' },
    priceTzs: 1000000,
    requestQuotation: false,
    inStock: true,
    imageUrl: null,
    ...over,
  }
}

const CATALOGUE = [
  product('a', { name: 'Bedside monitor', priceTzs: 4850000 }),
  product('b', { name: 'Pulse oximeter', priceTzs: 85000 }),
  product('q', { name: 'CT scanner', priceTzs: null, requestQuotation: true }),
]

function seed(lines: { productId: string; quantity: number }[]) {
  localStorage.setItem(CART_KEY, JSON.stringify(lines))
}

// Answers the cart prices from `products` and the order with `order()`.
function stubApi(order: () => Response | Promise<Response>, products: ShopProduct[] = CATALOGUE) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    const url = String(input)
    if (url.includes('/api/shop/cart/prices')) {
      const lines = JSON.parse(String(init?.body)) as { productId: string; quantity: number }[]
      const items = lines.flatMap((line) => {
        const found = products.find((p) => p.id === line.productId)
        return found ? [{ product: found, quantity: line.quantity }] : []
      })
      return ok({ items })
    }
    if (url.includes('/api/shop/orders')) return order()
    throw new Error(`unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const orderCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/shop/orders'))

function renderAt(path: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/order-confirmed" element={<OrderConfirmed />} />
        <Route path="/products" element={<p>Catalogue page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

const VALID = {
  name: 'Neema Mushi',
  phone: '0712 345 678',
  email: '',
  area: 'Mikocheni, Dar es Salaam',
  address: 'Plot 12, near the Total station',
  notes: 'Call before delivery',
}

const input = {
  name: () => screen.getByLabelText('Full name') as HTMLInputElement,
  phone: () => screen.getByLabelText('Phone number') as HTMLInputElement,
  email: () => screen.getByLabelText(/^Email/) as HTMLInputElement,
  area: () => screen.getByLabelText('Area or city') as HTMLInputElement,
  address: () => screen.getByLabelText('Street, plot or landmark') as HTMLInputElement,
  notes: () => screen.getByLabelText(/^Notes for PSP/) as HTMLTextAreaElement,
}

// Sets every field, so nothing carries over from the in-memory draft of an earlier test.
function fill(values: Partial<typeof VALID>) {
  for (const key of Object.keys(input) as (keyof typeof input)[]) {
    fireEvent.change(input[key](), { target: { value: values[key] ?? '' } })
  }
}

const placeButton = () => screen.getByRole('button', { name: /Place order|Placing your order/ })

async function openCheckout() {
  renderAt('/checkout')
  return screen.findByLabelText('Full name')
}

describe('CheckoutPage', () => {
  it('sends an empty cart back to /cart', () => {
    const fetchMock = stubApi(() => ok({}))
    renderAt('/checkout')
    expect(screen.getByRole('heading', { name: 'Your cart is empty' })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the summary from server prices, the pay-later note and the total on the button', async () => {
    seed([
      { productId: 'a', quantity: 2 },
      { productId: 'b', quantity: 1 },
      { productId: 'q', quantity: 1 },
    ])
    stubApi(() => ok({}))
    await openCheckout()

    expect(screen.getByText(/Nothing is charged now/).textContent).toContain(
      'you pay on delivery, against an invoice, or by bank transfer',
    )
    expect(placeButton().textContent).toContain('Place order · TZS 9,785,000')

    // Folded on a phone; opens on demand.
    const toggle = screen.getByRole('button', { name: /Show order summary/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const summary = document.getElementById('checkout-summary-body') as HTMLElement
    expect(summary.hidden).toBe(false)
    expect(within(summary).getByText('2 × TZS 4,850,000')).toBeTruthy()
    expect(within(summary).getByText('1 × Price on request')).toBeTruthy()
    expect(within(summary).getByText('Subtotal (3 items)')).toBeTruthy()
    expect(within(summary).getByText('Price on request (1 item)')).toBeTruthy()
  })

  it('validates inline with messages tied to the fields, and sends nothing while a field is wrong', async () => {
    seed([{ productId: 'a', quantity: 1 }])
    const fetchMock = stubApi(() => ok({ orderNumber: 'PSP-000001', totalTzs: 1 }, 201))
    await openCheckout()
    fill({})

    fireEvent.click(placeButton())
    expect(screen.getByRole('alert').textContent).toBe('Check the 4 highlighted fields above.')
    expect(document.activeElement).toBe(input.name())
    for (const [field, message] of [
      ['name', 'Enter your full name.'],
      ['phone', 'Enter a phone number so PSP can call you.'],
      ['area', 'Enter the area or city for delivery.'],
      ['address', 'Enter a street, plot or landmark.'],
    ] as const) {
      const element = input[field]()
      expect(element.getAttribute('aria-invalid')).toBe('true')
      const error = document.getElementById(`checkout-${field}-error`) as HTMLElement
      expect(element.getAttribute('aria-describedby')).toContain(error.id)
      expect(error.textContent).toBe(message)
    }
    expect(input.email().getAttribute('aria-invalid')).toBeNull() // optional
    expect(input.notes().getAttribute('aria-invalid')).toBeNull()

    // Wrong values are flagged when the field is left; the message clears as soon as it is right.
    fireEvent.change(input.phone(), { target: { value: '12345' } })
    fireEvent.blur(input.phone())
    expect(document.getElementById('checkout-phone-error')?.textContent).toBe(
      'Enter a Tanzanian number, for example 0712 345 678.',
    )
    fireEvent.change(input.phone(), { target: { value: '+255 754 000 111' } })
    expect(input.phone().getAttribute('aria-invalid')).toBeNull()

    fireEvent.change(input.email(), { target: { value: 'neema@' } })
    fireEvent.blur(input.email())
    expect(document.getElementById('checkout-email-error')?.textContent).toContain('Enter a valid email address')

    expect(orderCalls(fetchMock)).toHaveLength(0)
  })

  it('places the order with ids and quantities only, clears the cart and shows the order number', async () => {
    seed([
      { productId: 'a', quantity: 2 },
      { productId: 'b', quantity: 1 },
    ])
    const fetchMock = stubApi(() => ok({ orderNumber: 'PSP-000123', totalTzs: 9785000 }, 201))
    await openCheckout()
    fill(VALID)
    fireEvent.click(placeButton())

    expect(await screen.findByRole('heading', { name: 'Thank you, your order is placed' })).toBeTruthy()
    const [[url, init]] = orderCalls(fetchMock)
    expect(String(url)).toContain('/api/shop/orders')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      ...VALID,
      website: '',
      items: [
        { productId: 'a', quantity: 2 },
        { productId: 'b', quantity: 1 },
      ],
    })

    expect(screen.getByText('PSP-000123')).toBeTruthy()
    expect(screen.getByText('PSP will contact you to confirm and arrange payment.')).toBeTruthy()
    expect(screen.getByText('TZS 9,785,000')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Continue shopping' }).getAttribute('href')).toBe('/products')
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Thank you, your order is placed' }))

    // The cart is gone and nothing personal was written to browser storage.
    expect(readCart()).toEqual([])
    expect(localStorage.getItem(CART_KEY)).toBeNull()
    for (const storage of [localStorage, sessionStorage]) {
      for (let n = 0; n < storage.length; n += 1) {
        const value = storage.getItem(storage.key(n) as string) ?? ''
        expect(value).not.toMatch(/Neema|712|Mikocheni|Plot 12/)
      }
    }
  })

  it('copies the order number', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderAt('/order-confirmed', { orderNumber: 'PSP-000042', totalTzs: 85000, hasQuote: true })

    fireEvent.click(screen.getByRole('button', { name: 'Copy number' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith('PSP-000042')
    expect(screen.getByText('PSP will send you a quotation for those items.')).toBeTruthy()
  })

  it('shows a calm state when /order-confirmed is opened without an order', () => {
    renderAt('/order-confirmed')
    expect(screen.getByRole('heading', { name: 'No order to show' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Continue shopping' }).getAttribute('href')).toBe('/products')
  })

  it('a refused line sends the person back to the cart with a readable notice; the details survive in memory', async () => {
    seed([
      { productId: 'a', quantity: 1 },
      { productId: 'b', quantity: 3 },
    ])
    stubApi(() =>
      fail(409, 'LINES_UNAVAILABLE', 'Some products in your cart are no longer available.', {
        lines: [{ index: 1, productId: 'b', code: 'OUT_OF_STOCK' }],
      }),
    )
    await openCheckout()
    fill(VALID)
    fireEvent.click(placeButton())

    const notice = await screen.findByText(/Your order was not placed/)
    expect(notice.textContent).toContain('Pulse oximeter (out of stock)')
    expect(screen.getByRole('heading', { name: /Your cart/ })).toBeTruthy()
    expect(readCart()).toHaveLength(2) // nothing removed for them

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Your order was not placed/)).toBeNull()

    // Back to checkout in the same tab: what they typed is still there.
    cleanup()
    await openCheckout()
    expect(input.name().value).toBe('Neema Mushi')
    expect(input.phone().value).toBe('0712 345 678')
  })

  it('maps server field errors to the fields, and keeps the details after a failed send', async () => {
    seed([{ productId: 'a', quantity: 1 }])
    let answer = () => fail(400, 'VALIDATION_ERROR', 'Check the highlighted fields.', { phone: 'Server says no.' })
    stubApi(() => answer())
    await openCheckout()
    fill(VALID)
    fireEvent.click(placeButton())

    expect(await screen.findByText('Server says no.')).toBeTruthy()
    expect(document.activeElement).toBe(input.phone())

    answer = () => fail(503, 'SERVICE_UNAVAILABLE', 'Down')
    fireEvent.click(placeButton())
    expect((await screen.findByRole('alert')).textContent).toContain('Ordering is unavailable for a moment')
    expect(input.name().value).toBe('Neema Mushi')
    expect(placeButton().getAttribute('aria-disabled')).toBe('false')
  })

  it('shows progress and sends only one order however often it is submitted', async () => {
    seed([{ productId: 'a', quantity: 1 }])
    let finish: (response: Response) => void = () => {}
    const fetchMock = stubApi(() => new Promise<Response>((resolve) => (finish = resolve)))
    await openCheckout()
    fill(VALID)

    const form = placeButton().closest('form') as HTMLFormElement
    fireEvent.click(placeButton())
    fireEvent.click(placeButton())
    fireEvent.submit(form)
    expect(placeButton().textContent).toBe('Placing your order…')
    expect(placeButton().getAttribute('aria-disabled')).toBe('true')
    expect(orderCalls(fetchMock)).toHaveLength(1)

    await act(async () => finish(ok({ orderNumber: 'PSP-000777', totalTzs: 4850000 }, 201)))
    expect(await screen.findByText('PSP-000777')).toBeTruthy()
    expect(orderCalls(fetchMock)).toHaveLength(1)
  })
})

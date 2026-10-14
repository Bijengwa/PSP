import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShopProduct } from './api'
import { CART_KEY, readCart, rememberPrice } from './cart'
import CartPage from './CartPage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.removeItem(CART_KEY)
})

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })

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

function seed(lines: { productId: string; quantity: number }[]) {
  localStorage.setItem(CART_KEY, JSON.stringify(lines))
}

function stubPrices(products: ShopProduct[]) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_input, init) => {
    const lines = JSON.parse(String(init?.body)) as { productId: string; quantity: number }[]
    const items = lines.flatMap((line) => {
      const found = products.find((p) => p.id === line.productId)
      return found ? [{ product: found, quantity: line.quantity }] : []
    })
    return ok({ items })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <CartPage />
    </MemoryRouter>,
  )

const line = (name: string) => screen.getByRole('link', { name }).closest('li') as HTMLElement

describe('CartPage', () => {
  it('shows an empty state with a link to the catalogue, without calling the API', () => {
    const fetchMock = stubPrices([])
    renderPage()
    expect(screen.getByRole('heading', { name: 'Your cart is empty' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Browse products' }).getAttribute('href')).toBe('/products')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends only ids and quantities and shows server prices, line totals and the order total', async () => {
    seed([
      { productId: 'a', quantity: 2 },
      { productId: 'b', quantity: 1 },
    ])
    const fetchMock = stubPrices([
      product('a', { name: 'Bedside monitor', priceTzs: 4850000 }),
      product('b', { name: 'Pulse oximeter', priceTzs: 85000 }),
    ])
    renderPage()

    expect(await screen.findByRole('link', { name: 'Bedside monitor' })).toBeTruthy()
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/shop/cart/prices')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual([
      { productId: 'a', quantity: 2 },
      { productId: 'b', quantity: 1 },
    ])

    const monitor = line('Bedside monitor')
    expect(within(monitor).getByText('TZS 9,700,000')).toBeTruthy()
    expect(within(monitor).getByText('TZS 4,850,000 each')).toBeTruthy()
    expect(screen.getByText('Subtotal (3 items)')).toBeTruthy()
    expect(screen.getAllByText('TZS 9,785,000')).toHaveLength(2) // subtotal and total
    expect(screen.getByRole('link', { name: 'Checkout' }).getAttribute('href')).toBe('/checkout')
  })

  it('the stepper updates the stored quantity and the totals without a new request; remove drops the line', async () => {
    seed([
      { productId: 'a', quantity: 1 },
      { productId: 'b', quantity: 1 },
    ])
    const fetchMock = stubPrices([
      product('a', { name: 'Bedside monitor', priceTzs: 1000 }),
      product('b', { name: 'Pulse oximeter', priceTzs: 500 }),
    ])
    renderPage()

    const monitor = (await screen.findByRole('link', { name: 'Bedside monitor' })).closest('li') as HTMLElement
    expect(document.title).toBe('Your cart | PSP Engineering Group')
    fireEvent.click(within(monitor).getByRole('button', { name: 'Increase quantity' }))
    expect(readCart()[0]).toEqual({ productId: 'a', quantity: 2 })
    expect(within(monitor).getByText('TZS 2,000')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Bedside monitor: quantity 2.')

    const input = within(monitor).getByRole('textbox', { name: 'Quantity' })
    fireEvent.change(input, { target: { value: '150' } })
    fireEvent.blur(input)
    expect(readCart()[0].quantity).toBe(15)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Pulse oximeter from cart' }))
    expect(readCart()).toEqual([{ productId: 'a', quantity: 15 }])
    expect(screen.queryByRole('link', { name: 'Pulse oximeter' })).toBeNull()
    expect(screen.getByText('Pulse oximeter was removed from your cart.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Items (15)' }))
    expect(screen.getAllByText('TZS 15,000')).toHaveLength(3) // line, subtotal, total
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bedside monitor from cart' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your cart is empty' }))
  })

  it('labels quotation lines "Price on request" and leaves them out of the total', async () => {
    seed([
      { productId: 'a', quantity: 1 },
      { productId: 'q', quantity: 2 },
    ])
    stubPrices([
      product('a', { name: 'Bedside monitor', priceTzs: 1000 }),
      product('q', { name: 'CT scanner', priceTzs: null, requestQuotation: true }),
    ])
    renderPage()

    const ct = (await screen.findByRole('link', { name: 'CT scanner' })).closest('li') as HTMLElement
    expect(within(ct).getAllByText('Price on request').length).toBeGreaterThan(0)
    expect(within(ct).queryByText(/TZS/)).toBeNull()
    expect(screen.getByText('Subtotal (1 item)')).toBeTruthy()
    expect(screen.getByText('Price on request (2 items)')).toBeTruthy()
    expect(screen.getAllByText('TZS 1,000')).toHaveLength(3)
    expect(screen.getByRole('link', { name: 'Checkout' })).toBeTruthy()
  })

  it('flags removed, out-of-stock and re-priced products and blocks checkout until they are removed', async () => {
    rememberPrice('c', 2000)
    seed([
      { productId: 'gone', quantity: 1 },
      { productId: 'out', quantity: 1 },
      { productId: 'c', quantity: 1 },
    ])
    stubPrices([
      product('out', { name: 'Infusion pump', priceTzs: 700, inStock: false }),
      product('c', { name: 'Hospital bed', priceTzs: 2500 }),
    ])
    renderPage()

    expect(await screen.findByText('Removed from the catalogue')).toBeTruthy()
    expect(within(line('Infusion pump')).getByText('Out of stock')).toBeTruthy()
    expect(within(line('Infusion pump')).getByText('Not in total')).toBeTruthy()
    expect(within(line('Hospital bed')).getByText('Price changed, was TZS 2,000')).toBeTruthy()
    expect(screen.getByText(/2 products in your cart can't be ordered/)).toBeTruthy()
    expect(screen.getAllByText('TZS 2,500')).toHaveLength(3) // only the available line counts

    const checkout = screen.getByRole('button', { name: 'Checkout' }) as HTMLButtonElement
    expect(checkout.disabled).toBe(true)
    expect(screen.queryByRole('link', { name: 'Checkout' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Product no longer available from cart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Infusion pump from cart' }))
    expect(screen.getByRole('link', { name: 'Checkout' }).getAttribute('href')).toBe('/checkout')
    expect(readCart()).toEqual([{ productId: 'c', quantity: 1 }])
  })

  it('shows an error with a retry that loads again', async () => {
    seed([{ productId: 'a', quantity: 1 }])
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return calls === 1
          ? new Response(JSON.stringify({ success: false, error: { message: 'No' } }), { status: 500 })
          : ok({ items: [{ product: product('a', { name: 'Bedside monitor' }), quantity: 1 }] })
      }),
    )
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('We could not load your cart')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Bedside monitor' })).toBeTruthy()
  })

  it('shows a skeleton while the prices load', () => {
    seed([{ productId: 'a', quantity: 1 }])
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    renderPage()
    expect(screen.getByRole('status').textContent).toBe('Loading your cart…')
  })
})

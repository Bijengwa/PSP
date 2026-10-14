import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShopProduct, ShopProductDetail } from './api'
import { CART_KEY, readCart } from './cart'
import ProductPage from './ProductPage'

afterEach(() => {
  cleanup()
  localStorage.removeItem(CART_KEY)
  vi.unstubAllGlobals()
  document.head.querySelector('meta[name="description"]')?.remove()
})

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
const status = (code: number) =>
  new Response(JSON.stringify({ success: false, error: { message: 'No' } }), { status: code })

function detail(over: Partial<ShopProductDetail> = {}): ShopProductDetail {
  return {
    id: 'p1',
    name: 'Bedside monitor',
    slug: 'bedside-monitor',
    brand: 'Mindray',
    category: { name: 'Patient monitoring', slug: 'patient-monitoring' },
    priceTzs: 4850000,
    requestQuotation: false,
    inStock: true,
    imageUrl: '/uploads/a.png',
    sku: 'PSP-PM-0012',
    description: 'Monitors ECG, SpO2 and blood pressure.\n\nWith a battery for transport.',
    specs: [
      { label: 'Display', value: '12.1" TFT' },
      { label: 'Weight', value: '' },
    ],
    images: ['/uploads/a.png', '/uploads/b.png', '/uploads/c.png'],
    ...over,
  }
}

const related: ShopProduct[] = [
  {
    id: 'r1',
    name: 'Pulse oximeter',
    slug: 'pulse-oximeter',
    brand: '',
    category: { name: 'Patient monitoring', slug: 'patient-monitoring' },
    priceTzs: 85000,
    requestQuotation: false,
    inStock: true,
    imageUrl: null,
  },
]

function stubApi(answer: () => Response) {
  const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => answer())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPage(path = '/products/bedside-monitor') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/products/:slug" element={<ProductPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProductPage', () => {
  it('shows the product, breadcrumb, specs, related products, title and meta description', async () => {
    const fetchMock = stubApi(() => ok({ product: detail(), related }))
    renderPage()

    expect(await screen.findByRole('heading', { level: 1, name: 'Bedside monitor' })).toBeTruthy()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/shop/products/bedside-monitor')
    expect(screen.getByText('TZS 4,850,000')).toBeTruthy()
    expect(screen.getByText('SKU PSP-PM-0012')).toBeTruthy()
    expect(screen.getAllByText('In stock')).toHaveLength(2) // the product and its related card

    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Patient monitoring' }).getAttribute('href')).toBe(
      '/products?category=patient-monitoring',
    )

    const specs = screen.getByRole('table')
    expect(within(specs).getByRole('rowheader', { name: 'Display' })).toBeTruthy()
    expect(within(specs).getByText('12.1" TFT')).toBeTruthy()
    expect(screen.getByText('With a battery for transport.')).toBeTruthy()

    expect(screen.getByRole('link', { name: 'Pulse oximeter' }).getAttribute('href')).toBe('/products/pulse-oximeter')

    // PageMeta sets these in an effect, which can land after the heading under load.
    await waitFor(() => expect(document.title).toBe('Bedside monitor | PSP Engineering Group'))
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Monitors ECG, SpO2 and blood pressure. With a battery for transport.',
    )
  })

  it('gallery: thumbnails, arrow keys and swipe change the photo', async () => {
    stubApi(() => ok({ product: detail(), related: [] }))
    renderPage()

    const gallery = await screen.findByRole('group', { name: /Product photos, 1 of 3/ })
    const main = () => within(gallery).getByRole('img') as HTMLImageElement
    expect(main().alt).toBe('Bedside monitor, photo 1 of 3')

    fireEvent.keyDown(gallery, { key: 'ArrowRight' })
    expect(main().alt).toBe('Bedside monitor, photo 2 of 3')
    fireEvent.keyDown(gallery, { key: 'ArrowLeft' })
    fireEvent.keyDown(gallery, { key: 'ArrowLeft' })
    expect(main().alt).toBe('Bedside monitor, photo 3 of 3')

    fireEvent.click(screen.getByRole('button', { name: 'Show photo 1 of 3' }))
    expect(main().alt).toBe('Bedside monitor, photo 1 of 3')
    expect(screen.getByRole('button', { name: 'Show photo 1 of 3' }).getAttribute('aria-current')).toBe('true')

    const thumb = screen.getByRole('button', { name: 'Show photo 1 of 3' })
    fireEvent.keyDown(thumb, { key: 'End' })
    expect(main().alt).toBe('Bedside monitor, photo 3 of 3')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show photo 3 of 3' }))

    fireEvent.pointerDown(gallery, { clientX: 200 })
    fireEvent.pointerUp(gallery, { clientX: 100 })
    expect(main().alt).toBe('Bedside monitor, photo 1 of 3')
    fireEvent.pointerDown(gallery, { clientX: 100 })
    fireEvent.pointerUp(gallery, { clientX: 110 })
    expect(main().alt).toBe('Bedside monitor, photo 1 of 3')
  })

  it('quantity stepper stays within 1–99 and Add to cart stores the line and confirms', async () => {
    stubApi(() => ok({ product: detail(), related: [] }))
    renderPage()

    const quantity = (await screen.findByRole('textbox', { name: 'Quantity' })) as HTMLInputElement
    const minus = screen.getByRole('button', { name: 'Decrease quantity' }) as HTMLButtonElement
    expect(minus.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }))
    expect(quantity.value).toBe('2')
    fireEvent.change(quantity, { target: { value: '250' } })
    fireEvent.blur(quantity)
    expect(quantity.value).toBe('25')
    fireEvent.change(quantity, { target: { value: '' } })
    fireEvent.blur(quantity)
    expect(quantity.value).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }))
    expect(screen.getByRole('status').textContent).toContain('Added 1 × Bedside monitor to your cart.')
    expect(screen.getByRole('link', { name: 'View cart' }).getAttribute('href')).toBe('/cart')
    expect(readCart()).toEqual([{ productId: 'p1', quantity: 1 }])

    fireEvent.change(quantity, { target: { value: '99' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }))
    expect(screen.getByRole('status').textContent).toContain('holds 99 × Bedside monitor')
    expect(readCart()).toEqual([{ productId: 'p1', quantity: 99 }])
  })

  it('out of stock disables Add to cart; quotation products show "Request quotation"', async () => {
    stubApi(() => ok({ product: detail({ inStock: false, requestQuotation: true, priceTzs: null, images: [] }), related: [] }))
    renderPage()

    const add = (await screen.findByRole('button', { name: 'Add to cart' })) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(screen.getByText('Out of stock')).toBeTruthy()
    expect(screen.getByText('Request quotation')).toBeTruthy()
    expect(screen.queryByText(/TZS/)).toBeNull()
    expect(screen.getByText('No photo yet')).toBeTruthy()
  })

  it('shows a not-found state for a 404', async () => {
    stubApi(() => status(404))
    renderPage('/products/gone')

    expect(await screen.findByRole('heading', { level: 1, name: 'Product not found' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Browse all products' }).getAttribute('href')).toBe('/products')
    await waitFor(() => expect(document.title).toBe('Product not found | PSP Engineering Group'))
  })

  it('shows an error with a retry that loads again', async () => {
    let calls = 0
    stubApi(() => {
      calls += 1
      return calls === 1 ? status(500) : ok({ product: detail(), related: [] })
    })
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('We could not load this product')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Bedside monitor' })).toBeTruthy()
  })

  it('shows a skeleton while loading', () => {
    stubApi(() => new Promise<Response>(() => {}) as unknown as Response)
    renderPage()
    expect(screen.getByRole('status').textContent).toBe('Loading product…')
  })
})

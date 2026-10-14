import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShopProduct } from './api'
import Catalog from './Catalog'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
const fail = () => new Response(JSON.stringify({ success: false, error: { message: 'Boom' } }), { status: 500 })

const categories = [
  { name: 'Imaging', slug: 'imaging', productCount: 3 },
  { name: 'Patient monitoring', slug: 'patient-monitoring', productCount: 2 },
]

function item(over: Partial<ShopProduct> = {}): ShopProduct {
  return {
    id: 'p1',
    name: 'Bedside monitor',
    slug: 'bedside-monitor',
    brand: 'Mindray',
    category: { name: 'Patient monitoring', slug: 'patient-monitoring' },
    priceTzs: 1250000,
    requestQuotation: false,
    inStock: true,
    imageUrl: null,
    ...over,
  }
}

// Answers the shop API; `products` decides each product-list answer from its URL.
function stubApi(products: (url: URL) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://shop.test')
    if (url.pathname === '/api/shop/categories') return ok({ categories })
    return products(url)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// Path and query of each product-list request, whatever the API base URL is.
const productCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://shop.test'))
    .filter((url) => url.pathname === '/api/shop/products')
    .map((url) => url.pathname + url.search)

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function renderCatalog(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/products"
          element={
            <>
              <Catalog />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Catalog', () => {
  it('reads the filters from the URL and shows the cards', async () => {
    const fetchMock = stubApi(() =>
      ok({
        products: [item(), item({ id: 'p2', name: 'CT scanner', slug: 'ct', requestQuotation: true, priceTzs: null, inStock: false })],
        total: 14,
        page: 2,
        pageSize: 12,
      }),
    )
    renderCatalog('/products?category=imaging&sort=price_asc&page=2')

    expect(await screen.findByText('Bedside monitor')).toBeTruthy()
    expect(productCalls(fetchMock)).toEqual(['/api/shop/products?category=imaging&sort=price_asc&page=2'])
    expect(screen.getByText('TZS 1,250,000')).toBeTruthy()
    expect(screen.getByText('Price on request')).toBeTruthy()
    expect(screen.getByText('In stock')).toBeTruthy()
    expect(screen.getByText('Out of stock')).toBeTruthy()
    expect(screen.getByText('Showing 13–14 of 14 products')).toBeTruthy()
    expect(await screen.findByRole('heading', { level: 1, name: 'Imaging' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Bedside monitor' }).getAttribute('href')).toBe('/products/bedside-monitor')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('price_asc')

    const pages = screen.getByRole('navigation', { name: 'Pages' })
    expect(within(pages).getByText('Page 2 of 2')).toBeTruthy()
    expect(within(pages).getByRole('link', { name: /Previous/ }).getAttribute('href')).toBe(
      '/products?category=imaging&sort=price_asc',
    )
  })

  it('shows skeleton cards while loading', () => {
    stubApi(() => new Promise<Response>(() => {}) as unknown as Response)
    renderCatalog('/products')
    expect(screen.getByRole('list', { name: 'Loading products' })).toBeTruthy()
  })

  it('category chips are links that change the URL and reset the page', async () => {
    const fetchMock = stubApi(() => ok({ products: [item()], total: 1, page: 1, pageSize: 12 }))
    renderCatalog('/products?page=3&sort=name')

    const chip = await screen.findByRole('link', { name: /Patient monitoring/ })
    expect(screen.getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(chip)

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/products?category=patient-monitoring&sort=name'))
    await waitFor(() =>
      expect(productCalls(fetchMock)).toContain('/api/shop/products?category=patient-monitoring&sort=name'),
    )
    expect(screen.getByRole('link', { name: /Patient monitoring/ }).getAttribute('aria-current')).toBe('page')
  })

  it('searches after a pause, not on every key', async () => {
    const fetchMock = stubApi(() => ok({ products: [item()], total: 1, page: 1, pageSize: 12 }))
    renderCatalog('/products?category=imaging&page=2')
    await screen.findByText('Bedside monitor')

    const box = screen.getByRole('searchbox', { name: 'Search products' })
    fireEvent.change(box, { target: { value: 'pu' } })
    fireEvent.change(box, { target: { value: 'pump' } })
    expect(productCalls(fetchMock)).toHaveLength(1)

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/products?q=pump&category=imaging'))
    await waitFor(() => expect(productCalls(fetchMock)).toEqual([
      '/api/shop/products?category=imaging&page=2',
      '/api/shop/products?q=pump&category=imaging',
    ]))
  })

  it('shows an empty state with a way back when nothing matches', async () => {
    stubApi(() => ok({ products: [], total: 0, page: 1, pageSize: 12 }))
    renderCatalog('/products?q=zzz')

    expect(await screen.findByRole('heading', { name: 'No products match' })).toBeTruthy()
    expect(screen.getByText(/Nothing found for “zzz”/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Clear filters' }).getAttribute('href')).toBe('/products')
  })

  it('shows an error with a retry that loads again', async () => {
    let calls = 0
    stubApi(() => {
      calls += 1
      return calls === 1 ? fail() : ok({ products: [item()], total: 1, page: 1, pageSize: 12 })
    })
    renderCatalog('/products')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('We could not load the catalogue')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Bedside monitor')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

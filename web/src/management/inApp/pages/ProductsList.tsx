import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { apiRequest, apiUrl, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'
import { PRODUCTS_PATH, TZS, useCategories, type Product, type StockStatus } from './ProductForm'

type ProductsPage = { products: Product[]; total: number; page: number; pageSize: number }
type StatusFilter = '' | 'draft' | 'published' | 'archived'

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: ProductsPage }

const STATUS_LABELS: Record<Product['status'], string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
}

// Phones get a card list instead of a table. Only one layout is rendered.
// Keep the width in step with the staff list.
const COMPACT_QUERY = '(max-width: 640px)'

function subscribeToCompact(onChange: () => void) {
  const query = window.matchMedia(COMPACT_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function listErrorMessage(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

const STOCK_LABELS: Record<StockStatus, string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
}

function priceText(product: Product) {
  if (product.requestQuotation) return 'Quotation'
  return product.priceTzs === null ? '-' : TZS.format(product.priceTzs)
}

function Thumb({ product }: { product: Product }) {
  const main = product.images[0]
  return main ? (
    <img className="office-thumb" src={apiUrl(main.url)} alt="" loading="lazy" />
  ) : (
    <span className="office-thumb" aria-hidden="true" />
  )
}

function StatusBadge({ status }: { status: Product['status'] }) {
  return <span className={`office-status office-status-${status}`}>{STATUS_LABELS[status]}</span>
}

// /office/products: search by name or SKU, filter by category and status, paged.
export default function ProductsList() {
  const compact = useSyncExternalStore(subscribeToCompact, () => window.matchMedia(COMPACT_QUERY).matches)
  const { categories } = useCategories()
  const notice = (useLocation().state as { notice?: string } | null)?.notice ?? null

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [page, setPage] = useState(1)
  const [list, setList] = useState<ListState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ page: String(page) })
    if (query) params.set('q', query)
    if (categoryId) params.set('categoryId', categoryId)
    if (status) params.set('status', status)

    apiRequest<ProductsPage>(`/api/office/products?${params}`, { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setList({ status: 'ready', data: result.data })
        else setList({ status: 'error', message: listErrorMessage(result) })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [query, categoryId, status, page])

  function filterChanged() {
    setList({ status: 'loading' })
    setPage(1)
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    filterChanged()
    setQuery(search.trim())
  }

  function goToPage(next: number) {
    setList({ status: 'loading' })
    setPage(next)
  }

  const totalPages = list.status === 'ready' ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1

  return (
    <>
      <h1 className="office-title">Products</h1>
      <p className="office-lead">Only published products that are not archived are visible to customers.</p>

      <div className="office-staff-toolbar">
        <form className="office-staff-search" role="search" onSubmit={handleSearch}>
          <label className="visually-hidden" htmlFor="product-search">
            Search by name, SKU or brand
          </label>
          <input
            id="product-search"
            className="field-input"
            type="search"
            placeholder="Search by name, SKU or brand"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={100}
          />
          <button type="submit" className="button button-secondary">
            Search
          </button>
        </form>
        <div className="office-staff-filter">
          <label className="visually-hidden" htmlFor="product-category-filter">
            Category
          </label>
          <select
            id="product-category-filter"
            className="field-input"
            value={categoryId}
            onChange={(event) => {
              filterChanged()
              setCategoryId(event.target.value)
            }}
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <label className="visually-hidden" htmlFor="product-status-filter">
            Status
          </label>
          <select
            id="product-status-filter"
            className="field-input"
            value={status}
            onChange={(event) => {
              filterChanged()
              setStatus(event.target.value as StatusFilter)
            }}
          >
            <option value="">All statuses</option>
            <option value="published">Published</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
          <Link className="button button-primary" to={`${PRODUCTS_PATH}/new`}>
            Add product
          </Link>
        </div>
      </div>

      <div className="office-reset-status" role="status">
        {notice}
      </div>

      {list.status === 'loading' && <p className="office-reset-empty">Loading products…</p>}
      {list.status === 'error' && (
        <div className="office-error" role="alert">
          {list.message}
        </div>
      )}
      {list.status === 'ready' && list.data.products.length === 0 && (
        <p className="office-reset-empty">No products match.</p>
      )}

      {list.status === 'ready' && list.data.products.length > 0 && (
        <>
          {!compact && (
            <div className="office-staff-table-wrap">
              <table className="office-staff-table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Category</th>
                    <th scope="col">Price (TZS)</th>
                    <th scope="col">Stock</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.products.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <span className="office-product-cell">
                          <Thumb product={product} />
                          <span>
                            <span className="office-staff-name">{product.name}</span>
                            {product.brand && <span className="office-staff-meta">{product.brand}</span>}
                          </span>
                        </span>
                      </td>
                      <td>{product.sku}</td>
                      <td>{product.categoryName}</td>
                      <td className="office-number">{priceText(product)}</td>
                      <td>
                        {STOCK_LABELS[product.stockStatus]} ({product.quantityInStock})
                      </td>
                      <td>
                        <StatusBadge status={product.status} />
                      </td>
                      <td>
                        <Link
                          className="button button-secondary"
                          to={`${PRODUCTS_PATH}/${product.id}`}
                          aria-label={`Edit ${product.name}`}
                        >
                          Edit
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {compact && (
            <ul className="office-staff-cards">
              {list.data.products.map((product) => (
                <li key={product.id} className="office-staff-card">
                  <span className="office-product-cell">
                    <Thumb product={product} />
                    <span>
                      <span className="office-staff-name">{product.name}</span>
                      <span className="office-staff-meta">SKU {product.sku}</span>
                    </span>
                  </span>
                  <dl className="office-staff-facts">
                    <div>
                      <dt>Category</dt>
                      <dd>{product.categoryName}</dd>
                    </div>
                    <div>
                      <dt>Price</dt>
                      <dd>{product.requestQuotation ? 'Quotation' : `TZS ${priceText(product)}`}</dd>
                    </div>
                    <div>
                      <dt>Stock</dt>
                      <dd>
                        {STOCK_LABELS[product.stockStatus]} ({product.quantityInStock})
                      </dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <StatusBadge status={product.status} />
                      </dd>
                    </div>
                  </dl>
                  <div className="office-reset-actions">
                    <Link
                      className="button button-secondary"
                      to={`${PRODUCTS_PATH}/${product.id}`}
                      aria-label={`Edit ${product.name}`}
                    >
                      Edit
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <nav className="office-staff-paging" aria-label="Product pages">
            <span>
              {list.data.total} {list.data.total === 1 ? 'product' : 'products'}
            </span>
            {totalPages > 1 && (
              <span className="office-reset-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </button>
              </span>
            )}
          </nav>
        </>
      )}
    </>
  )
}

import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { apiRequest, apiUrl, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'
import { PRODUCTS_PATH, TZS, useCategories, type Product, type StockStatus } from './ProductForm'

type Counts = { all: number; in_stock: number; low_stock: number; out_of_stock: number }
type ProductsPage = { products: Product[]; total: number; page: number; pageSize: number; counts: Counts }
type StockTab = '' | StockStatus
type StatusFilter = '' | 'draft' | 'published' | 'archived'

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: ProductsPage }

const NOTICE_MS = 5000
const SEARCH_DEBOUNCE_MS = 300

const TABS: { key: StockTab; label: string; count: keyof Counts }[] = [
  { key: '', label: 'All products', count: 'all' },
  { key: 'in_stock', label: 'In stock', count: 'in_stock' },
  { key: 'low_stock', label: 'Low stock', count: 'low_stock' },
  { key: 'out_of_stock', label: 'Out of stock', count: 'out_of_stock' },
]

const STOCK_LABELS: Record<StockStatus, string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
}
const STATUS_LABELS: Record<Product['status'], string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
}

// Phones get a card list instead of a table. Only one layout is rendered.
const COMPACT_QUERY = '(max-width: 900px)'

function subscribeToCompact(onChange: () => void) {
  const query = window.matchMedia(COMPACT_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function errorText(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

// ---------- icons (line icons, currentColor) ----------

function Svg({ children, size = 18 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const SearchIcon = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Svg>
)
const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
const MinusIcon = () => (
  <Svg size={16}>
    <path d="M5 12h14" />
  </Svg>
)
const SmallPlusIcon = () => (
  <Svg size={16}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
const PencilIcon = () => (
  <Svg>
    <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
    <path d="M14.5 6.5l3 3" />
  </Svg>
)
const CloseIcon = () => (
  <Svg size={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

function priceText(product: Product) {
  if (product.requestQuotation) return 'On request'
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

function Badges({ product }: { product: Product }) {
  return (
    <span className="office-badges">
      <span className={`office-stock office-stock-${product.stockStatus} is-current`}>
        {STOCK_LABELS[product.stockStatus]}
      </span>
      <span className={`office-status office-status-${product.status}`}>{STATUS_LABELS[product.status]}</span>
    </span>
  )
}

function Stepper({ product, busy, onStep }: { product: Product; busy: boolean; onStep: (delta: -1 | 1) => void }) {
  return (
    <span className="office-stepper">
      <button
        type="button"
        className="office-stepper-button"
        aria-label={`Decrease stock of ${product.name}`}
        disabled={busy || product.quantityInStock <= 0}
        onClick={() => onStep(-1)}
      >
        <MinusIcon />
      </button>
      <output className="office-stepper-value" aria-label={`Stock of ${product.name}`}>
        {product.quantityInStock}
      </output>
      <button
        type="button"
        className="office-stepper-button"
        aria-label={`Increase stock of ${product.name}`}
        disabled={busy}
        onClick={() => onStep(1)}
      >
        <SmallPlusIcon />
      </button>
    </span>
  )
}

function EditLink({ product }: { product: Product }) {
  return (
    <Link
      className="office-icon-action"
      to={`${PRODUCTS_PATH}/${product.id}`}
      aria-label={`Edit ${product.name}`}
      title="Edit"
    >
      <PencilIcon />
    </Link>
  )
}

// /office/products: stock tabs with counts, search, category and status filters, paged.
export default function ProductsList() {
  const compact = useSyncExternalStore(subscribeToCompact, () => window.matchMedia(COMPACT_QUERY).matches)
  const { categories } = useCategories()
  const location = useLocation()
  const navigate = useNavigate()

  // The success message from the page that just saved. It goes away on its own, can be
  // closed, and is dropped from the history entry so a reload does not bring it back.
  const [notice, setNotice] = useState<string | null>(
    () => (location.state as { notice?: string } | null)?.notice ?? null,
  )

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [tab, setTab] = useState<StockTab>('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [stepping, setStepping] = useState<string[]>([])
  const [stepError, setStepError] = useState<string | null>(null)

  useEffect(() => {
    if ((location.state as { notice?: string } | null)?.notice) {
      navigate(location.pathname, { replace: true, state: null })
    }
    // Runs once, for the state this visit arrived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  // Search as you type, after a short pause.
  useEffect(() => {
    const trimmed = search.trim()
    if (trimmed === query) return
    const timer = window.setTimeout(() => {
      setNotice(null)
      setList({ status: 'loading' })
      setPage(1)
      setQuery(trimmed)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search, query])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ page: String(page) })
    if (query) params.set('q', query)
    if (categoryId) params.set('categoryId', categoryId)
    if (status) params.set('status', status)
    if (tab) params.set('stock', tab)

    apiRequest<ProductsPage>(`/api/office/products?${params}`, { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setList({ status: 'ready', data: result.data })
        else setList({ status: 'error', message: errorText(result) })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [query, categoryId, status, tab, page, reload])

  function filtersChanged() {
    setNotice(null)
    setStepError(null)
    setList({ status: 'loading' })
    setPage(1)
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (search.trim() !== query) {
      filtersChanged()
      setQuery(search.trim())
    }
  }

  function goToPage(next: number) {
    setList({ status: 'loading' })
    setPage(next)
  }

  async function step(product: Product, delta: -1 | 1) {
    const next = Math.max(0, product.quantityInStock + delta)
    if (next === product.quantityInStock || stepping.includes(product.id)) return
    setStepError(null)
    setStepping((current) => [...current, product.id])
    const result = await apiRequest<{ product: Product }>(`/api/office/products/${product.id}`, {
      method: 'PATCH',
      body: { quantityInStock: next },
    })
    setStepping((current) => current.filter((id) => id !== product.id))
    if (!result.ok) {
      setStepError(errorText(result))
      return
    }
    setList((current) =>
      current.status === 'ready'
        ? {
            status: 'ready',
            data: {
              ...current.data,
              products: current.data.products.map((item) => (item.id === product.id ? result.data.product : item)),
            },
          }
        : current,
    )
    // The tab counts (and the tab's own contents) depend on the quantity.
    setReload((value) => value + 1)
  }

  const totalPages = list.status === 'ready' ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1

  return (
    <>
      <div className="office-product-head">
        <div className="office-product-heading">
          <h1 className="office-title">Products</h1>
          <p className="office-lead">Change a quantity with − and + to see the stock status update</p>
        </div>
        <div className="office-product-actions">
          <Link className="button button-primary" to={`${PRODUCTS_PATH}/new`}>
            <PlusIcon />
            Add product
          </Link>
        </div>
      </div>

      {notice && (
        <div className="office-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="office-notice-close"
            aria-label="Dismiss message"
            onClick={() => setNotice(null)}
          >
            <CloseIcon />
          </button>
        </div>
      )}

      <section className="office-list-card" aria-label="Products">
        <div className="office-tabs" role="group" aria-label="Stock level">
          {TABS.map((item) => (
            <button
              key={item.key || 'all'}
              type="button"
              className={tab === item.key ? 'office-tab is-active' : 'office-tab'}
              aria-pressed={tab === item.key}
              onClick={() => {
                filtersChanged()
                setTab(item.key)
              }}
            >
              {item.label}
              {list.status === 'ready' && <span className="office-tab-count">{list.data.counts[item.count]}</span>}
            </button>
          ))}
        </div>

        <div className="office-list-filters">
          <form className="office-search" role="search" onSubmit={handleSearch}>
            <span className="office-search-icon">
              <SearchIcon />
            </span>
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
          </form>
          <label className="visually-hidden" htmlFor="product-category-filter">
            Category
          </label>
          <select
            id="product-category-filter"
            className="field-input"
            value={categoryId}
            onChange={(event) => {
              filtersChanged()
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
            Visibility
          </label>
          <select
            id="product-status-filter"
            className="field-input"
            value={status}
            onChange={(event) => {
              filtersChanged()
              setStatus(event.target.value as StatusFilter)
            }}
          >
            <option value="">All visibility</option>
            <option value="published">Published</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {stepError && (
          <div className="office-error office-list-error" role="alert">
            {stepError}
          </div>
        )}
        {list.status === 'loading' && (
          <ul className="office-skeleton" aria-busy="true" aria-label="Loading products">
            {[0, 1, 2, 3].map((n) => (
              <li key={n} className="office-skeleton-row" />
            ))}
          </ul>
        )}
        {list.status === 'error' && (
          <>
            <div className="office-error office-list-error" role="alert">
              {list.message}
            </div>
            <button
              type="button"
              className="button button-secondary office-retry"
              onClick={() => {
                setList({ status: 'loading' })
                setReload((value) => value + 1)
              }}
            >
              Try again
            </button>
          </>
        )}
        {list.status === 'ready' && list.data.products.length === 0 && (
          <p className="office-reset-empty office-list-empty">No products match.</p>
        )}

        {list.status === 'ready' && list.data.products.length > 0 && (
          <>
            {!compact && (
              <div className="office-staff-table-wrap">
                <table className="office-staff-table">
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th scope="col">Category</th>
                      <th scope="col">Price (TZS)</th>
                      <th scope="col">Stock quantity</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="office-col-actions">
                        Actions
                      </th>
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
                              <span className="office-staff-meta">
                                {product.sku}
                                {product.brand ? ` · ${product.brand}` : ''}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td>{product.categoryName}</td>
                        <td className="office-number">{priceText(product)}</td>
                        <td>
                          <Stepper
                            product={product}
                            busy={stepping.includes(product.id)}
                            onStep={(delta) => void step(product, delta)}
                          />
                        </td>
                        <td>
                          <Badges product={product} />
                        </td>
                        <td className="office-col-actions">
                          <EditLink product={product} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compact && (
              <ul className="office-staff-cards office-list-cards">
                {list.data.products.map((product) => (
                  <li key={product.id} className="office-staff-card">
                    <span className="office-product-cell">
                      <Thumb product={product} />
                      <span>
                        <span className="office-staff-name">{product.name}</span>
                        <span className="office-staff-meta">
                          {product.sku}
                          {product.brand ? ` · ${product.brand}` : ''}
                        </span>
                      </span>
                    </span>
                    <dl className="office-staff-facts">
                      <div>
                        <dt>Category</dt>
                        <dd>{product.categoryName}</dd>
                      </div>
                      <div>
                        <dt>Price</dt>
                        <dd>{product.requestQuotation ? 'On request' : `TZS ${priceText(product)}`}</dd>
                      </div>
                      <div>
                        <dt>Stock</dt>
                        <dd>
                          <Stepper
                            product={product}
                            busy={stepping.includes(product.id)}
                            onStep={(delta) => void step(product, delta)}
                          />
                        </dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>
                          <Badges product={product} />
                        </dd>
                      </div>
                    </dl>
                    <div className="office-card-actions">
                      <EditLink product={product} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <nav className="office-staff-paging office-list-footer" aria-label="Product pages">
              <span>
                Showing {list.data.products.length} of {list.data.total}{' '}
                {list.data.total === 1 ? 'product' : 'products'} · status updates automatically from the quantity (0 =
                out of stock, at or below the alert level = low stock)
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
      </section>
    </>
  )
}

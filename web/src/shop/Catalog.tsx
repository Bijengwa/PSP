import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  SORTS,
  catalogSearch,
  errorText,
  getProducts,
  isSort,
  useShopCategories,
  type CatalogQuery,
  type ShopProductsPage,
} from './api'
import { IconAlert, IconChevronLeft, IconChevronRight, IconSearch } from './Icons'
import PageMeta from './PageMeta'
import ProductCard, { ProductCardSkeleton } from './ProductCard'

const SEARCH_DEBOUNCE_MS = 300
const SKELETON_CARDS = 8

const toTop = () => window.scrollTo(0, 0)

// The filters live in the URL (?q=&category=&sort=&page=), so links, reloads and
// the back button all work.
function readQuery(params: URLSearchParams): CatalogQuery {
  const sort = params.get('sort')
  return {
    q: (params.get('q') ?? '').trim(),
    category: params.get('category') ?? '',
    sort: isSort(sort) ? sort : 'newest',
    page: Math.max(1, Number.parseInt(params.get('page') ?? '', 10) || 1),
  }
}

type Answer = { key: string } & ({ ok: true; data: ShopProductsPage } | { ok: false; message: string })

// /products: category chips, search as you type, sort and paging.
export default function Catalog() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const query = readQuery(params)
  const { q, category, sort, page } = query
  const categories = useShopCategories()

  // ---------- search box: typed text goes to the URL after a short pause ----------
  const [term, setTerm] = useState(q)
  const [seenQ, setSeenQ] = useState(q)
  if (q !== seenQ) {
    // The URL changed from elsewhere (back button, header search): show it.
    setSeenQ(q)
    if (term.trim() !== q) setTerm(q)
  }

  useEffect(() => {
    const next = term.trim()
    if (next === q) return
    const timer = window.setTimeout(() => {
      // The first search is its own history entry; refining it is not.
      navigate({ search: catalogSearch({ q: next, category, sort, page: 1 }) }, { replace: q !== '' })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [term, q, category, sort, navigate])

  // ---------- products ----------
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const key = `${q}\n${category}\n${sort}\n${page}\n${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    getProducts({ q, category, sort, page }, controller.signal).then(
      (result) =>
        setAnswer(result.ok ? { key, ok: true, data: result.data } : { key, ok: false, message: errorText(result) }),
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [key, q, category, sort, page])

  const current = answer?.key === key ? answer : null
  const data = current?.ok ? current.data : null
  const filtered = Boolean(q || category)
  const activeCategory = categories.categories.find((item) => item.slug === category)
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const to = (changes: Partial<CatalogQuery>) => ({ search: catalogSearch({ ...query, page: 1, ...changes }) })

  const heading = activeCategory?.name ?? 'All products'

  return (
    <div className="shop-container shop-catalog">
      <PageMeta
        title={`${heading}${q ? `: “${q}”` : ''}${page > 1 ? ` (page ${page})` : ''}`}
        description={`${activeCategory ? activeCategory.name : 'Medical equipment'} from PSP Engineering Group: prices in TZS, live stock and delivery across Tanzania.`}
      />
      <div className="shop-catalog-head">
        <h1>{heading}</h1>
        <p className="shop-catalog-count" role="status">
          {data && data.total > 0 && data.products.length > 0
            ? `Showing ${(data.page - 1) * data.pageSize + 1}–${(data.page - 1) * data.pageSize + data.products.length} of ${data.total} ${data.total === 1 ? 'product' : 'products'}`
            : data
              ? 'No products to show'
              : current
                ? ''
                : 'Loading products…'}
        </p>
      </div>

      <div className="shop-catalog-tools">
        <label className="shop-catalog-search">
          <IconSearch size={18} />
          <span className="shop-visually-hidden">Search products</span>
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search by name, brand or SKU"
            autoComplete="off"
            enterKeyHint="search"
          />
        </label>
        <label className="shop-catalog-sort">
          <span>Sort</span>
          <select
            value={sort}
            onChange={(event) => navigate(to({ sort: isSort(event.target.value) ? event.target.value : 'newest' }))}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <nav className="shop-chips" aria-label="Categories">
        {categories.loading ? (
          <ul aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => (
              <li key={index}>
                <span className="shop-chip shop-chip-skeleton" />
              </li>
            ))}
          </ul>
        ) : (
          <ul>
            <li>
              <Link to={to({ category: '' })} className="shop-chip" aria-current={category ? undefined : 'page'}>
                All
              </Link>
            </li>
            {categories.categories.map((item) => (
              <li key={item.slug}>
                <Link
                  to={to({ category: item.slug })}
                  className="shop-chip"
                  aria-current={item.slug === category ? 'page' : undefined}
                >
                  {item.name}
                  <span className="shop-chip-count">{item.productCount}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>

      {current && !current.ok ? (
        <div className="shop-state" role="alert">
          <span className="shop-state-icon shop-state-icon-error">
            <IconAlert size={24} />
          </span>
          <h2>Something went wrong</h2>
          <p>{current.message}</p>
          <button type="button" className="shop-button shop-button-primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <ul className="shop-grid" aria-busy="true" aria-label="Loading products">
          {Array.from({ length: SKELETON_CARDS }, (_, index) => (
            <li key={index}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ul>
      ) : data.products.length === 0 ? (
        <div className="shop-state">
          <span className="shop-state-icon">
            <IconSearch size={24} />
          </span>
          {data.total > 0 ? (
            <>
              <h2>This page is empty</h2>
              <p>There are fewer products than this page number.</p>
              <Link to={to({})} className="shop-button shop-button-secondary">
                Go to the first page
              </Link>
            </>
          ) : filtered ? (
            <>
              <h2>No products match</h2>
              <p>
                {q ? `Nothing found for “${q}”` : 'Nothing in this category yet'}
                {q && activeCategory ? ` in ${activeCategory.name}` : ''}. Try another word or category.
              </p>
              <Link to="/products" className="shop-button shop-button-secondary">
                Clear filters
              </Link>
            </>
          ) : (
            <>
              <h2>No products yet</h2>
              <p>Our online catalogue is being updated. Contact us for prices and availability.</p>
              <Link to="/#contact" className="shop-button shop-button-secondary">
                Contact us
              </Link>
            </>
          )}
        </div>
      ) : (
        <>
          <ul className="shop-grid">
            {data.products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>

          {pages > 1 && (
            <nav className="shop-pager" aria-label="Pages">
              {page > 1 ? (
                <Link to={to({ page: page - 1 })} className="shop-pager-link" rel="prev" onClick={toTop}>
                  <IconChevronLeft />
                  Previous
                </Link>
              ) : (
                <span className="shop-pager-link" aria-disabled="true">
                  <IconChevronLeft />
                  Previous
                </span>
              )}
              <span className="shop-pager-status">
                Page {page} of {pages}
              </span>
              {page < pages ? (
                <Link to={to({ page: page + 1 })} className="shop-pager-link" rel="next" onClick={toTop}>
                  Next
                  <IconChevronRight />
                </Link>
              ) : (
                <span className="shop-pager-link" aria-disabled="true">
                  Next
                  <IconChevronRight />
                </span>
              )}
            </nav>
          )}
        </>
      )}
    </div>
  )
}

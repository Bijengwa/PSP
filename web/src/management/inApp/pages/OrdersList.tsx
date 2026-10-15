import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Link } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'
import { phoneText } from './CustomersList'
import { TZS } from './ProductForm'

export type OrderStatus = 'new' | 'confirmed' | 'delivered' | 'closed' | 'cancelled'
export type PaymentStatus = 'unpaid' | 'paid'
export type OrderSource = 'shop' | 'staff'

export const ORDERS_PATH = '/office/orders'

export type OrderRow = {
  id: string
  orderNumber: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  source: OrderSource
  customerId: string | null
  guestName: string
  guestPhone: string
  deliveryArea: string
  totalTzs: number
  hasQuotationLines: boolean
  itemCount: number
  createdAt: string
}

type Counts = Record<'all' | OrderStatus, number>
type OrdersPage = { orders: OrderRow[]; total: number; page: number; pageSize: number; counts: Counts }
type StatusTab = '' | OrderStatus

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: OrdersPage }

const SEARCH_DEBOUNCE_MS = 300

const TABS: { key: StatusTab; label: string; count: keyof Counts }[] = [
  { key: '', label: 'All orders', count: 'all' },
  { key: 'new', label: 'New', count: 'new' },
  { key: 'confirmed', label: 'Confirmed', count: 'confirmed' },
  { key: 'delivered', label: 'Delivered', count: 'delivered' },
  { key: 'closed', label: 'Closed', count: 'closed' },
  { key: 'cancelled', label: 'Cancelled', count: 'cancelled' },
]

const STATUS_LABELS: Record<OrderStatus, string> = {
  new: 'New',
  confirmed: 'Confirmed',
  delivered: 'Delivered',
  closed: 'Closed',
  cancelled: 'Cancelled',
}
const PAYMENT_LABELS: Record<PaymentStatus, string> = { unpaid: 'Unpaid', paid: 'Paid' }
const SOURCE_LABELS: Record<OrderSource, string> = { shop: 'Shop', staff: 'Staff' }

// Also used by the order detail page.
// eslint-disable-next-line react-refresh/only-export-components
export const PLACED = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

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

const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

const SearchIcon = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Svg>
)

export function StatusBadge({ order }: { order: Pick<OrderRow, 'status'> }) {
  return <span className={`office-status office-order-${order.status}`}>{STATUS_LABELS[order.status]}</span>
}

export function PaymentBadge({ order }: { order: Pick<OrderRow, 'paymentStatus'> }) {
  return (
    <span className={`office-status office-payment-${order.paymentStatus}`}>{PAYMENT_LABELS[order.paymentStatus]}</span>
  )
}

function OrderCell({ order }: { order: OrderRow }) {
  return (
    <>
      <Link className="office-order-number office-staff-link" to={`${ORDERS_PATH}/${order.id}`}>
        {order.orderNumber}
      </Link>
      <span className="office-staff-meta office-number">{PLACED.format(new Date(order.createdAt))}</span>
      <span className="office-staff-meta">{SOURCE_LABELS[order.source]} order</span>
    </>
  )
}

function GuestCell({ order }: { order: OrderRow }) {
  return (
    <>
      <span className="office-staff-name">{order.guestName}</span>
      <span className="office-customer-phone office-staff-meta">{phoneText(order.guestPhone)}</span>
      <span className="office-staff-meta">{order.deliveryArea}</span>
    </>
  )
}

function itemsText(order: OrderRow) {
  return `${order.itemCount} ${order.itemCount === 1 ? 'item' : 'items'}`
}

// The total, with a note when some lines are priced on request (they are not in it).
function TotalCell({ order }: { order: OrderRow }) {
  const quoteOnly = order.hasQuotationLines && order.totalTzs === 0
  return (
    <>
      <span className="office-order-total">{quoteOnly ? 'Price on request' : `TZS ${TZS.format(order.totalTzs)}`}</span>
      {order.hasQuotationLines && !quoteOnly && <span className="office-staff-meta">+ items on request</span>}
    </>
  )
}

// /office/orders: the orders queue. Status tabs with counts, payment and source filters,
// search by order number, name or phone, paged, newest first.
export default function OrdersList() {
  const compact = useSyncExternalStore(subscribeToCompact, () => window.matchMedia(COMPACT_QUERY).matches)

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<StatusTab>('')
  const [payment, setPayment] = useState<'' | PaymentStatus>('')
  const [source, setSource] = useState<'' | OrderSource>('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [list, setList] = useState<ListState>({ status: 'loading' })

  // Search as you type, after a short pause.
  useEffect(() => {
    const trimmed = search.trim()
    if (trimmed === query) return
    const timer = window.setTimeout(() => {
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
    if (tab) params.set('status', tab)
    if (payment) params.set('paymentStatus', payment)
    if (source) params.set('source', source)

    apiRequest<OrdersPage>(`/api/office/orders?${params}`, { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setList({ status: 'ready', data: result.data })
        else setList({ status: 'error', message: errorText(result) })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [query, tab, payment, source, page, reload])

  // Any filter change starts again from page 1.
  function filtersChanged() {
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

  function clearFilters() {
    filtersChanged()
    setSearch('')
    setQuery('')
    setPayment('')
    setSource('')
  }

  function goToPage(next: number) {
    setList({ status: 'loading' })
    setPage(next)
  }

  const filtered = Boolean(query || payment || source)
  const totalPages = list.status === 'ready' ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1
  const nothingYet = list.status === 'ready' && list.data.counts.all === 0 && !filtered

  function emptyText() {
    if (query) return `No orders match “${query}”.`
    if (filtered) return 'No orders match these filters.'
    return tab ? `No ${STATUS_LABELS[tab].toLowerCase()} orders.` : 'No orders.'
  }

  return (
    <>
      <div className="office-product-head">
        <div className="office-product-heading">
          <h1 className="office-title">Orders</h1>
          <p className="office-lead">Shop and staff orders, newest first</p>
        </div>
        <div className="office-product-actions">
          <Link className="button button-primary" to={`${ORDERS_PATH}/new`}>
            <PlusIcon />
            New order
          </Link>
        </div>
      </div>

      <section className="office-list-card" aria-label="Orders">
        <div className="office-tabs office-order-tabs" role="group" aria-label="Order status">
          {TABS.map((item) => (
            <button
              key={item.key || 'all'}
              type="button"
              className={tab === item.key ? 'office-tab is-active' : 'office-tab'}
              aria-pressed={tab === item.key}
              onClick={() => {
                if (tab === item.key) return
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
            <label className="visually-hidden" htmlFor="order-search">
              Search by order number, name or phone
            </label>
            <input
              id="order-search"
              className="field-input"
              type="search"
              placeholder="Order number, name or phone"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={100}
            />
          </form>
          <label className="visually-hidden" htmlFor="order-payment-filter">
            Payment
          </label>
          <select
            id="order-payment-filter"
            className="field-input"
            value={payment}
            onChange={(event) => {
              filtersChanged()
              setPayment(event.target.value as '' | PaymentStatus)
            }}
          >
            <option value="">All payments</option>
            <option value="unpaid">Unpaid</option>
            <option value="paid">Paid</option>
          </select>
          <label className="visually-hidden" htmlFor="order-source-filter">
            Source
          </label>
          <select
            id="order-source-filter"
            className="field-input"
            value={source}
            onChange={(event) => {
              filtersChanged()
              setSource(event.target.value as '' | OrderSource)
            }}
          >
            <option value="">All sources</option>
            <option value="shop">Shop</option>
            <option value="staff">Staff</option>
          </select>
        </div>

        {list.status === 'loading' && (
          <ul className="office-skeleton" aria-busy="true" aria-label="Loading orders">
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
        {list.status === 'ready' && list.data.orders.length === 0 && (
          <div className="office-list-empty office-customer-empty">
            {nothingYet ? (
              <p className="office-reset-empty">No orders yet. Orders placed in the shop appear here.</p>
            ) : (
              <>
                <p className="office-reset-empty">{emptyText()}</p>
                {filtered && (
                  <button type="button" className="button button-secondary" onClick={clearFilters}>
                    Clear filters
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {list.status === 'ready' && list.data.orders.length > 0 && (
          <>
            {!compact && (
              <div className="office-staff-table-wrap">
                <table className="office-staff-table office-orders-table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Customer</th>
                      <th scope="col" className="office-col-total">
                        Total
                      </th>
                      <th scope="col">Status</th>
                      <th scope="col">Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.orders.map((order) => (
                      <tr key={order.id}>
                        <td>
                          <OrderCell order={order} />
                        </td>
                        <td>
                          <GuestCell order={order} />
                        </td>
                        <td className="office-col-total">
                          <TotalCell order={order} />
                          <span className="office-staff-meta">{itemsText(order)}</span>
                        </td>
                        <td>
                          <StatusBadge order={order} />
                        </td>
                        <td>
                          <PaymentBadge order={order} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compact && (
              <ul className="office-staff-cards office-list-cards">
                {list.data.orders.map((order) => (
                  <li key={order.id} className="office-staff-card office-order-card">
                    <div className="office-order-card-head">
                      <span>
                        <OrderCell order={order} />
                      </span>
                      <StatusBadge order={order} />
                    </div>
                    <dl className="office-staff-facts">
                      <div>
                        <dt>Customer</dt>
                        <dd className="office-customer-contacts">
                          <GuestCell order={order} />
                        </dd>
                      </div>
                      <div>
                        <dt>Total</dt>
                        <dd>
                          <TotalCell order={order} />
                          <span className="office-staff-meta">{itemsText(order)}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>Payment</dt>
                        <dd>
                          <PaymentBadge order={order} />
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}

            <nav className="office-staff-paging office-list-footer" aria-label="Order pages">
              <span>
                Showing {list.data.orders.length} of {list.data.total} {list.data.total === 1 ? 'order' : 'orders'}
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

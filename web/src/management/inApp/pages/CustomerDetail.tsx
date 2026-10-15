import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import { usePermission } from '../../auth/AuthProvider'
import { initials } from '../layout/ProfileMenu'
import { CUSTOMERS_PATH, type CustomerAddress, type CustomerRecord } from './CustomerForm'
import { displayName, phoneText } from './CustomersList'
import { ORDERS_PATH, PLACED, PaymentBadge, StatusBadge, type OrderRow } from './OrdersList'
import { TZS } from './ProductForm'

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; customer: CustomerRecord }

const NOTICE_MS = 5000
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function errorText(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

// ---------- icons (line icons, currentColor) ----------

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
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

const BackIcon = () => (
  <Svg size={16}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
)
const EditIcon = () => (
  <Svg>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Svg>
)
const BuildingIcon = ({ size = 18 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
    <path d="M15 9h4a1 1 0 0 1 1 1v11" />
    <path d="M8 8h3M8 12h3M8 16h3M3 21h18" />
  </Svg>
)
const PinIcon = () => (
  <Svg>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.3" />
  </Svg>
)
const CloseIcon = () => (
  <Svg size={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

function BackToCustomers() {
  return (
    <Link className="office-back-link" to={CUSTOMERS_PATH}>
      <BackIcon />
      Customers
    </Link>
  )
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="office-profile-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const notSet = <span className="office-profile-empty">Not set</span>

function AddressItem({ address }: { address: CustomerAddress }) {
  return (
    <li className="office-customer-address">
      <span className="office-customer-address-icon">
        <PinIcon />
      </span>
      <div className="office-customer-address-text">
        <p className="office-customer-address-label">
          <span>{address.label || address.area}</span>
          {address.isDefault && <span className="office-status office-status-active">Default</span>}
        </p>
        <p>{address.address}</p>
        {address.label && <p className="office-staff-meta">{address.area}</p>}
      </div>
    </li>
  )
}

type OrdersState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; orders: OrderRow[]; total: number; page: number }

const ordersUrl = (customerId: string, page: number) =>
  `/api/office/orders?${new URLSearchParams({ customerId, page: String(page) })}`

function orderTotal(order: OrderRow) {
  if (order.hasQuotationLines && order.totalTzs === 0) return 'Price on request'
  return `TZS ${TZS.format(order.totalTzs)}`
}

// The orders linked to this customer (M7.5), newest first, a page at a time.
function CustomerOrders({ customerId }: { customerId: string }) {
  const [state, setState] = useState<OrdersState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [more, setMore] = useState<{ working: boolean; error: string | null }>({ working: false, error: null })

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ orders: OrderRow[]; total: number; page: number }>(ordersUrl(customerId, 1), {
      signal: controller.signal,
    }).then(
      (result) =>
        setState(
          result.ok
            ? { status: 'ready', orders: result.data.orders, total: result.data.total, page: 1 }
            : { status: 'error', message: errorText(result) },
        ),
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [customerId, attempt])

  function retry() {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  async function showMore() {
    if (state.status !== 'ready' || more.working) return
    setMore({ working: true, error: null })
    const result = await apiRequest<{ orders: OrderRow[]; total: number }>(ordersUrl(customerId, state.page + 1))
    if (!result.ok) {
      setMore({ working: false, error: errorText(result) })
      return
    }
    setMore({ working: false, error: null })
    const seen = new Set(state.orders.map((order) => order.id))
    setState({
      status: 'ready',
      orders: [...state.orders, ...result.data.orders.filter((order) => !seen.has(order.id))],
      total: result.data.total,
      page: state.page + 1,
    })
  }

  return (
    <section className="office-card" aria-labelledby="customer-orders-heading">
      <h2 id="customer-orders-heading">Orders</h2>
      {state.status === 'ready' && state.total > 0 && (
        <p className="office-card-sub office-number">
          {state.total} {state.total === 1 ? 'order' : 'orders'}, newest first
        </p>
      )}

      {state.status === 'loading' && (
        <ul className="office-skeleton office-profile-skeleton" aria-busy="true" aria-label="Loading orders">
          {[0, 1].map((n) => (
            <li key={n} className="office-skeleton-row" />
          ))}
        </ul>
      )}

      {state.status === 'error' && (
        <>
          <div className="office-error" role="alert">
            {state.message}
          </div>
          <div className="office-reset-actions">
            <button type="button" className="button button-secondary" onClick={retry}>
              Try again
            </button>
          </div>
        </>
      )}

      {state.status === 'ready' && state.orders.length === 0 && (
        <p className="office-address-empty">
          No orders linked to this customer yet. A shop order is linked from its{' '}
          <Link className="office-staff-link" to={ORDERS_PATH}>
            order page
          </Link>
          .
        </p>
      )}

      {state.status === 'ready' && state.orders.length > 0 && (
        <>
          <ul className="office-customer-orders">
            {state.orders.map((order) => (
              <li key={order.id} className="office-customer-order">
                <span className="office-customer-order-main">
                  <Link className="office-order-number office-staff-link" to={`${ORDERS_PATH}/${order.id}`}>
                    {order.orderNumber}
                  </Link>
                  <span className="office-staff-meta office-number">
                    {PLACED.format(new Date(order.createdAt))} · {order.source === 'shop' ? 'Shop order' : 'Staff order'}
                  </span>
                </span>
                <span className="office-customer-order-end">
                  <span className="office-order-total">{orderTotal(order)}</span>
                  {order.hasQuotationLines && order.totalTzs > 0 && (
                    <span className="office-staff-meta">+ items on request</span>
                  )}
                  <span className="office-badges">
                    <StatusBadge order={order} />
                    <PaymentBadge order={order} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {state.orders.length < state.total && (
            <div className="office-customer-orders-more">
              <div className="office-error" role="alert" hidden={!more.error}>
                {more.error}
              </div>
              <button type="button" className="button button-secondary" onClick={showMore} disabled={more.working}>
                {more.working && <span className="spinner" aria-hidden="true" />}
                {more.working ? 'Loading…' : `Show more (${state.total - state.orders.length} left)`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

// /office/customers/:id: one customer's contacts, addresses, linked orders and notes.
export default function CustomerDetail() {
  const canEdit = usePermission('customers.edit')
  const { id = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()

  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  // "Changes saved." from the edit form. It goes away on its own, can be closed, and is
  // dropped from the history entry so a reload does not bring it back.
  const [notice, setNotice] = useState<string | null>(
    () => (location.state as { notice?: string } | null)?.notice ?? null,
  )

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

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ customer: CustomerRecord }>(`/api/office/customers/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    }).then(
      (result) => {
        if (result.ok) setLoad({ status: 'ready', customer: result.data.customer })
        else if (result.status === 404) setLoad({ status: 'missing' })
        else setLoad({ status: 'error', message: errorText(result) })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [id, attempt])

  function retry() {
    setLoad({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  if (load.status === 'loading') {
    return (
      <div className="office-product-page office-customer-detail">
        <BackToCustomers />
        <ul className="office-skeleton office-profile-skeleton" aria-busy="true" aria-label="Loading customer">
          {[0, 1, 2].map((n) => (
            <li key={n} className="office-skeleton-row" />
          ))}
        </ul>
      </div>
    )
  }

  if (load.status === 'missing') {
    return (
      <div className="office-product-page office-customer-detail">
        <BackToCustomers />
        <h1 className="office-title">Customer not found</h1>
        <p className="office-lead">This customer does not exist, or the link is incomplete.</p>
        <div className="office-reset-actions">
          <Link className="button button-primary" to={CUSTOMERS_PATH}>
            Back to customers
          </Link>
        </div>
      </div>
    )
  }

  if (load.status === 'error') {
    return (
      <div className="office-product-page office-customer-detail">
        <BackToCustomers />
        <h1 className="office-title">Customer</h1>
        <div className="office-error" role="alert">
          {load.message}
        </div>
        <div className="office-reset-actions">
          <button type="button" className="button button-secondary" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const { customer } = load
  const company = customer.type === 'company'
  const name = displayName(customer)

  const contactRows: [string, ReactNode][] = [
    [
      'Phone',
      customer.phone ? (
        <a className="office-staff-link office-customer-phone" href={`tel:${customer.phone}`}>
          {phoneText(customer.phone)}
        </a>
      ) : (
        notSet
      ),
    ],
    [
      'Email',
      customer.email ? (
        <a className="office-staff-link" href={`mailto:${customer.email}`}>
          {customer.email}
        </a>
      ) : (
        notSet
      ),
    ],
  ]
  if (company) {
    contactRows.unshift(['Contact person', customer.contactPerson || notSet])
    contactRows.push(['TIN', customer.tin ? <span className="office-number">{customer.tin}</span> : notSet])
  }

  return (
    <div className="office-product-page office-customer-detail">
      <BackToCustomers />

      <div className="office-product-head">
        <div className="office-profile-head">
          {company ? (
            <span className="office-avatar office-avatar-large office-avatar-company" aria-hidden="true">
              <BuildingIcon size={28} />
            </span>
          ) : (
            <span className="office-avatar office-avatar-large" aria-hidden="true">
              {initials(name)}
            </span>
          )}
          <div className="office-profile-identity">
            <h1 className="office-title">{name}</h1>
            {company && customer.contactPerson && (
              <p className="office-profile-email">Contact: {customer.contactPerson}</p>
            )}
            <div className="office-badges">
              <span className={`office-status office-status-${customer.type}`}>{company ? 'Company' : 'Individual'}</span>
            </div>
          </div>
        </div>
        {canEdit && (
          <div className="office-product-actions">
            <Link className="button button-secondary" to={`${CUSTOMERS_PATH}/${customer.id}/edit`}>
              <EditIcon />
              Edit customer
            </Link>
          </div>
        )}
      </div>

      {notice && (
        <div className="office-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="office-notice-close" aria-label="Dismiss message" onClick={() => setNotice(null)}>
            <CloseIcon />
          </button>
        </div>
      )}

      <div className="office-product-grid">
        <div className="office-product-main">
          <section className="office-card" aria-labelledby="customer-contact-heading">
            <h2 id="customer-contact-heading">Contact</h2>
            <Facts rows={contactRows} />
          </section>

          <section className="office-card" aria-labelledby="customer-addresses-heading">
            <h2 id="customer-addresses-heading">Addresses</h2>
            {customer.addresses.length === 0 ? (
              <p className="office-address-empty">
                No addresses yet.{' '}
                {canEdit && (
                  <Link className="office-staff-link" to={`${CUSTOMERS_PATH}/${customer.id}/edit`}>
                    Add one
                  </Link>
                )}
              </p>
            ) : (
              <ul className="office-customer-addresses">
                {customer.addresses.map((address) => (
                  <AddressItem key={address.id} address={address} />
                ))}
              </ul>
            )}
          </section>

          <CustomerOrders customerId={customer.id} />
        </div>

        <div className="office-product-side">
          <section className="office-card" aria-labelledby="customer-notes-heading">
            <h2 id="customer-notes-heading">Notes</h2>
            <p className="office-card-sub">Only staff see these</p>
            {customer.notes ? (
              <p className="office-customer-notes-text">{customer.notes}</p>
            ) : (
              <p className="office-address-empty">No notes.</p>
            )}
          </section>

          <section className="office-card" aria-labelledby="customer-record-heading">
            <h2 id="customer-record-heading">Record</h2>
            <Facts
              rows={[
                ['Added', <span className="office-number">{DATE.format(new Date(customer.createdAt))}</span>],
                ['Last changed', <span className="office-number">{DATE_TIME.format(new Date(customer.updatedAt))}</span>],
              ]}
            />
          </section>
        </div>
      </div>
    </div>
  )
}

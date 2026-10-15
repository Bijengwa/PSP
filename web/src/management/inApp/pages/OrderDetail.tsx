import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import { usePermission } from '../../auth/AuthProvider'
import '../../auth/auth.css'
import { initials } from '../layout/ProfileMenu'
import { ORDERS_CHANGED } from '../layout/Sidebar'
import { Facts } from './CustomerDetail'
import { CUSTOMERS_PATH } from './CustomerForm'
import { displayName, phoneText, type Customer } from './CustomersList'
import {
  ORDERS_PATH,
  PLACED,
  PaymentBadge,
  StatusBadge,
  type OrderSource,
  type OrderStatus,
  type PaymentStatus,
} from './OrdersList'
import { TZS } from './ProductForm'

type OrderItem = {
  id: string
  productId: string
  productName: string
  productSku: string
  unitPriceTzs: number | null
  quantity: number
  lineTotalTzs: number | null
}

export type OrderDetailRecord = {
  id: string
  orderNumber: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  source: OrderSource
  customer: { id: string; type: 'individual' | 'company'; name: string } | null
  createdBy: { id: string; fullName: string } | null
  guestName: string
  guestPhone: string
  guestEmail: string | null
  deliveryArea: string
  deliveryAddress: string
  notes: string
  totalTzs: number
  hasQuotationLines: boolean
  cancelReason: string | null
  createdAt: string
  updatedAt: string
  confirmedAt: string | null
  deliveredAt: string | null
  closedAt: string | null
  cancelledAt: string | null
  paidAt: string | null
  nextStatuses: OrderStatus[]
  itemsEditable: boolean
  items: OrderItem[]
}

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; order: OrderDetailRecord }

type Action = 'confirmed' | 'delivered' | 'closed' | 'cancelled' | 'paid'
type DraftLine = { id: string; quantity: number }

const NOTICE_MS = 5000
const REASON_MAX = 500
const QUANTITY_MAX = 99

// What each action is called, what it asks, and what it says when done.
const ACTIONS: Record<Action, { button: string; question: (number: string) => string; text: string; done: string; working: string }> = {
  confirmed: {
    button: 'Confirm order',
    question: (number) => `Confirm order ${number}?`,
    text: 'Do this after checking the order with the customer. Once confirmed, its items and prices cannot change.',
    done: 'Order confirmed.',
    working: 'Confirming…',
  },
  delivered: {
    button: 'Mark delivered',
    question: (number) => `Mark ${number} as delivered?`,
    text: 'Use this when the customer has received everything on the order.',
    done: 'Marked as delivered.',
    working: 'Saving…',
  },
  closed: {
    button: 'Close order',
    question: (number) => `Close ${number}?`,
    text: 'A closed order is finished and cannot move again.',
    done: 'Order closed.',
    working: 'Closing…',
  },
  cancelled: {
    button: 'Cancel order',
    question: (number) => `Cancel ${number}?`,
    text: 'The order is kept with the reason below. This cannot be undone.',
    done: 'Order cancelled.',
    working: 'Cancelling…',
  },
  paid: {
    button: 'Mark paid',
    question: (number) => `Mark ${number} as paid?`,
    text: 'Record that PSP has received the full payment, on delivery, by invoice or by bank transfer. This cannot be undone.',
    done: 'Marked as paid.',
    working: 'Saving…',
  },
}

function errorText(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

const money = (value: number) => `TZS ${TZS.format(value)}`
const when = (value: string) => PLACED.format(new Date(value))

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
const CloseIcon = () => (
  <Svg size={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)
const CheckIcon = () => (
  <Svg>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)
const EditIcon = () => (
  <Svg>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Svg>
)
const MinusIcon = () => (
  <Svg size={16}>
    <path d="M6 12h12" />
  </Svg>
)
const PlusIcon = () => (
  <Svg size={16}>
    <path d="M12 6v12M6 12h12" />
  </Svg>
)
const TrashIcon = () => (
  <Svg size={16}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
)
const SearchIcon = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Svg>
)
const BuildingIcon = () => (
  <Svg>
    <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
    <path d="M15 9h4a1 1 0 0 1 1 1v11" />
    <path d="M8 8h3M8 12h3M8 16h3M3 21h18" />
  </Svg>
)
const LinkIcon = () => (
  <Svg size={16}>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
  </Svg>
)
const PersonPlusIcon = () => (
  <Svg>
    <circle cx="10" cy="8" r="3.5" />
    <path d="M3.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" />
  </Svg>
)

function BackToOrders() {
  return (
    <Link className="office-back-link" to={ORDERS_PATH}>
      <BackIcon />
      Orders
    </Link>
  )
}

const notGiven = <span className="office-profile-empty">Not given</span>

// The order's way through new → confirmed → delivered → closed, or to cancelled.
function Progress({ order }: { order: OrderDetailRecord }) {
  const steps: { label: string; at: string | null; note?: string }[] = [{ label: 'Placed', at: order.createdAt }]
  if (order.status === 'cancelled') {
    if (order.confirmedAt) steps.push({ label: 'Confirmed', at: order.confirmedAt })
    steps.push({ label: 'Cancelled', at: order.cancelledAt, note: order.cancelReason ?? undefined })
  } else {
    steps.push(
      { label: 'Confirmed', at: order.confirmedAt },
      { label: 'Delivered', at: order.deliveredAt },
      { label: 'Closed', at: order.closedAt },
    )
  }

  return (
    <ol className="office-order-steps">
      {steps.map((step) => {
        const cancelled = step.label === 'Cancelled'
        return (
          <li
            key={step.label}
            className={`office-order-step${step.at ? ' is-done' : ''}${cancelled ? ' is-cancelled' : ''}`}
          >
            <span className="office-order-step-mark" aria-hidden="true">
              {step.at && !cancelled && <CheckIcon />}
            </span>
            <span className="office-order-step-text">
              <span className="office-order-step-label">{step.label}</span>
              <span className="office-staff-meta office-number">{step.at ? when(step.at) : 'Not yet'}</span>
              {step.note && <span className="office-order-step-note">Reason: {step.note}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

type ItemsProps = {
  order: OrderDetailRecord
  draft: DraftLine[] | null
  onDraft: (draft: DraftLine[]) => void
}

// The order's lines. While `draft` is set (a new order being edited), quantities have
// steppers and lines a remove button, and the total follows the draft.
function ItemsTable({ order, draft, onDraft }: ItemsProps) {
  const byId = new Map(order.items.map((item) => [item.id, item]))
  const lines = draft ? draft.map((line) => ({ ...byId.get(line.id)!, quantity: line.quantity })) : order.items

  const priced = lines.filter((line) => line.unitPriceTzs !== null)
  const total = priced.reduce((sum, line) => sum + (line.unitPriceTzs ?? 0) * line.quantity, 0)
  const quoteLines = lines.length - priced.length

  function setQuantity(id: string, quantity: number) {
    if (!draft) return
    onDraft(draft.map((line) => (line.id === id ? { ...line, quantity } : line)))
  }

  return (
    <table className={`office-order-items${draft ? ' is-editing' : ''}`}>
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col" className="office-item-unit">
            Unit price
          </th>
          <th scope="col" className="office-item-qty">
            Qty
          </th>
          <th scope="col" className="office-item-total">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => {
          const unit = line.unitPriceTzs
          return (
            <tr key={line.id}>
              <td className="office-item-product">
                <span className="office-item-name">{line.productName}</span>
                <span className="office-item-sku">{line.productSku}</span>
                <span className="office-item-each office-staff-meta">
                  {unit === null ? 'Price on request' : `${money(unit)} each`}
                </span>
              </td>
              <td className="office-item-unit">
                {unit === null ? <span className="office-staff-meta">On request</span> : money(unit)}
              </td>
              <td className="office-item-qty">
                {draft ? (
                  <span className="office-item-edit">
                    <span className="office-stepper" role="group" aria-label={`Quantity of ${line.productName}`}>
                      <button
                        type="button"
                        className="office-stepper-button"
                        aria-label={`Fewer ${line.productName}`}
                        disabled={line.quantity <= 1}
                        onClick={() => setQuantity(line.id, line.quantity - 1)}
                      >
                        <MinusIcon />
                      </button>
                      <span className="office-stepper-value" aria-live="polite">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        className="office-stepper-button"
                        aria-label={`More ${line.productName}`}
                        disabled={line.quantity >= QUANTITY_MAX}
                        onClick={() => setQuantity(line.id, line.quantity + 1)}
                      >
                        <PlusIcon />
                      </button>
                    </span>
                    <button
                      type="button"
                      className="office-icon-action office-item-remove"
                      aria-label={`Remove ${line.productName}`}
                      disabled={draft.length <= 1}
                      onClick={() => onDraft(draft.filter((other) => other.id !== line.id))}
                    >
                      <TrashIcon />
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="office-item-qty-label">Qty </span>
                    {line.quantity}
                  </>
                )}
              </td>
              <td className="office-item-total">
                {unit === null ? (
                  <span className="office-staff-meta">Price on request</span>
                ) : (
                  <span className="office-order-total">{money(unit * line.quantity)}</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={3}>
            {draft ? 'New total' : 'Order total'}
          </th>
          <td className="office-item-total">
            <span className="office-order-total office-order-grand-total">
              {priced.length === 0 ? 'Price on request' : money(total)}
            </span>
            {quoteLines > 0 && priced.length > 0 && (
              <span className="office-staff-meta">
                + {quoteLines} {quoteLines === 1 ? 'item' : 'items'} on request
              </span>
            )}
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

// ---------- linking a shop order to a customer (M7.5) ----------

type CustomerMatch = Customer & { matchedOn: ('phone' | 'email')[] }
type Found<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T[] }

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MIN = 2
const SEARCH_SHOWN = 5

function matchText(match: CustomerMatch) {
  const on = match.matchedOn
  if (on.includes('phone') && on.includes('email')) return 'Same phone and email'
  return on.includes('phone') ? 'Same phone' : 'Same email'
}

function CustomerAvatar({ customer }: { customer: Pick<Customer, 'type'> & { name: string } }) {
  return customer.type === 'company' ? (
    <span className="office-avatar office-avatar-company" aria-hidden="true">
      <BuildingIcon />
    </span>
  ) : (
    <span className="office-avatar" aria-hidden="true">
      {initials(customer.name)}
    </span>
  )
}

// Customers who have the order's phone or email (the M6.3 duplicates check, which
// compares the stored forms the shop also uses).
function useMatches(order: OrderDetailRecord, enabled: boolean) {
  const [found, setFound] = useState<Found<CustomerMatch>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const params = new URLSearchParams({ phone: order.guestPhone })
    if (order.guestEmail) params.set('email', order.guestEmail)
    apiRequest<{ matches: CustomerMatch[] }>(`/api/office/customers/duplicates?${params}`, {
      signal: controller.signal,
    }).then(
      (result) =>
        setFound(result.ok ? { status: 'ready', items: result.data.matches } : { status: 'error', message: errorText(result) }),
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [order.guestPhone, order.guestEmail, enabled, attempt])

  function retry() {
    setFound({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  return { found, retry }
}

// The customer directory searched by name, company, phone or email, after a short pause.
function useCustomerSearch(q: string) {
  const [found, setFound] = useState<Found<Customer> | null>(null)
  const term = q.trim()

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (term.length < SEARCH_MIN) {
        setFound(null)
        return
      }
      setFound({ status: 'loading' })
      apiRequest<{ customers: Customer[] }>(`/api/office/customers?${new URLSearchParams({ q: term })}`, {
        signal: controller.signal,
      }).then(
        (result) =>
          setFound(
            result.ok
              ? { status: 'ready', items: result.data.customers.slice(0, SEARCH_SHOWN) }
              : { status: 'error', message: errorText(result) },
          ),
        () => {}, // aborted
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [term])

  return found
}

type LinkProps = {
  order: OrderDetailRecord
  onChanged: (order: OrderDetailRecord, notice: string) => void
  onRefused: () => void
}

// The "Customer record" card of a shop order: the linked customer with Unlink, or
// customers with the same phone or email, a search of the directory, and a way to
// create a customer from the order. Linking is undone with Unlink, so it does not ask
// first; creating a customer does.
function CustomerLinkCard({ order, onChanged, onRefused }: LinkProps) {
  const linked = order.customer
  const { found: matches, retry: retryMatches } = useMatches(order, !linked)
  const [q, setQ] = useState('')
  const results = useCustomerSearch(linked ? '' : q)

  const [working, setWorking] = useState<string | null>(null) // customer id, 'create' or 'unlink'
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const askRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // The button that was used is gone after a change, so focus moves to the card heading.
  const focusHeading = useRef(false)

  useLayoutEffect(() => {
    if (asking) askRef.current?.querySelector<HTMLElement>('button:last-child')?.focus()
  }, [asking])

  useLayoutEffect(() => {
    if (!focusHeading.current) return
    focusHeading.current = false
    headingRef.current?.focus()
  })

  const path = `/api/office/orders/${encodeURIComponent(order.id)}/customer`

  async function send(key: string, method: 'PUT' | 'POST' | 'DELETE', body: unknown, done: (order: OrderDetailRecord) => string) {
    if (working) return
    setWorking(key)
    setError(null)
    const result = await apiRequest<{ order: OrderDetailRecord }>(path, { method, body })
    setWorking(null)
    if (result.ok) {
      setAsking(false)
      setQ('')
      focusHeading.current = true
      onChanged(result.data.order, done(result.data.order))
      return
    }
    if (result.status === 409 || result.status === 404) {
      setAsking(false)
      setError(errorText(result))
      focusHeading.current = true
      onRefused()
      return
    }
    const field = (result.details as { customerId?: unknown } | undefined)?.customerId
    setError(typeof field === 'string' ? field : errorText(result))
  }

  const link = (customer: Customer) =>
    send(customer.id, 'PUT', { customerId: customer.id }, () => `Linked to ${displayName(customer)}.`)
  const create = () =>
    send('create', 'POST', undefined, (next) => `Customer ${next.customer?.name ?? ''} created and linked.`)
  const unlink = (name: string) => send('unlink', 'DELETE', undefined, () => `Unlinked from ${name}.`)

  // One customer that could be linked: who they are, how to reach them, and Link.
  function option(customer: Customer, note?: string) {
    const name = displayName(customer)
    const contacts = [customer.phone && phoneText(customer.phone), customer.email].filter(Boolean).join(' · ')
    const busy = working === customer.id
    return (
      <li key={customer.id} className="office-link-option">
        <CustomerAvatar customer={{ type: customer.type, name }} />
        <span className="office-link-option-text">
          <Link className="office-staff-name office-staff-link" to={`${CUSTOMERS_PATH}/${customer.id}`}>
            {name}
          </Link>
          <span className="office-staff-meta office-link-contacts">{contacts || 'No contact details'}</span>
          {note && <span className="office-status office-status-pending office-link-match">{note}</span>}
        </span>
        <button
          type="button"
          className="button button-secondary office-link-action"
          onClick={() => link(customer)}
          disabled={working !== null}
          aria-label={`Link to ${name}`}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : <LinkIcon />}
          {busy ? 'Linking…' : 'Link'}
        </button>
      </li>
    )
  }

  const errorBox = (
    <div className="office-error" role="alert" hidden={!error}>
      {error}
    </div>
  )

  if (linked) {
    return (
      <section className="office-card office-order-link" aria-labelledby="order-customer-heading">
        <h2 id="order-customer-heading" ref={headingRef} tabIndex={-1}>
          Customer record
        </h2>
        <p className="office-card-sub">This order is listed on the customer's page.</p>
        <div className="office-link-option office-link-current">
          <CustomerAvatar customer={linked} />
          <span className="office-link-option-text">
            <Link className="office-staff-name office-staff-link" to={`${CUSTOMERS_PATH}/${linked.id}`}>
              {linked.name}
            </Link>
            <span className="office-staff-meta">{linked.type === 'company' ? 'Company' : 'Individual'}</span>
          </span>
          <button
            type="button"
            className="button button-secondary office-link-action"
            onClick={() => unlink(linked.name)}
            disabled={working !== null}
          >
            {working === 'unlink' && <span className="spinner" aria-hidden="true" />}
            {working === 'unlink' ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
        {errorBox}
      </section>
    )
  }

  const matchIds = new Set(matches.status === 'ready' ? matches.items.map((m) => m.id) : [])

  return (
    <section className="office-card office-order-link" aria-labelledby="order-customer-heading">
      <h2 id="order-customer-heading">Customer record</h2>
      <p className="office-card-sub">
        <span className="office-profile-empty">Not linked.</span> Link this shop order to a customer so it is listed on
        their page.
      </p>

      <div className="office-link-group" role="group" aria-labelledby="order-matches-heading">
        <h3 id="order-matches-heading" className="office-link-heading">
          Same phone or email
        </h3>
        {matches.status === 'loading' && (
          <ul className="office-skeleton office-link-skeleton" aria-busy="true" aria-label="Looking for matching customers">
            <li className="office-skeleton-row" />
          </ul>
        )}
        {matches.status === 'error' && (
          <div className="office-link-error">
            <p className="office-address-empty">Matching customers could not be checked. {matches.message}</p>
            <button type="button" className="button button-secondary" onClick={retryMatches}>
              Try again
            </button>
          </div>
        )}
        {matches.status === 'ready' &&
          (matches.items.length === 0 ? (
            <p className="office-address-empty">No customer has this phone or email yet.</p>
          ) : (
            <ul className="office-link-list" aria-label="Matching customers">
              {matches.items.map((match) => option(match, matchText(match)))}
            </ul>
          ))}
      </div>

      <div className="office-link-group">
        <label className="office-link-heading" htmlFor="order-customer-search">
          Find another customer
        </label>
        <div className="office-search">
          <span className="office-search-icon">
            <SearchIcon />
          </span>
          <input
            id="order-customer-search"
            className="field-input"
            type="search"
            placeholder="Name, company, phone or email"
            autoComplete="off"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        {results?.status === 'loading' && (
          <ul className="office-skeleton office-link-skeleton" aria-busy="true" aria-label="Searching customers">
            <li className="office-skeleton-row" />
          </ul>
        )}
        {results?.status === 'error' && <p className="office-address-empty">{results.message}</p>}
        {results?.status === 'ready' &&
          (results.items.length === 0 ? (
            <p className="office-address-empty" role="status">
              No customers match “{q.trim()}”.
            </p>
          ) : (
            <ul className="office-link-list" aria-label="Search results">
              {results.items.map((customer) =>
                option(customer, matchIds.has(customer.id) ? 'Same phone or email' : undefined),
              )}
            </ul>
          ))}
      </div>

      {errorBox}

      {asking ? (
        <div className="office-confirm" role="group" aria-labelledby="order-create-question" ref={askRef}>
          <p id="order-create-question" className="office-confirm-question">
            Create a customer for {order.guestName}?
          </p>
          <p className="office-confirm-text">
            A new individual customer is added with this order's name, phone, email and delivery address, and the
            order is linked to it. You can edit the customer afterwards.
            {matches.status === 'ready' &&
              matches.items.length > 0 &&
              ` ${matches.items.length === 1 ? 'One customer already has' : `${matches.items.length} customers already have`} this phone or email.`}
          </p>
          <div className="office-reset-actions">
            <button type="button" className="button button-primary" onClick={create} disabled={working !== null}>
              {working === 'create' && <span className="spinner" aria-hidden="true" />}
              {working === 'create' ? 'Creating…' : 'Create and link'}
            </button>
            <button type="button" className="button button-secondary" onClick={() => setAsking(false)} disabled={working !== null}>
              Not now
            </button>
          </div>
        </div>
      ) : (
        <div className="office-link-create">
          <p className="office-address-empty">Not in the directory yet?</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setError(null)
              setAsking(true)
            }}
            disabled={working !== null}
          >
            <PersonPlusIcon />
            Create customer from this order
          </button>
        </div>
      )}
    </section>
  )
}

// /office/orders/:id: one order. Staff move it along its life cycle (confirm, deliver,
// close, or cancel with a reason), mark it paid, and, while it is still new, change
// quantities or drop lines. Every move asks once, because none can be undone.
export default function OrderDetail() {
  const { id = '' } = useParams()
  // Status, payment and items need orders.update; linking a customer needs orders.link
  // and, to create one from the order, customers.create (the server checks the same).
  const mayUpdate = usePermission('orders.update')
  const mayLink = usePermission('orders.link')

  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const [pending, setPending] = useState<Action | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [draft, setDraft] = useState<DraftLine[] | null>(null)
  const [savingItems, setSavingItems] = useState(false)
  const [itemsError, setItemsError] = useState<string | null>(null)

  const headingRef = useRef<HTMLHeadingElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  // Where focus goes after the next render (moved during the commit, before paint).
  const focusTo = useRef<'confirm' | 'heading' | 'edit' | null>(null)

  useLayoutEffect(() => {
    const target = focusTo.current
    if (!target) return
    focusTo.current = null
    if (target === 'confirm') confirmRef.current?.querySelector<HTMLElement>('textarea, button:last-child')?.focus()
    else if (target === 'edit') editButtonRef.current?.focus()
    else headingRef.current?.focus()
  })

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ order: OrderDetailRecord }>(`/api/office/orders/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    }).then(
      (result) => {
        if (result.ok) setLoad({ status: 'ready', order: result.data.order })
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

  // After a refusal (someone else moved the order first): show the order as it is now.
  async function refresh() {
    const result = await apiRequest<{ order: OrderDetailRecord }>(`/api/office/orders/${encodeURIComponent(id)}`)
    if (result.ok) setLoad({ status: 'ready', order: result.data.order })
  }

  function choose(action: Action) {
    setPending(action)
    setReason('')
    setReasonError(null)
    setError(null)
    setNotice(null)
    focusTo.current = 'confirm'
  }

  function closeConfirm() {
    setPending(null)
    setReasonError(null)
    setError(null)
    focusTo.current = 'heading'
  }

  async function run() {
    if (!pending || working) return
    if (pending === 'cancelled') {
      const text = reason.trim()
      if (!text) {
        setReasonError('Enter the reason for cancelling.')
        return
      }
      if (text.length > REASON_MAX) {
        setReasonError(`Use at most ${REASON_MAX} characters.`)
        return
      }
    }

    setWorking(true)
    setError(null)
    setReasonError(null)
    const path = `/api/office/orders/${encodeURIComponent(id)}`
    const result =
      pending === 'paid'
        ? await apiRequest<{ order: OrderDetailRecord }>(`${path}/paid`, { method: 'POST' })
        : await apiRequest<{ order: OrderDetailRecord }>(`${path}/status`, {
            method: 'POST',
            body: pending === 'cancelled' ? { status: pending, reason: reason.trim() } : { status: pending },
          })
    setWorking(false)

    if (result.ok) {
      setLoad({ status: 'ready', order: result.data.order })
      setNotice(ACTIONS[pending].done)
      setPending(null)
      window.dispatchEvent(new Event(ORDERS_CHANGED))
      focusTo.current = 'heading'
      return
    }
    const field = (result.details as { reason?: unknown } | undefined)?.reason
    if (result.status === 400 && typeof field === 'string') {
      setReasonError(field)
      return
    }
    if (result.status === 404) {
      setLoad({ status: 'missing' })
      return
    }
    setError(errorText(result))
    if (result.status === 409) {
      setPending(null)
      refresh()
    }
  }

  function startEditing(order: OrderDetailRecord) {
    setDraft(order.items.map((item) => ({ id: item.id, quantity: item.quantity })))
    setItemsError(null)
    setError(null)
    setNotice(null)
  }

  function stopEditing() {
    setDraft(null)
    setItemsError(null)
    focusTo.current = 'edit'
  }

  async function saveItems() {
    if (!draft || savingItems) return
    setSavingItems(true)
    setItemsError(null)
    const result = await apiRequest<{ order: OrderDetailRecord }>(`/api/office/orders/${encodeURIComponent(id)}/items`, {
      method: 'PUT',
      body: { items: draft },
    })
    setSavingItems(false)

    if (result.ok) {
      setLoad({ status: 'ready', order: result.data.order })
      setDraft(null)
      setNotice('Items saved.')
      focusTo.current = 'edit'
      return
    }
    if (result.status === 409) {
      // Confirmed by someone else meanwhile: the items are now fixed.
      setDraft(null)
      setError(errorText(result))
      refresh()
      return
    }
    // Nothing is lost: the draft stays for another try.
    setItemsError(result.status === 400 ? 'Some lines could not be saved. Reload the page and try again.' : errorText(result))
  }

  if (load.status === 'loading') {
    return (
      <div className="office-product-page office-customer-detail office-order-detail">
        <BackToOrders />
        <ul className="office-skeleton office-profile-skeleton" aria-busy="true" aria-label="Loading order">
          {[0, 1, 2].map((n) => (
            <li key={n} className="office-skeleton-row" />
          ))}
        </ul>
      </div>
    )
  }

  if (load.status === 'missing') {
    return (
      <div className="office-product-page office-customer-detail office-order-detail">
        <BackToOrders />
        <h1 className="office-title">Order not found</h1>
        <p className="office-lead">This order does not exist, or the link is incomplete.</p>
        <div className="office-reset-actions">
          <Link className="button button-primary" to={ORDERS_PATH}>
            Back to orders
          </Link>
        </div>
      </div>
    )
  }

  if (load.status === 'error') {
    return (
      <div className="office-product-page office-customer-detail office-order-detail">
        <BackToOrders />
        <h1 className="office-title">Order</h1>
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

  const { order } = load
  const forward = order.nextStatuses.find((status) => status !== 'cancelled') as Action | undefined
  const canCancel = order.nextStatuses.includes('cancelled')
  const canPay = order.paymentStatus === 'unpaid' && order.status !== 'cancelled'
  const showActions = mayUpdate && !pending && !draft && (forward || canCancel || canPay)
  const draftChanged =
    draft !== null &&
    (draft.length !== order.items.length ||
      draft.some((line) => order.items.find((item) => item.id === line.id)?.quantity !== line.quantity))

  const contactRows: [string, ReactNode][] = [
    ['Name', order.guestName],
    [
      'Phone',
      <a className="office-staff-link office-customer-phone" href={`tel:${order.guestPhone}`}>
        {phoneText(order.guestPhone)}
      </a>,
    ],
    [
      'Email',
      order.guestEmail ? (
        <a className="office-staff-link" href={`mailto:${order.guestEmail}`}>
          {order.guestEmail}
        </a>
      ) : (
        notGiven
      ),
    ],
    [
      'Deliver to',
      <span className="office-order-address">
        <span>{order.deliveryAddress}</span>
        <span className="office-staff-meta">{order.deliveryArea}</span>
      </span>,
    ],
  ]
  // A shop order's link has its own card below; a staff order has its customer from the start.
  if (order.source === 'staff') {
    contactRows.push([
      'Customer record',
      order.customer ? (
        <Link className="office-staff-link" to={`${CUSTOMERS_PATH}/${order.customer.id}`}>
          {order.customer.name}
        </Link>
      ) : (
        <span className="office-profile-empty">Not linked</span>
      ),
    ])
  }

  function customerChanged(next: OrderDetailRecord, message: string) {
    setLoad({ status: 'ready', order: next })
    setError(null)
    setNotice(message)
  }

  // Someone else linked or unlinked it meanwhile: the card shows why; show the order as it is now.
  function customerRefused() {
    setNotice(null)
    refresh()
  }

  const recordRows: [string, ReactNode][] = [
    ['Source', order.source === 'shop' ? 'Shop (guest checkout)' : 'Entered by staff'],
  ]
  if (order.createdBy) recordRows.push(['Entered by', order.createdBy.fullName])
  recordRows.push(['Last changed', <span className="office-number">{when(order.updatedAt)}</span>])

  const itemsNote = order.itemsEditable
    ? 'Quantities can change until the order is confirmed.'
    : order.status === 'cancelled'
      ? 'Kept as they were when the order was cancelled.'
      : 'Items and prices are fixed since the order was confirmed.'

  return (
    <div className="office-product-page office-customer-detail office-order-detail">
      <BackToOrders />

      <div className="office-product-head">
        <div className="office-profile-identity office-order-identity">
          <h1 className="office-title office-order-title" ref={headingRef} tabIndex={-1}>
            {order.orderNumber}
          </h1>
          <p className="office-profile-email office-number">
            Placed {when(order.createdAt)} · {order.source === 'shop' ? 'Shop order' : 'Staff order'}
          </p>
          <div className="office-badges">
            <StatusBadge order={order} />
            <PaymentBadge order={order} />
          </div>
        </div>
        {showActions && (
          <div className="office-product-actions office-order-actions">
            {forward && (
              <button type="button" className="button button-primary" onClick={() => choose(forward)}>
                {ACTIONS[forward].button}
              </button>
            )}
            {canPay && (
              <button type="button" className="button button-secondary" onClick={() => choose('paid')}>
                Mark paid
              </button>
            )}
            {canCancel && (
              <button type="button" className="button button-danger-outline" onClick={() => choose('cancelled')}>
                Cancel order
              </button>
            )}
          </div>
        )}
      </div>

      {pending && (
        <div className="office-confirm office-order-confirm" role="group" aria-labelledby="order-action-question" ref={confirmRef}>
          <p id="order-action-question" className="office-confirm-question">
            {ACTIONS[pending].question(order.orderNumber)}
          </p>
          <p className="office-confirm-text">
            {ACTIONS[pending].text}
            {pending === 'closed' && order.paymentStatus === 'unpaid' && ' It is still marked unpaid; you can mark it paid later.'}
          </p>
          {pending === 'cancelled' && (
            <div className="field">
              <label className="field-label" htmlFor="order-cancel-reason">
                Reason for cancelling
              </label>
              <textarea
                id="order-cancel-reason"
                className="field-input office-product-textarea"
                value={reason}
                maxLength={REASON_MAX}
                rows={3}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby={reasonError ? 'order-cancel-reason-error order-cancel-reason-count' : 'order-cancel-reason-count'}
                onChange={(event) => setReason(event.target.value)}
              />
              <p className="office-settings-hint office-number" id="order-cancel-reason-count">
                {reason.trim().length} / {REASON_MAX}
              </p>
              {reasonError && (
                <p className="field-error" id="order-cancel-reason-error" role="alert">
                  {reasonError}
                </p>
              )}
            </div>
          )}
          <div className="office-reset-actions">
            <button
              type="button"
              className={pending === 'cancelled' ? 'button button-danger' : 'button button-primary'}
              onClick={run}
              disabled={working}
            >
              {working && <span className="spinner" aria-hidden="true" />}
              {working ? ACTIONS[pending].working : ACTIONS[pending].button}
            </button>
            <button type="button" className="button button-secondary" onClick={closeConfirm} disabled={working}>
              {pending === 'cancelled' ? 'Keep order' : 'Not now'}
            </button>
          </div>
        </div>
      )}

      <div className="office-error" role="alert" hidden={!error}>
        {error}
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
          <section className="office-card" aria-labelledby="order-items-heading">
            <div className="office-profile-card-head">
              <h2 id="order-items-heading">Items</h2>
              {mayUpdate && order.itemsEditable && !draft && !pending && (
                <button ref={editButtonRef} type="button" className="button button-secondary" onClick={() => startEditing(order)}>
                  <EditIcon />
                  Edit items
                </button>
              )}
            </div>
            <p className="office-card-sub">{itemsNote}</p>
            <ItemsTable order={order} draft={draft} onDraft={setDraft} />
            {draft && (
              <>
                {draft.length === 1 && order.items.length > 0 && (
                  <p className="office-staff-meta office-order-items-hint">
                    An order keeps at least one line. To drop everything, cancel the order.
                  </p>
                )}
                <div className="office-error" role="alert" hidden={!itemsError}>
                  {itemsError}
                </div>
                <div className="office-reset-actions office-order-items-actions">
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={saveItems}
                    disabled={savingItems || !draftChanged}
                  >
                    {savingItems && <span className="spinner" aria-hidden="true" />}
                    {savingItems ? 'Saving…' : 'Save items'}
                  </button>
                  <button type="button" className="button button-secondary" onClick={stopEditing} disabled={savingItems}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="office-card" aria-labelledby="order-contact-heading">
            <h2 id="order-contact-heading">Customer and delivery</h2>
            <p className="office-card-sub">As given when the order was placed</p>
            <Facts rows={contactRows} />
          </section>

          {mayLink && order.source === 'shop' && (
            <CustomerLinkCard order={order} onChanged={customerChanged} onRefused={customerRefused} />
          )}
        </div>

        <div className="office-product-side">
          <section className="office-card" aria-labelledby="order-progress-heading">
            <h2 id="order-progress-heading">Progress</h2>
            <Progress order={order} />
          </section>

          <section className="office-card" aria-labelledby="order-payment-heading">
            <h2 id="order-payment-heading">Payment</h2>
            <Facts
              rows={[
                ['Status', <PaymentBadge order={order} />],
                order.paidAt
                  ? ['Paid', <span className="office-number">{when(order.paidAt)}</span>]
                  : ['Method', 'Pay later: on delivery, invoice or bank transfer'],
              ]}
            />
          </section>

          <section className="office-card" aria-labelledby="order-notes-heading">
            <h2 id="order-notes-heading">Notes</h2>
            {order.notes ? (
              <p className="office-customer-notes-text">{order.notes}</p>
            ) : (
              <p className="office-address-empty">No notes on this order.</p>
            )}
          </section>

          <section className="office-card" aria-labelledby="order-record-heading">
            <h2 id="order-record-heading">Record</h2>
            <Facts rows={recordRows} />
          </section>
        </div>
      </div>
    </div>
  )
}

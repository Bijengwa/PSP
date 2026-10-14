import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'
import { ORDERS_CHANGED } from '../layout/Sidebar'
import { Facts } from './CustomerDetail'
import { CUSTOMERS_PATH } from './CustomerForm'
import { phoneText } from './CustomersList'
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

// /office/orders/:id: one order. Staff move it along its life cycle (confirm, deliver,
// close, or cancel with a reason), mark it paid, and, while it is still new, change
// quantities or drop lines. Every move asks once, because none can be undone.
export default function OrderDetail() {
  const { id = '' } = useParams()

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
  const showActions = !pending && !draft && (forward || canCancel || canPay)
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
    [
      'Customer record',
      order.customer ? (
        <Link className="office-staff-link" to={`${CUSTOMERS_PATH}/${order.customer.id}`}>
          {order.customer.name}
        </Link>
      ) : (
        <span className="office-profile-empty">Not linked</span>
      ),
    ],
  ]

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
              {order.itemsEditable && !draft && !pending && (
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

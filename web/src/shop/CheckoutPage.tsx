import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import {
  formatTzs,
  getCartPrices,
  imageSrc,
  placeOrder,
  type CheckoutDetails,
  type PlacedOrder,
  type RefusedLine,
  type ShopProduct,
} from './api'
import { CheckoutSteps, type CartNotice } from './CartPage'
import { clearCart, readCart, useCart, type CartLine } from './cart'
import { IconAlert, IconArrow, IconCheck, IconChevronRight, IconDocument, IconImage, IconPhone, IconShield, IconTruck } from './Icons'

type Field = Exclude<keyof CheckoutDetails, 'website'>
type Errors = Partial<Record<Field, string>>

const FIELDS: Field[] = ['name', 'phone', 'email', 'area', 'address', 'notes']
const NOTES_MAX = 1000
const EMPTY: CheckoutDetails = { name: '', phone: '', email: '', area: '', address: '', notes: '', website: '' }

// What the person typed, kept in memory only (never stored), so a trip back to the
// cart after a refused line loses nothing. Cleared once the order is placed.
let draft: CheckoutDetails = EMPTY

function remember(details: CheckoutDetails) {
  draft = details
}

// Same rules as POST /api/shop/orders, so most mistakes are caught before sending.
const PHONE_PATTERN = /^(?:\+?255|0)?[267]\d{8}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const squash = (value: string) => value.trim().replace(/\s+/g, ' ')

function check(field: Field, details: CheckoutDetails): string | undefined {
  switch (field) {
    case 'name': {
      const length = squash(details.name).length
      if (length === 0) return 'Enter your full name.'
      if (length < 2) return 'Enter at least 2 characters.'
      if (length > 100) return 'Use at most 100 characters.'
      return undefined
    }
    case 'phone': {
      const phone = details.phone.replace(/[\s()-]/g, '')
      if (!phone) return 'Enter a phone number so PSP can call you.'
      if (!PHONE_PATTERN.test(phone)) return 'Enter a Tanzanian number, for example 0712 345 678.'
      return undefined
    }
    case 'email': {
      const email = details.email.trim()
      if (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) {
        return 'Enter a valid email address, like name@example.com, or leave it empty.'
      }
      return undefined
    }
    case 'area': {
      const length = squash(details.area).length
      if (length === 0) return 'Enter the area or city for delivery.'
      if (length < 2 || length > 100) return 'Use 2 to 100 characters.'
      return undefined
    }
    case 'address': {
      const length = squash(details.address).length
      if (length === 0) return 'Enter a street, plot or landmark.'
      if (length < 2 || length > 200) return 'Use 2 to 200 characters.'
      return undefined
    }
    case 'notes':
      return details.notes.trim().length > NOTES_MAX ? `Use at most ${NOTES_MAX} characters.` : undefined
  }
}

function checkAll(details: CheckoutDetails): Errors {
  const errors: Errors = {}
  for (const field of FIELDS) {
    const error = check(field, details)
    if (error) errors[field] = error
  }
  return errors
}

const fieldId = (field: Field) => `checkout-${field}`
const focusField = (field: Field) => document.getElementById(fieldId(field))?.focus()

type Row = { line: CartLine; product: ShopProduct | null }
type Answer = { attempt: number; key: string } & (
  | { status: 'ok'; products: Map<string, ShopProduct> }
  | { status: 'error'; message: string }
)

const isQuote = (product: ShopProduct) => product.requestQuotation || product.priceTzs === null
const units = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`
const cartKey = (lines: CartLine[]) => lines.map((line) => line.productId).join(',')

// "Infusion pump (out of stock), Bedside monitor (no longer available)"
function refusedNotice(refused: RefusedLine[], sent: CartLine[], names: Map<string, string>): CartNotice {
  const parts = refused.map((line) => {
    const id = sent[line.index]?.productId ?? line.productId
    const name = names.get(id) ?? 'A product'
    return `${name} (${line.code === 'OUT_OF_STOCK' ? 'out of stock' : 'no longer available'})`
  })
  return {
    notice:
      parts.length > 0
        ? `Your order was not placed. Some products can't be ordered right now: ${parts.join(', ')}. Remove them and check out again.`
        : "Your order was not placed. Some products in your cart can't be ordered right now. Remove them and check out again.",
  }
}

const WIDE_QUERY = '(min-width: 1024px)'

function subscribeToWide(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(WIDE_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

const isWide = () => typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches

// /checkout. Guest checkout, pay later. The summary uses fresh server prices; the
// server reads every line again when the order is placed.
export default function CheckoutPage() {
  const lines = useCart()
  const key = cartKey(lines)
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  // Placing the order empties the cart; that must not trigger the redirect to /cart.
  const [placed, setPlaced] = useState(false)

  useEffect(() => {
    if (key === '') return
    const controller = new AbortController()
    getCartPrices(readCart(), controller.signal).then(
      (result) => {
        if (!result.ok) {
          setAnswer({
            attempt,
            key,
            status: 'error',
            message: result.status === 0 ? result.message : 'We could not load your order. Please try again.',
          })
          return
        }
        setAnswer({ attempt, key, status: 'ok', products: new Map(result.data.items.map((item) => [item.product.id, item.product])) })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [key, attempt])

  if (lines.length === 0) return placed ? null : <Navigate to="/cart" replace />
  if (!answer || answer.attempt !== attempt || answer.key !== key) return <CheckoutSkeleton />

  if (answer.status === 'error') {
    return (
      <div className="shop-container shop-cart-page">
        <CheckoutHead />
        <div className="shop-state" role="alert">
          <span className="shop-state-icon shop-state-icon-error">
            <IconAlert size={24} />
          </span>
          <h2>Something went wrong</h2>
          <p>{answer.message}</p>
          <button type="button" className="shop-button shop-button-primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const rows: Row[] = lines.map((line) => ({ line, product: answer.products.get(line.productId) ?? null }))
  if (rows.some((row) => row.product === null || !row.product.inStock)) {
    const notice: CartNotice = {
      notice: "Some products in your cart can't be ordered right now. Remove them to check out.",
    }
    return <Navigate to="/cart" replace state={notice} />
  }

  return <CheckoutForm rows={rows as (Row & { product: ShopProduct })[]} onPlaced={() => setPlaced(true)} />
}

function CheckoutHead() {
  return (
    <div className="shop-cart-head">
      <h1>Checkout</h1>
      <CheckoutSteps current={2} />
    </div>
  )
}

function CheckoutForm({ rows, onPlaced }: { rows: (Row & { product: ShopProduct })[]; onPlaced: () => void }) {
  const navigate = useNavigate()
  const [details, setDetails] = useState<CheckoutDetails>(draft)
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState('')
  const [sending, setSending] = useState(false)
  const busy = useRef(false) // blocks a second submit before the re-render lands

  const priced = rows.filter((row) => !isQuote(row.product))
  const total = priced.reduce((sum, row) => sum + (row.product.priceTzs as number) * row.line.quantity, 0)
  const hasQuote = rows.length > priced.length

  function update(field: keyof CheckoutDetails, value: string) {
    const next = { ...details, [field]: value }
    remember(next)
    setDetails(next)
    // Once a field shows an error, it clears as soon as the value is right.
    if (field !== 'website' && errors[field]) setErrors((current) => ({ ...current, [field]: check(field, next) }))
  }

  function leave(field: Field) {
    // An untouched empty field is not an error yet; it becomes one on submit.
    if (details[field] === '' && !errors[field]) return
    setErrors((current) => ({ ...current, [field]: check(field, details) }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current) return

    const found = checkAll(details)
    setErrors(found)
    const invalid = FIELDS.filter((field) => found[field])
    if (invalid.length > 0) {
      setFormError(
        invalid.length === 1 ? 'Check the highlighted field above.' : `Check the ${invalid.length} highlighted fields above.`,
      )
      focusField(invalid[0])
      return
    }

    busy.current = true
    setSending(true)
    setFormError('')
    const sent = readCart()
    const result = await placeOrder(details, sent)

    if (result.ok) {
      remember(EMPTY)
      const placed: PlacedOrder & { hasQuote: boolean } = { ...result.data, hasQuote }
      onPlaced()
      navigate('/order-confirmed', { replace: true, state: placed })
      clearCart()
      return
    }

    busy.current = false
    setSending(false)
    const names = new Map(rows.map((row) => [row.product.id, row.product.name]))

    if (result.code === 'LINES_UNAVAILABLE') {
      const refused = (result.details as { lines?: RefusedLine[] } | undefined)?.lines ?? []
      navigate('/cart', { state: refusedNotice(refused, sent, names) })
      return
    }

    if (result.code === 'VALIDATION_ERROR' && result.details && typeof result.details === 'object') {
      const server = result.details as Record<string, string>
      if (Object.keys(server).some((name) => name.startsWith('items'))) {
        navigate('/cart', { state: refusedNotice([], sent, names) })
        return
      }
      const mapped: Errors = {}
      for (const field of FIELDS) if (server[field]) mapped[field] = server[field]
      const first = FIELDS.find((field) => mapped[field])
      if (first) {
        setErrors(mapped)
        setFormError('Check the highlighted fields above.')
        focusField(first)
        return
      }
    }

    if (result.status === 0) setFormError(`${result.message} Your details are still here.`)
    else if (result.status === 429) {
      setFormError('Too many orders were sent from this connection or phone number. Please wait a while and try again, or call PSP.')
    } else if (result.status === 503) {
      setFormError('Ordering is unavailable for a moment. Please try again in a few minutes. Your details are still here.')
    } else setFormError('We could not place your order. Please try again. Your details are still here.')
  }

  const field = (name: Field) => ({
    name,
    value: details[name],
    error: errors[name],
    onChange: (value: string) => update(name, value),
    onBlur: () => leave(name),
  })

  return (
    <div className="shop-container shop-cart-page">
      <CheckoutHead />

      <div className="shop-checkout-layout">
        <OrderSummary rows={rows} total={total} hasQuote={hasQuote} />

        <form className="shop-checkout-form" noValidate onSubmit={submit} aria-labelledby="checkout-details">
          <section className="shop-cart-panel shop-checkout-section" aria-labelledby="checkout-details">
            <h2 id="checkout-details" className="shop-cart-panel-title">
              Your details
            </h2>
            <div className="shop-field-grid">
              <TextField {...field('name')} label="Full name" autoComplete="name" wide />
              <TextField
                {...field('phone')}
                label="Phone number"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                hint="PSP calls this number to confirm your order."
              />
              <TextField
                {...field('email')}
                label="Email"
                optional
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                hint="Only used to contact you about this order."
              />
            </div>
          </section>

          <section className="shop-cart-panel shop-checkout-section" aria-labelledby="checkout-delivery">
            <h2 id="checkout-delivery" className="shop-cart-panel-title">
              Delivery
            </h2>
            <div className="shop-field-grid">
              <TextField
                {...field('area')}
                label="Area or city"
                autoComplete="address-level2"
                hint="For example Mikocheni, Dar es Salaam."
              />
              <TextField
                {...field('address')}
                label="Street, plot or landmark"
                autoComplete="street-address"
                hint="Helps the driver find you."
              />
              <TextField
                {...field('notes')}
                label="Notes for PSP"
                optional
                multiline
                wide
                hint="Opening hours, a contact at the facility, installation needs."
              />
            </div>
          </section>

          {/* Hidden from people; bots that fill every field give themselves away. */}
          <div className="shop-field-honeypot" aria-hidden="true">
            <label htmlFor="checkout-website">Website</label>
            <input
              id="checkout-website"
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={details.website}
              onChange={(event) => update('website', event.target.value)}
            />
          </div>

          <div className="shop-cart-panel shop-checkout-place">
            <div className="shop-checkout-paylater">
              <IconShield size={22} />
              <p>
                <b>Pay later.</b> Nothing is charged now. After PSP confirms your order, you pay on delivery, against an
                invoice, or by bank transfer.
              </p>
            </div>

            {formError && (
              <p className="shop-cart-alert" role="alert">
                <IconAlert size={18} />
                <span>{formError}</span>
              </p>
            )}

            <button
              type="submit"
              className="shop-button shop-button-primary shop-cart-checkout"
              aria-disabled={sending}
              aria-describedby="checkout-fineprint"
            >
              {sending ? (
                <>
                  <span className="shop-spinner" aria-hidden="true" />
                  Placing your order…
                </>
              ) : (
                <>
                  Place order{total > 0 ? ` · ${formatTzs(total)}` : ''}
                  <IconArrow size={18} />
                </>
              )}
            </button>
            <p id="checkout-fineprint" className="shop-checkout-fineprint">
              PSP will call you to confirm before anything is delivered. Your details are sent to PSP only for this order
              and are not saved on this device.
            </p>
          </div>

          <p className="shop-visually-hidden" role="status">
            {sending ? 'Placing your order…' : ''}
          </p>
        </form>
      </div>
    </div>
  )
}

function TextField({
  name,
  label,
  value,
  error,
  hint,
  optional = false,
  multiline = false,
  wide = false,
  onChange,
  onBlur,
  ...input
}: {
  name: Field
  label: string
  value: string
  error?: string
  hint?: string
  optional?: boolean
  multiline?: boolean
  wide?: boolean
  onChange: (value: string) => void
  onBlur: () => void
  type?: string
  inputMode?: 'tel' | 'email'
  autoComplete?: string
  spellCheck?: boolean
}) {
  const id = fieldId(name)
  const describedBy = [hint && `${id}-hint`, `${id}-error`].filter(Boolean).join(' ')
  const common = {
    id,
    name,
    value,
    'aria-invalid': error ? true : undefined,
    'aria-required': optional ? undefined : true,
    'aria-describedby': describedBy,
    onBlur,
  }

  return (
    <div className={`shop-field${wide ? ' shop-field-wide' : ''}`}>
      <label htmlFor={id}>
        {label}
        {optional && <span className="shop-field-optional"> (optional)</span>}
      </label>
      {hint && (
        <span id={`${id}-hint`} className="shop-field-hint">
          {hint}
        </span>
      )}
      {multiline ? (
        <>
          <textarea {...common} rows={4} maxLength={NOTES_MAX} onChange={(event) => onChange(event.target.value)} />
          <span className="shop-field-count" aria-hidden="true">
            {value.length} / {NOTES_MAX}
          </span>
        </>
      ) : (
        <input {...common} {...input} type={input.type ?? 'text'} onChange={(event) => onChange(event.target.value)} />
      )}
      <div id={`${id}-error`} className="shop-field-message" aria-live="polite">
        {error ? (
          <>
            <IconAlert size={16} />
            <span>{error}</span>
          </>
        ) : null}
      </div>
    </div>
  )
}

// Beside the form from 1024px; above it, folded, on smaller screens.
function OrderSummary({
  rows,
  total,
  hasQuote,
}: {
  rows: (Row & { product: ShopProduct })[]
  total: number
  hasQuote: boolean
}) {
  const wide = useSyncExternalStore(subscribeToWide, isWide, () => false)
  const [open, setOpen] = useState(false)
  const expanded = wide || open
  const allUnits = rows.reduce((sum, row) => sum + row.line.quantity, 0)
  const pricedUnits = rows.filter((row) => !isQuote(row.product)).reduce((sum, row) => sum + row.line.quantity, 0)

  return (
    <aside className="shop-checkout-aside" aria-labelledby="checkout-summary">
      <div className="shop-cart-panel shop-checkout-summary">
        {wide ? (
          <h2 id="checkout-summary" className="shop-cart-panel-title shop-checkout-summary-title">
            Order summary
          </h2>
        ) : (
          <h2 id="checkout-summary" className="shop-checkout-summary-heading">
            <button
              type="button"
              className="shop-checkout-toggle"
              aria-expanded={open}
              aria-controls="checkout-summary-body"
              onClick={() => setOpen((value) => !value)}
            >
              <span className="shop-checkout-toggle-label">
                {open ? 'Hide' : 'Show'} order summary
                <span className="shop-checkout-toggle-sep"> · </span>
                <span className="shop-checkout-toggle-count">{units(allUnits)}</span>
              </span>
              <span className="shop-checkout-toggle-total">{formatTzs(total)}</span>
              <span className={`shop-checkout-chevron${open ? ' is-open' : ''}`}>
                <IconChevronRight size={18} />
              </span>
            </button>
          </h2>
        )}

        <div id="checkout-summary-body" className="shop-cart-summary shop-checkout-summary-body" hidden={!expanded}>
          <ul className="shop-checkout-lines">
            {rows.map(({ line, product }) => (
              <li key={line.productId} className="shop-checkout-line">
                <span className="shop-checkout-thumb">
                  {product.imageUrl ? (
                    <img src={imageSrc(product.imageUrl)} alt="" width="48" height="48" loading="lazy" decoding="async" />
                  ) : (
                    <IconImage size={20} />
                  )}
                </span>
                <span className="shop-checkout-line-info">
                  <span className="shop-checkout-line-name">{product.name}</span>
                  <span className="shop-checkout-line-meta">
                    {line.quantity} × {isQuote(product) ? 'Price on request' : formatTzs(product.priceTzs as number)}
                  </span>
                </span>
                <span className={`shop-checkout-line-total${isQuote(product) ? ' is-quote' : ''}`}>
                  {isQuote(product) ? 'Quoted' : formatTzs((product.priceTzs as number) * line.quantity)}
                </span>
              </li>
            ))}
          </ul>
          <dl>
            <div>
              <dt>Subtotal ({units(pricedUnits)})</dt>
              <dd>{formatTzs(total)}</dd>
            </div>
            {hasQuote && (
              <div>
                <dt>Price on request ({units(allUnits - pricedUnits)})</dt>
                <dd className="is-text">Quoted by PSP</dd>
              </div>
            )}
            <div>
              <dt>Delivery and installation</dt>
              <dd className="is-text">Arranged with you</dd>
            </div>
            <div className="shop-cart-total">
              <dt>Total</dt>
              <dd>{formatTzs(total)}</dd>
            </div>
          </dl>
          {hasQuote && (
            <p className="shop-cart-note">
              Items marked "Price on request" are not in the total. PSP will send you a quotation for them.
            </p>
          )}
          <Link to="/cart" className="shop-cart-continue">
            Edit cart
          </Link>
        </div>
      </div>

      <p className="shop-cart-quote shop-checkout-quote">
        <IconDocument size={20} />
        <span>
          <b>Buying for a hospital or tender?</b> <Link to="/#contact">Request a formal quotation</Link> and we will
          reply within one working day.
        </span>
      </p>
    </aside>
  )
}

function CheckoutSkeleton() {
  return (
    <div className="shop-container shop-cart-page" aria-busy="true">
      <p className="shop-visually-hidden" role="status">
        Loading checkout…
      </p>
      <CheckoutHead />
      <div className="shop-checkout-layout" aria-hidden="true">
        <div className="shop-checkout-aside">
          <div className="shop-cart-panel shop-cart-summary">
            <span className="shop-skeleton-line shop-cart-skeleton-title" />
            <span className="shop-skeleton-line" />
          </div>
        </div>
        <div className="shop-checkout-form">
          <div className="shop-cart-panel shop-checkout-section">
            <span className="shop-skeleton-line shop-cart-skeleton-title" />
            <span className="shop-skeleton-block shop-checkout-skeleton-field" />
            <span className="shop-skeleton-block shop-checkout-skeleton-field" />
            <span className="shop-skeleton-block shop-checkout-skeleton-field" />
          </div>
        </div>
      </div>
    </div>
  )
}

type Placed = PlacedOrder & { hasQuote: boolean }

function readPlaced(state: unknown): Placed | null {
  const value = state as Partial<Placed> | null
  if (!value || typeof value.orderNumber !== 'string' || typeof value.totalTzs !== 'number') return null
  return { orderNumber: value.orderNumber, totalTzs: value.totalTzs, hasQuote: value.hasQuote === true }
}

// /order-confirmed. The order number arrives in the navigation state (memory and
// browser history only; nothing personal).
export function OrderConfirmed() {
  const order = readPlaced(useLocation().state)
  const heading = useRef<HTMLHeadingElement>(null)
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')

  useEffect(() => heading.current?.focus(), [])

  useEffect(() => {
    if (copied === 'idle') return
    const timer = setTimeout(() => setCopied('idle'), 3000)
    return () => clearTimeout(timer)
  }, [copied])

  if (!order) {
    return (
      <div className="shop-container shop-cart-page">
        <div className="shop-state">
          <span className="shop-state-icon">
            <IconDocument size={24} />
          </span>
          <h1 ref={heading} tabIndex={-1} className="shop-confirm-missing">
            No order to show
          </h1>
          <p>If you have just placed an order, PSP will contact you to confirm it and arrange payment.</p>
          <Link to="/products" className="shop-button shop-button-primary">
            Continue shopping
            <IconArrow size={18} />
          </Link>
        </div>
      </div>
    )
  }

  function copy() {
    if (!order) return
    if (!navigator.clipboard?.writeText) {
      setCopied('failed')
      return
    }
    navigator.clipboard.writeText(order.orderNumber).then(
      () => setCopied('done'),
      () => setCopied('failed'),
    )
  }

  return (
    <div className="shop-container shop-cart-page shop-confirm-page">
      <CheckoutSteps current={3} />
      <div className="shop-cart-panel shop-confirm">
        <span className="shop-confirm-icon">
          <IconCheck size={28} />
        </span>
        <h1 ref={heading} tabIndex={-1}>
          Thank you, your order is placed
        </h1>
        <p className="shop-confirm-lead">PSP will contact you to confirm and arrange payment.</p>

        <div className="shop-confirm-number">
          <span className="shop-confirm-number-label">Order number</span>
          <span className="shop-confirm-number-value">{order.orderNumber}</span>
          <button type="button" className="shop-button shop-button-secondary shop-confirm-copy" onClick={copy}>
            {copied === 'done' ? <IconCheck size={18} /> : <IconDocument size={18} />}
            {copied === 'done' ? 'Copied' : 'Copy number'}
          </button>
          {copied === 'failed' && (
            <span className="shop-confirm-copy-failed">Copy did not work here. Please write the number down.</span>
          )}
        </div>

        <dl className="shop-confirm-facts">
          <div>
            <dt>Order total</dt>
            <dd className="is-money">{formatTzs(order.totalTzs)}</dd>
          </div>
          {order.hasQuote && (
            <div>
              <dt>Price on request</dt>
              <dd>PSP will send you a quotation for those items.</dd>
            </div>
          )}
          <div>
            <dt>Payment</dt>
            <dd>Pay later: on delivery, against an invoice, or by bank transfer.</dd>
          </div>
        </dl>

        <div className="shop-confirm-next">
          <h2>What happens next</h2>
          <ol>
            <Step icon={<IconPhone size={18} />}>PSP calls you on the number you gave to confirm the items and the price.</Step>
            <Step icon={<IconDocument size={18} />}>You agree how to pay: on delivery, against an invoice, or by bank transfer.</Step>
            <Step icon={<IconTruck size={18} />}>PSP delivers the equipment and arranges installation with you.</Step>
          </ol>
        </div>

        <div className="shop-confirm-actions">
          <Link to="/products" className="shop-button shop-button-primary">
            Continue shopping
            <IconArrow size={18} />
          </Link>
          <Link to="/" className="shop-button shop-button-secondary">
            Back to home
          </Link>
        </div>
        <p className="shop-checkout-fineprint">Keep the order number for when you speak to PSP.</p>
      </div>

      <p className="shop-visually-hidden" role="status">
        {copied === 'done' ? 'Order number copied.' : copied === 'failed' ? 'Copy did not work.' : ''}
      </p>
    </div>
  )
}

function Step({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <span className="shop-confirm-step-icon">{icon}</span>
      <span>{children}</span>
    </li>
  )
}

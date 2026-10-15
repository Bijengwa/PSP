import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'
import { initials } from '../layout/ProfileMenu'
import { ORDERS_CHANGED } from '../layout/Sidebar'
import { displayName, phoneText, type Customer } from './CustomersList'
import { ORDERS_PATH } from './OrdersList'
import { TZS, type Product } from './ProductForm'

// A staff order for a phone or walk-in sale (M7.4): pick a customer or type a walk-in's
// details, add published products with quantities, and create it. The server reads every
// price and name from the database again, so the totals shown here are only a preview.

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MIN = 2
const SHOWN = 6
const QUANTITY_MAX = 99
const MAX_LINES = 50

type Line = { product: Product; quantity: number }
type Found<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T[] }
type Fields = Record<string, string>

const money = (value: number) => `TZS ${TZS.format(value)}`

function errorText(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

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
const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
const MinusIcon = () => (
  <Svg>
    <path d="M5 12h14" />
  </Svg>
)
const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
)

// Runs `fetcher` (a module-level function, so it is stable) for `q` after a short pause
// and reports the first few results.
function useSearch<T>(q: string, fetcher: (term: string, signal: AbortSignal) => Promise<ApiResult<T[]>>) {
  const [found, setFound] = useState<Found<T> | null>(null)
  const term = q.trim()

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (term.length < SEARCH_MIN) {
        setFound(null)
        return
      }
      setFound({ status: 'loading' })
      fetcher(term, controller.signal).then(
        (result) =>
          setFound(
            result.ok
              ? { status: 'ready', items: result.data.slice(0, SHOWN) }
              : { status: 'error', message: errorText(result) },
          ),
        () => {}, // aborted
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [term, fetcher])

  return found
}

async function searchCustomers(term: string, signal: AbortSignal): Promise<ApiResult<Customer[]>> {
  const result = await apiRequest<{ customers: Customer[] }>(`/api/office/customers?${new URLSearchParams({ q: term })}`, {
    signal,
  })
  return result.ok ? { ok: true, data: result.data.customers } : result
}

async function searchProducts(term: string, signal: AbortSignal): Promise<ApiResult<Product[]>> {
  const params = new URLSearchParams({ q: term, status: 'published' })
  const result = await apiRequest<{ products: Product[] }>(`/api/office/products?${params}`, { signal })
  return result.ok ? { ok: true, data: result.data.products } : result
}

function Results<T>({
  found,
  empty,
  children,
}: {
  found: Found<T> | null
  empty: string
  children: (items: T[]) => ReactNode
}) {
  if (!found) return null
  if (found.status === 'loading') return <p className="office-staff-meta office-order-new-hint">Searching…</p>
  if (found.status === 'error') {
    return (
      <p className="field-error" role="alert">
        {found.message}
      </p>
    )
  }
  if (found.items.length === 0) return <p className="office-staff-meta office-order-new-hint">{empty}</p>
  return <ul className="office-link-list">{children(found.items)}</ul>
}

export default function OrderNew() {
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [customerQuery, setCustomerQuery] = useState('')
  const [guest, setGuest] = useState({ name: '', phone: '', email: '', area: '', address: '' })
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [productQuery, setProductQuery] = useState('')
  const [fields, setFields] = useState<Fields>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const errorRef = useRef<HTMLDivElement>(null)

  const customers = useSearch(customer ? '' : customerQuery, searchCustomers)
  const products = useSearch(productQuery, searchProducts)

  const priced = lines.filter((line) => line.product.priceTzs !== null && !line.product.requestQuotation)
  const total = priced.reduce((sum, line) => sum + (line.product.priceTzs ?? 0) * line.quantity, 0)
  const quoteLines = lines.length - priced.length

  function setGuestField(name: keyof typeof guest, value: string) {
    setGuest((current) => ({ ...current, [name]: value }))
    setFields((current) => ({ ...current, [name === 'name' ? 'guestName' : name]: '' }))
  }

  function addProduct(product: Product) {
    if (lines.some((line) => line.product.id === product.id) || lines.length >= MAX_LINES) return
    setLines([...lines, { product, quantity: 1 }])
    setFields((current) => ({ ...current, items: '' }))
  }

  function setQuantity(id: string, quantity: number) {
    setLines(lines.map((line) => (line.product.id === id ? { ...line, quantity } : line)))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')
    if (lines.length === 0) {
      setFields({ items: 'Add at least one product.' })
      return
    }

    setBusy(true)
    const body = {
      customerId: customer?.id ?? undefined,
      guestName: customer ? undefined : guest.name,
      guestPhone: customer ? undefined : guest.phone,
      guestEmail: guest.email || undefined,
      deliveryArea: guest.area || undefined,
      deliveryAddress: guest.address || undefined,
      notes,
      items: lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
    }
    const result = await apiRequest<{ order: { id: string } }>('/api/office/orders', { method: 'POST', body })
    setBusy(false)

    if (result.ok) {
      window.dispatchEvent(new Event(ORDERS_CHANGED))
      navigate(`${ORDERS_PATH}/${result.data.order.id}`)
      return
    }

    const details = result.details as Record<string, unknown> | undefined
    if (result.code === 'VALIDATION_ERROR' && details) {
      const next: Fields = {}
      for (const [key, value] of Object.entries(details)) {
        next[key.startsWith('items.') ? 'items' : key] = String(value)
      }
      setFields(next)
      setError('Check the highlighted fields.')
    } else if (result.code === 'LINES_UNAVAILABLE' && Array.isArray(details?.lines)) {
      const unavailable = details.lines as { index: number }[]
      const names = unavailable.map((line) => lines[line.index]?.product.name).filter(Boolean)
      setError(`Not available any more: ${names.join(', ')}. Remove them or choose other products.`)
    } else {
      setError(errorText(result))
    }
    window.setTimeout(() => errorRef.current?.focus(), 0)
  }

  function fieldInput(name: keyof typeof guest, label: string, opts: { optional?: boolean; hint?: string; type?: string } = {}) {
    const key = name === 'name' ? 'guestName' : name === 'phone' ? 'guestPhone' : name === 'email' ? 'guestEmail' : name === 'area' ? 'deliveryArea' : 'deliveryAddress'
    const id = `order-new-${name}`
    const message = fields[key]
    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {label}
          {opts.optional && <span className="office-optional"> (optional)</span>}
        </label>
        <input
          id={id}
          className="field-input"
          type={opts.type ?? 'text'}
          autoComplete="off"
          value={guest[name]}
          placeholder={opts.hint}
          onChange={(event) => setGuestField(name, event.target.value)}
          disabled={busy}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${id}-error` : undefined}
        />
        {message && (
          <p className="field-error" id={`${id}-error`} role="alert">
            {message}
          </p>
        )}
      </div>
    )
  }

  const customerHome = customer ? 'Leave blank to use the customer’s default address.' : undefined

  return (
    <form className="office-product-page office-order-new" onSubmit={submit} noValidate aria-busy={busy}>
      <Link className="office-back-link" to={ORDERS_PATH}>
        <BackIcon />
        Orders
      </Link>

      <div className="office-product-head">
        <div className="office-product-heading">
          <h1 className="office-title">New order</h1>
          <p className="office-lead">For a phone or walk-in sale. It starts as a new, unpaid order.</p>
        </div>
      </div>

      <div className="office-error" role="alert" hidden={!error} ref={errorRef} tabIndex={-1}>
        {error}
      </div>

      <section className="office-card" aria-labelledby="order-new-customer">
        <h2 id="order-new-customer">Customer</h2>
        {customer ? (
          <div className="office-link-option">
            <span className="office-avatar" aria-hidden="true">
              {initials(displayName(customer))}
            </span>
            <span className="office-link-option-text">
              <span className="office-staff-name">{displayName(customer)}</span>
              <span className="office-staff-meta office-link-contacts">
                {[customer.phone && phoneText(customer.phone), customer.email].filter(Boolean).join(' · ') ||
                  'No contact details'}
              </span>
            </span>
            <button
              type="button"
              className="button button-secondary office-link-action"
              onClick={() => setCustomer(null)}
              disabled={busy}
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <div className="field">
              <label className="field-label" htmlFor="order-new-customer-search">
                Find a customer<span className="office-optional"> (optional)</span>
              </label>
              <input
                id="order-new-customer-search"
                className="field-input"
                type="search"
                autoComplete="off"
                placeholder="Name, company, phone or email"
                value={customerQuery}
                onChange={(event) => setCustomerQuery(event.target.value)}
                maxLength={100}
              />
              {fields.customerId && (
                <p className="field-error" role="alert">
                  {fields.customerId}
                </p>
              )}
            </div>
            <Results found={customers} empty="No customer matches. Enter the details below for a walk-in sale.">
              {(items) =>
                items.map((item) => (
                  <li key={item.id} className="office-link-option">
                    <span className="office-avatar" aria-hidden="true">
                      {initials(displayName(item))}
                    </span>
                    <span className="office-link-option-text">
                      <span className="office-staff-name">{displayName(item)}</span>
                      <span className="office-staff-meta office-link-contacts">
                        {[item.phone && phoneText(item.phone), item.email].filter(Boolean).join(' · ') ||
                          'No contact details'}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="button button-secondary office-link-action"
                      aria-label={`Use ${displayName(item)}`}
                      onClick={() => {
                        setCustomer(item)
                        setCustomerQuery('')
                      }}
                    >
                      Use
                    </button>
                  </li>
                ))
              }
            </Results>
            <p className="office-staff-meta office-order-new-hint">Or enter a walk-in customer:</p>
            <div className="office-product-row">
              {fieldInput('name', 'Name')}
              {fieldInput('phone', 'Phone', { hint: 'e.g. 0712 345 678', type: 'tel' })}
            </div>
          </>
        )}
      </section>

      <section className="office-card" aria-labelledby="order-new-delivery">
        <h2 id="order-new-delivery">Delivery</h2>
        <div className="office-product-row">
          {fieldInput('area', 'Area or city', { optional: Boolean(customer), hint: customerHome })}
          {fieldInput('address', 'Street or landmark', { optional: Boolean(customer), hint: customerHome })}
        </div>
        {fieldInput('email', 'Email', { optional: true, type: 'email' })}
        <div className="field">
          <label className="field-label" htmlFor="order-new-notes">
            Notes<span className="office-optional"> (optional)</span>
          </label>
          <textarea
            id="order-new-notes"
            className="field-input office-product-textarea"
            rows={3}
            maxLength={1000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            disabled={busy}
          />
        </div>
      </section>

      <section className="office-card" aria-labelledby="order-new-items">
        <h2 id="order-new-items">Items</h2>
        <div className="field">
          <label className="field-label" htmlFor="order-new-product-search">
            Add a product
          </label>
          <input
            id="order-new-product-search"
            className="field-input"
            type="search"
            autoComplete="off"
            placeholder="Name, brand or SKU"
            value={productQuery}
            onChange={(event) => setProductQuery(event.target.value)}
            maxLength={100}
          />
        </div>
        <Results found={products} empty="No published product matches.">
          {(items) =>
            items.map((item) => {
              const added = lines.some((line) => line.product.id === item.id)
              const out = item.stockStatus === 'out_of_stock'
              return (
                <li key={item.id} className="office-link-option">
                  <span className="office-link-option-text">
                    <span className="office-staff-name">{item.name}</span>
                    <span className="office-staff-meta office-link-contacts">
                      {item.sku} ·{' '}
                      {item.requestQuotation || item.priceTzs === null ? 'Price on request' : money(item.priceTzs)}
                      {out ? ' · Out of stock' : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="button button-secondary office-link-action"
                    aria-label={`Add ${item.name}`}
                    disabled={added || out}
                    onClick={() => addProduct(item)}
                  >
                    <PlusIcon />
                    {added ? 'Added' : 'Add'}
                  </button>
                </li>
              )
            })
          }
        </Results>

        {fields.items && (
          <p className="field-error" role="alert">
            {fields.items}
          </p>
        )}

        {lines.length > 0 && (
          <table className="office-order-items is-editing">
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
              {lines.map(({ product, quantity }) => {
                const quote = product.requestQuotation || product.priceTzs === null
                return (
                  <tr key={product.id}>
                    <td className="office-item-product">
                      <span className="office-item-name">{product.name}</span>
                      <span className="office-item-sku">{product.sku}</span>
                      <span className="office-item-each office-staff-meta">
                        {quote ? 'Price on request' : `${money(product.priceTzs as number)} each`}
                      </span>
                    </td>
                    <td className="office-item-unit">
                      {quote ? (
                        <span className="office-staff-meta">On request</span>
                      ) : (
                        money(product.priceTzs as number)
                      )}
                    </td>
                    <td className="office-item-qty">
                      <span className="office-item-edit">
                        <span className="office-stepper" role="group" aria-label={`Quantity of ${product.name}`}>
                          <button
                            type="button"
                            className="office-stepper-button"
                            aria-label={`Fewer ${product.name}`}
                            disabled={quantity <= 1 || busy}
                            onClick={() => setQuantity(product.id, quantity - 1)}
                          >
                            <MinusIcon />
                          </button>
                          <span className="office-stepper-value" aria-live="polite">
                            {quantity}
                          </span>
                          <button
                            type="button"
                            className="office-stepper-button"
                            aria-label={`More ${product.name}`}
                            disabled={quantity >= QUANTITY_MAX || busy}
                            onClick={() => setQuantity(product.id, quantity + 1)}
                          >
                            <PlusIcon />
                          </button>
                        </span>
                        <button
                          type="button"
                          className="office-icon-action office-item-remove"
                          aria-label={`Remove ${product.name}`}
                          disabled={busy}
                          onClick={() => setLines(lines.filter((line) => line.product.id !== product.id))}
                        >
                          <TrashIcon />
                        </button>
                      </span>
                    </td>
                    <td className="office-item-total">
                      {quote ? (
                        <span className="office-staff-meta">Price on request</span>
                      ) : (
                        <span className="office-order-total">{money((product.priceTzs as number) * quantity)}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  Order total
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
        )}
      </section>

      <div className="office-reset-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Creating…' : 'Create order'}
        </button>
        <Link className="button button-secondary" to={ORDERS_PATH}>
          Cancel
        </Link>
      </div>
    </form>
  )
}

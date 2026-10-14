import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { formatTzs, getCartPrices, imageSrc, type ShopProduct } from './api'
import {
  MAX_QUANTITY,
  clampQuantity,
  priceChange,
  readCart,
  removeFromCart,
  setQuantity,
  useCart,
  type CartLine,
} from './cart'
import { IconAlert, IconArrow, IconCart, IconCheck, IconClose, IconDocument, IconImage, IconMinus, IconPlus, IconTrash } from './Icons'

type Answer = { attempt: number; requested: Set<string> } & (
  | { status: 'ok'; products: Map<string, ShopProduct>; was: Map<string, number | null> }
  | { status: 'error'; message: string }
)

type Row = { line: CartLine; product: ShopProduct | null; was?: number | null }

// Navigation state from the checkout when products could not be ordered.
export type CartNotice = { notice: string }

const isQuote = (product: ShopProduct) => product.requestQuotation || product.priceTzs === null
const available = (row: Row): row is Row & { product: ShopProduct } => row.product !== null && row.product.inStock
const units = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`

// /cart. The lines come from localStorage (ids and quantities); names, prices,
// photos and stock always come fresh from the server.
export default function CartPage() {
  const lines = useCart()
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [message, setMessage] = useState('')
  const location = useLocation()
  const notice = (location.state as Partial<CartNotice> | null)?.notice
  const [closedNotice, setClosedNotice] = useState<string | null>(null) // location key of a dismissed notice

  // Removing a line or changing a quantity needs no new request; a product the
  // last answer did not cover does.
  const covered =
    answer !== null && answer.attempt === attempt && lines.every((line) => answer.requested.has(line.productId))

  useEffect(() => {
    if (covered || lines.length === 0) return
    const controller = new AbortController()
    const cart = readCart()
    const requested = new Set(cart.map((line) => line.productId))
    getCartPrices(cart, controller.signal).then(
      (result) => {
        if (!result.ok) {
          setAnswer({
            attempt,
            requested,
            status: 'error',
            message: result.status === 0 ? result.message : 'We could not load your cart. Please try again.',
          })
          return
        }
        const products = new Map(result.data.items.map((item) => [item.product.id, item.product]))
        const was = new Map<string, number | null>()
        for (const product of products.values()) {
          const before = priceChange(product.id, isQuote(product) ? null : product.priceTzs)
          if (before !== undefined) was.set(product.id, before)
        }
        setAnswer({ attempt, requested, status: 'ok', products, was })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [covered, lines, attempt])

  if (lines.length === 0) return <EmptyCart message={message} />
  if (!covered || !answer) return <CartSkeleton count={Math.min(lines.length, 3)} />

  if (answer.status === 'error') {
    return (
      <div className="shop-container shop-cart-page">
        <CartHead />
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

  const rows: Row[] = lines.map((line) => ({
    line,
    product: answer.products.get(line.productId) ?? null,
    was: answer.was.get(line.productId),
  }))
  const priced = rows.filter(available).filter((row) => !isQuote(row.product))
  const quoted = rows.filter(available).filter((row) => isQuote(row.product))
  const blocked = rows.filter((row) => !available(row))
  const total = priced.reduce((sum, row) => sum + (row.product.priceTzs as number) * row.line.quantity, 0)
  const pricedUnits = priced.reduce((sum, row) => sum + row.line.quantity, 0)
  const quotedUnits = quoted.reduce((sum, row) => sum + row.line.quantity, 0)
  const allUnits = lines.reduce((sum, line) => sum + line.quantity, 0)

  function remove(row: Row) {
    removeFromCart(row.line.productId)
    setMessage(`${row.product?.name ?? 'The unavailable product'} was removed from your cart.`)
  }

  return (
    <div className="shop-container shop-cart-page">
      <CartHead count={allUnits} />

      {typeof notice === 'string' && closedNotice !== location.key && (
        <div className="shop-cart-alert shop-cart-notice" role="alert">
          <IconAlert size={18} />
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setClosedNotice(location.key)}>
            <IconClose size={16} />
          </button>
        </div>
      )}

      <div className="shop-cart-layout">
        <section className="shop-cart-panel" aria-labelledby="cart-items">
          <h2 id="cart-items" className="shop-cart-panel-title">
            Items ({allUnits})
          </h2>
          {blocked.length > 0 && (
            <p className="shop-cart-alert">
              <IconAlert size={18} />
              <span>
                {blocked.length === 1 ? 'One product' : `${blocked.length} products`} in your cart can't be ordered
                right now. Remove {blocked.length === 1 ? 'it' : 'them'} to check out.
              </span>
            </p>
          )}
          <ul className="shop-cart-lines">
            {rows.map((row) => (
              <CartLineItem key={row.line.productId} row={row} onRemove={() => remove(row)} onMessage={setMessage} />
            ))}
          </ul>
        </section>

        <aside className="shop-cart-aside" aria-labelledby="cart-summary">
          <div className="shop-cart-panel shop-cart-summary">
            <h2 id="cart-summary" className="shop-cart-panel-title">
              Order summary
            </h2>
            <dl>
              <div>
                <dt>Subtotal ({units(pricedUnits)})</dt>
                <dd>{formatTzs(total)}</dd>
              </div>
              {quotedUnits > 0 && (
                <div>
                  <dt>Price on request ({units(quotedUnits)})</dt>
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
            {quotedUnits > 0 && (
              <p className="shop-cart-note">
                Items marked "Price on request" are not in the total. PSP will send you a quotation for them.
              </p>
            )}
            {blocked.length > 0 ? (
              <>
                <button
                  type="button"
                  className="shop-button shop-button-primary shop-cart-checkout"
                  disabled
                  aria-describedby="cart-blocked"
                >
                  Checkout
                </button>
                <p id="cart-blocked" className="shop-cart-note">
                  Remove the products that can't be ordered to continue.
                </p>
              </>
            ) : (
              <Link to="/checkout" className="shop-button shop-button-primary shop-cart-checkout">
                Checkout
                <IconArrow size={18} />
              </Link>
            )}
            <Link to="/products" className="shop-cart-continue">
              Continue shopping
            </Link>
          </div>

          <p className="shop-cart-quote">
            <IconDocument size={20} />
            <span>
              <b>Buying for a hospital or tender?</b> <Link to="/#contact">Request a formal quotation</Link> and we
              will reply within one working day.
            </span>
          </p>
        </aside>
      </div>

      <p className="shop-visually-hidden" role="status">
        {message}
      </p>
    </div>
  )
}

function CartHead({ count }: { count?: number }) {
  return (
    <div className="shop-cart-head">
      <h1>
        Your cart
        {count !== undefined && <span className="shop-cart-count"> · {units(count)}</span>}
      </h1>
      <CheckoutSteps current={1} />
    </div>
  )
}

const STEPS = ['Cart', 'Your details', 'Confirmed']

// Shared with the checkout and confirmation pages.
export function CheckoutSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="shop-cart-steps" aria-label="Checkout steps">
      {STEPS.map((label, index) => (
        <li key={label} aria-current={index + 1 === current ? 'step' : undefined}>
          <span>{index + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  )
}

function CartLineItem({
  row,
  onRemove,
  onMessage,
}: {
  row: Row
  onRemove: () => void
  onMessage: (message: string) => void
}) {
  const { line, product } = row
  const [draft, setDraft] = useState<string | null>(null)
  const name = product?.name ?? 'Product no longer available'
  const out = product !== null && !product.inStock
  const quote = product !== null && isQuote(product)
  const unavailable = product === null || out

  function change(quantity: number) {
    const next = clampQuantity(quantity)
    setQuantity(line.productId, next)
    if (quantity > MAX_QUANTITY) onMessage(`You can order up to ${MAX_QUANTITY} of one product.`)
  }

  function commit() {
    if (draft !== null) change(Number.parseInt(draft, 10) || 1)
    setDraft(null)
  }

  return (
    <li className={`shop-cart-line${unavailable ? ' is-unavailable' : ''}`}>
      <div className="shop-cart-line-media">
        {product?.imageUrl ? (
          <img src={imageSrc(product.imageUrl)} alt="" width="96" height="96" loading="lazy" decoding="async" />
        ) : (
          <IconImage size={28} />
        )}
      </div>

      <div className="shop-cart-line-info">
        {product && <span className="shop-cart-line-category">{product.category.name}</span>}
        {product ? (
          <Link to={`/products/${product.slug}`} className="shop-cart-line-name">
            {name}
          </Link>
        ) : (
          <span className="shop-cart-line-name">{name}</span>
        )}
        <div className="shop-cart-line-flags">
          {product === null && (
            <span className="shop-pill shop-pill-out">
              <IconClose size={14} />
              Removed from the catalogue
            </span>
          )}
          {out && (
            <span className="shop-pill shop-pill-out">
              <IconClose size={14} />
              Out of stock
            </span>
          )}
          {product && !out && !quote && row.was === undefined && (
            <span className="shop-pill shop-pill-ok">
              <IconCheck size={14} />
              In stock
            </span>
          )}
          {quote && !out && <span className="shop-pill shop-pill-quote">Price on request</span>}
          {row.was !== undefined && (
            <span className="shop-pill shop-pill-changed">
              <IconAlert size={14} />
              {row.was === null ? 'Now has a price' : `Price changed, was ${formatTzs(row.was)}`}
            </span>
          )}
        </div>
      </div>

      <div className="shop-cart-line-controls">
        <div className="shop-stepper shop-cart-stepper" role="group" aria-label={`Quantity of ${name}`}>
          <button
            type="button"
            aria-label="Decrease quantity"
            disabled={unavailable || line.quantity <= 1}
            onClick={() => change(line.quantity - 1)}
          >
            <IconMinus size={16} />
          </button>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label="Quantity"
            value={draft ?? String(line.quantity)}
            disabled={unavailable}
            onChange={(event) => setDraft(event.target.value.replace(/\D/g, '').slice(0, 2))}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
          />
          <button
            type="button"
            aria-label="Increase quantity"
            disabled={unavailable || line.quantity >= MAX_QUANTITY}
            onClick={() => change(line.quantity + 1)}
          >
            <IconPlus size={16} />
          </button>
        </div>

        <div className="shop-cart-line-price">
          {product === null ? (
            <span className="shop-cart-line-each">Not available</span>
          ) : quote ? (
            <span className="shop-cart-line-total shop-cart-line-total-quote">Price on request</span>
          ) : (
            <>
              <span className={`shop-cart-line-total${out ? ' is-excluded' : ''}`}>
                {formatTzs((product.priceTzs as number) * line.quantity)}
              </span>
              <span className="shop-cart-line-each">
                {out ? 'Not in total' : `${formatTzs(product.priceTzs as number)} each`}
              </span>
            </>
          )}
        </div>
      </div>

      <button type="button" className="shop-cart-remove" aria-label={`Remove ${name} from cart`} onClick={onRemove}>
        <IconTrash size={18} />
      </button>
    </li>
  )
}

function EmptyCart({ message }: { message: string }) {
  return (
    <div className="shop-container shop-cart-page">
      <CartHead />
      <div className="shop-state">
        <span className="shop-state-icon">
          <IconCart size={24} />
        </span>
        <h2>Your cart is empty</h2>
        <p>Browse the catalogue and add the equipment you need. Your cart stays on this device.</p>
        <Link to="/products" className="shop-button shop-button-primary">
          Browse products
          <IconArrow size={18} />
        </Link>
      </div>
      <p className="shop-visually-hidden" role="status">
        {message}
      </p>
    </div>
  )
}

// Same boxes as the loaded page, so nothing jumps.
function CartSkeleton({ count }: { count: number }) {
  return (
    <div className="shop-container shop-cart-page" aria-busy="true">
      <p className="shop-visually-hidden" role="status">
        Loading your cart…
      </p>
      <CartHead />
      <div className="shop-cart-layout" aria-hidden="true">
        <div className="shop-cart-panel">
          <span className="shop-skeleton-line shop-cart-skeleton-title" />
          <ul className="shop-cart-lines">
            {Array.from({ length: count }, (_, n) => (
              <li key={n} className="shop-cart-line">
                <div className="shop-cart-line-media shop-skeleton-block" />
                <div className="shop-cart-line-info">
                  <span className="shop-skeleton-line shop-cart-skeleton-short" />
                  <span className="shop-skeleton-line shop-skeleton-line-lg" />
                </div>
                <div className="shop-cart-line-controls">
                  <span className="shop-skeleton-block shop-cart-skeleton-stepper" />
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="shop-cart-aside">
          <div className="shop-cart-panel shop-cart-summary">
            <span className="shop-skeleton-line shop-cart-skeleton-title" />
            <span className="shop-skeleton-line" />
            <span className="shop-skeleton-line" />
            <span className="shop-skeleton-block shop-cart-skeleton-button" />
          </div>
        </div>
      </div>
    </div>
  )
}

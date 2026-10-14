import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { Link, useParams } from 'react-router'
import { formatTzs, getProduct, imageSrc, type ShopProductAnswer, type ShopProductDetail } from './api'
import { MAX_LINES, MAX_QUANTITY, addToCart, clampQuantity, rememberPrice } from './cart'
import {
  IconAlert,
  IconCart,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconDocument,
  IconImage,
  IconMinus,
  IconPlus,
  IconSearch,
  IconTruck,
  IconWrench,
} from './Icons'
import PageMeta, { SITE } from './PageMeta'
import ProductCard from './ProductCard'

const SWIPE_PX = 40
const META_LENGTH = 155

type Answer = { key: string } & (
  | { status: 'ok'; data: ShopProductAnswer }
  | { status: 'missing' }
  | { status: 'error'; message: string }
)

const isQuote = (product: ShopProductDetail) => product.requestQuotation || product.priceTzs === null

// The search-result line: the description, or a summary when there is none.
function metaDescription(product: ShopProductDetail) {
  const text = product.description.replace(/\s+/g, ' ').trim()
  if (text) return text.length > META_LENGTH ? `${text.slice(0, META_LENGTH - 1).trimEnd()}…` : text
  const price = isQuote(product) ? 'Price on request' : formatTzs(product.priceTzs as number)
  return `${product.name}${product.brand ? ` by ${product.brand}` : ''}: ${product.category.name}. ${price}. ${SITE}, Tanzania.`
}

// /products/:slug
export default function ProductPage() {
  const { slug = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const key = `${slug}\n${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    getProduct(slug, controller.signal).then(
      (result) =>
        setAnswer(
          result.ok
            ? { key, status: 'ok', data: result.data }
            : result.status === 404
              ? { key, status: 'missing' }
              : {
                  key,
                  status: 'error',
                  message:
                    result.status === 0 ? result.message : 'We could not load this product. Please try again.',
                },
        ),
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [key, slug])

  const current = answer?.key === key ? answer : null
  const product = current?.status === 'ok' ? current.data.product : null

  return (
    <>
      <PageMeta
        title={product?.name ?? (current?.status === 'missing' ? 'Product not found' : '')}
        description={product ? metaDescription(product) : `Medical equipment from ${SITE}, Tanzania.`}
      />
      <ProductView current={current} onRetry={() => setAttempt((n) => n + 1)} />
    </>
  )
}

function ProductView({ current, onRetry }: { current: Answer | null; onRetry: () => void }) {
  if (!current) return <ProductSkeleton />

  if (current.status === 'missing') {
    return (
      <div className="shop-container shop-product">
        <div className="shop-state shop-product-state">
          <span className="shop-state-icon">
            <IconSearch size={24} />
          </span>
          <h1>Product not found</h1>
          <p>This product is not in our catalogue. It may have been removed, or the link may be wrong.</p>
          <Link to="/products" className="shop-button shop-button-secondary">
            Browse all products
          </Link>
        </div>
      </div>
    )
  }

  if (current.status === 'error') {
    return (
      <div className="shop-container shop-product">
        <div className="shop-state shop-product-state" role="alert">
          <span className="shop-state-icon shop-state-icon-error">
            <IconAlert size={24} />
          </span>
          <h1>Something went wrong</h1>
          <p>{current.message}</p>
          <button type="button" className="shop-button shop-button-primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const { related } = current.data
  const item = current.data.product
  const quote = isQuote(item)
  const paragraphs = item.description.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean)

  return (
    <div className="shop-container shop-product">
      <nav className="shop-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link to="/">Home</Link>
          </li>
          <li>
            <Link to="/products">Products</Link>
          </li>
          <li>
            <Link to={`/products?category=${encodeURIComponent(item.category.slug)}`}>{item.category.name}</Link>
          </li>
          <li aria-current="page">{item.name}</li>
        </ol>
      </nav>

      <div className="shop-product-main">
        <Gallery key={item.id} images={item.images} name={item.name} />

        <div className="shop-product-info">
          <span className="shop-product-meta">
            {item.category.name}
            {item.brand && (
              <>
                {' · '}Brand: <span className="shop-product-brand">{item.brand}</span>
              </>
            )}
          </span>
          <h1>{item.name}</h1>
          <div className="shop-product-status">
            <span className={`shop-pill ${item.inStock ? 'shop-pill-ok' : 'shop-pill-out'}`}>
              {item.inStock ? <IconCheck size={14} /> : <IconClose size={14} />}
              {item.inStock ? 'In stock' : 'Out of stock'}
            </span>
            <span className="shop-product-sku">SKU {item.sku}</span>
          </div>

          {quote ? (
            <p className="shop-product-price shop-product-price-quote">Request quotation</p>
          ) : (
            <p className="shop-product-price">{formatTzs(item.priceTzs as number)}</p>
          )}

          <AddToCart key={item.id} product={item} />

          <Link to="/#contact" className="shop-button shop-button-quote shop-product-quote">
            <IconDocument size={18} />
            {quote ? 'Ask PSP for a quotation' : 'Request a quotation for bulk or tender orders'}
          </Link>

          <ul className="shop-product-notes">
            <li>
              <IconTruck size={20} />
              Delivery across Tanzania
            </li>
            <li>
              <IconWrench size={20} />
              Installation and staff training available
            </li>
          </ul>
        </div>
      </div>

      {paragraphs.length > 0 && (
        <section className="shop-product-section" aria-labelledby="product-description">
          <h2 id="product-description">Description</h2>
          <div className="shop-product-description">
            {paragraphs.map((text, index) => (
              <p key={index}>{text}</p>
            ))}
          </div>
        </section>
      )}

      {item.specs.length > 0 && (
        <section className="shop-product-section" aria-labelledby="product-specs">
          <h2 id="product-specs">Specifications</h2>
          <table className="shop-specs">
            <tbody>
              {item.specs.map((spec, index) => (
                <tr key={index}>
                  <th scope="row">{spec.label}</th>
                  <td>{spec.value || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {related.length > 0 && (
        <section className="shop-product-section" aria-labelledby="product-related">
          <h2 id="product-related">Related equipment</h2>
          <ul className="shop-grid">
            {related.map((other) => (
              <li key={other.id}>
                <ProductCard product={other} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// Big photo with thumbnails. Arrow keys, Home/End, the side buttons, the thumbnails
// and a sideways swipe all change the photo.
function Gallery({ images, name }: { images: string[]; name: string }) {
  const [index, setIndex] = useState(0)
  const swipeFrom = useRef<number | null>(null)
  const thumbs = useRef<(HTMLButtonElement | null)[]>([])
  const count = images.length

  if (count === 0) {
    return (
      <div className="shop-gallery">
        <div className="shop-gallery-main shop-gallery-empty">
          <IconImage size={48} />
          <span>No photo yet</span>
        </div>
      </div>
    )
  }

  const wrap = (n: number) => (n + count) % count

  // Returns the photo the key leads to, or null for other keys.
  function target(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') return wrap(index + 1)
    if (event.key === 'ArrowLeft') return wrap(index - 1)
    if (event.key === 'Home') return 0
    if (event.key === 'End') return count - 1
    return null
  }

  function onMainKey(event: KeyboardEvent) {
    const next = target(event)
    if (next === null) return
    event.preventDefault()
    setIndex(next)
  }

  function onThumbKey(event: KeyboardEvent) {
    const next = target(event)
    if (next === null) return
    event.preventDefault()
    setIndex(next)
    thumbs.current[next]?.focus()
  }

  function onPointerUp(event: PointerEvent) {
    if (swipeFrom.current === null) return
    const moved = event.clientX - swipeFrom.current
    swipeFrom.current = null
    if (Math.abs(moved) >= SWIPE_PX) setIndex(wrap(moved < 0 ? index + 1 : index - 1))
  }

  const many = count > 1

  return (
    <div className="shop-gallery">
      <div
        className="shop-gallery-main"
        tabIndex={many ? 0 : undefined}
        role={many ? 'group' : undefined}
        aria-roledescription={many ? 'gallery' : undefined}
        aria-label={many ? `Product photos, ${index + 1} of ${count}. Use the arrow keys to see more.` : undefined}
        onKeyDown={many ? onMainKey : undefined}
        onPointerDown={many ? (event) => (swipeFrom.current = event.clientX) : undefined}
        onPointerUp={many ? onPointerUp : undefined}
        onPointerCancel={() => (swipeFrom.current = null)}
      >
        <img
          src={imageSrc(images[index])}
          alt={many ? `${name}, photo ${index + 1} of ${count}` : name}
          width="800"
          height="600"
          decoding="async"
          draggable={false}
        />
        {many && (
          <>
            <button
              type="button"
              className="shop-gallery-step shop-gallery-prev"
              aria-label="Previous photo"
              tabIndex={-1}
              onClick={() => setIndex(wrap(index - 1))}
            >
              <IconChevronLeft size={20} />
            </button>
            <button
              type="button"
              className="shop-gallery-step shop-gallery-next"
              aria-label="Next photo"
              tabIndex={-1}
              onClick={() => setIndex(wrap(index + 1))}
            >
              <IconChevronRight size={20} />
            </button>
            <span className="shop-gallery-count" aria-hidden="true">
              {index + 1} / {count}
            </span>
          </>
        )}
      </div>

      {many && (
        <ul className="shop-gallery-thumbs" aria-label="Choose a photo">
          {images.map((url, n) => (
            <li key={url + n}>
              <button
                type="button"
                ref={(element) => {
                  thumbs.current[n] = element
                }}
                className="shop-gallery-thumb"
                aria-label={`Show photo ${n + 1} of ${count}`}
                aria-current={n === index ? 'true' : undefined}
                tabIndex={n === index ? 0 : -1}
                onClick={() => setIndex(n)}
                onKeyDown={onThumbKey}
              >
                <img src={imageSrc(url)} alt="" width="64" height="64" loading="lazy" decoding="async" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type Notice = { ok: boolean; text: string } | null

// Quantity stepper and "Add to cart". The cart module stores only the id and quantity.
function AddToCart({ product }: { product: ShopProductDetail }) {
  const [draft, setDraft] = useState('1')
  const [notice, setNotice] = useState<Notice>(null)
  const quantity = clampQuantity(Number.parseInt(draft, 10) || 1)
  const out = !product.inStock

  function change(next: string) {
    setDraft(next)
    setNotice(null)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (out) return
    setDraft(String(quantity))
    const result = addToCart(product.id, quantity)
    if (!result.ok) {
      setNotice({
        ok: false,
        text:
          result.reason === 'full'
            ? `Your cart is full (${MAX_LINES} products). Remove something to add this one.`
            : 'Your browser did not let us save the cart. Allow site data for this shop and try again.',
      })
      return
    }
    rememberPrice(product.id, isQuote(product) ? null : product.priceTzs)
    setNotice({
      ok: true,
      text: result.capped
        ? `Your cart now holds ${result.quantity} × ${product.name}, the most for one product.`
        : `Added ${quantity} × ${product.name} to your cart.`,
    })
  }

  return (
    <form className="shop-buy" onSubmit={submit} aria-label="Buy">
      <div className="shop-buy-row">
        <div className="shop-stepper" role="group" aria-label="Quantity">
          <button
            type="button"
            aria-label="Decrease quantity"
            disabled={out || quantity <= 1}
            onClick={() => change(String(clampQuantity(quantity - 1)))}
          >
            <IconMinus size={18} />
          </button>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label="Quantity"
            value={draft}
            disabled={out}
            onChange={(event) => change(event.target.value.replace(/\D/g, '').slice(0, 2))}
            onBlur={() => setDraft(String(quantity))}
          />
          <button
            type="button"
            aria-label="Increase quantity"
            disabled={out || quantity >= MAX_QUANTITY}
            onClick={() => change(String(clampQuantity(quantity + 1)))}
          >
            <IconPlus size={18} />
          </button>
        </div>
        <button
          type="submit"
          className="shop-button shop-button-primary shop-buy-add"
          disabled={out}
          aria-describedby={out ? 'buy-out-of-stock' : undefined}
        >
          <IconCart size={18} />
          Add to cart
        </button>
      </div>
      {out && (
        <p id="buy-out-of-stock" className="shop-buy-hint">
          Out of stock at the moment. Contact us for the next delivery date.
        </p>
      )}
      <p className={`shop-buy-notice${notice && !notice.ok ? ' is-error' : ''}`} role="status">
        {notice && (
          <>
            {notice.ok ? <IconCheck size={18} /> : <IconAlert size={18} />}
            <span>
              {notice.text} {notice.ok && <Link to="/cart">View cart</Link>}
            </span>
          </>
        )}
      </p>
    </form>
  )
}

// Same shape as the loaded page, so nothing jumps.
function ProductSkeleton() {
  return (
    <div className="shop-container shop-product" aria-busy="true">
      <p className="shop-visually-hidden" role="status">
        Loading product…
      </p>
      <div className="shop-breadcrumb" aria-hidden="true">
        <span className="shop-skeleton-line shop-product-skeleton-crumb" />
      </div>
      <div className="shop-product-main" aria-hidden="true">
        <div className="shop-gallery">
          <div className="shop-gallery-main shop-skeleton-block" />
        </div>
        <div className="shop-product-info">
          <span className="shop-skeleton-line shop-product-skeleton-meta" />
          <span className="shop-skeleton-line shop-product-skeleton-title" />
          <span className="shop-skeleton-line shop-product-skeleton-title shop-product-skeleton-short" />
          <span className="shop-skeleton-line shop-product-skeleton-price" />
          <span className="shop-skeleton-block shop-product-skeleton-buy" />
        </div>
      </div>
    </div>
  )
}

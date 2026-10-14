import { Link } from 'react-router'
import { formatTzs, imageSrc, type ShopProduct } from './api'
import { IconArrow, IconCheck, IconClose, IconImage } from './Icons'

// One catalogue tile, as in the design preview's product grid. The product page
// itself arrives in C3; the cart buttons in C4.
export default function ProductCard({ product }: { product: ShopProduct }) {
  const href = `/products/${product.slug}`
  const quote = product.requestQuotation || product.priceTzs === null

  return (
    <article className="shop-card">
      <div className="shop-card-media">
        {product.imageUrl ? (
          <img src={imageSrc(product.imageUrl)} alt="" loading="lazy" decoding="async" width="400" height="300" />
        ) : (
          <span className="shop-card-noimage">
            <IconImage size={36} />
          </span>
        )}
        <span className={`shop-pill shop-card-stock ${product.inStock ? 'shop-pill-ok' : 'shop-pill-out'}`}>
          {product.inStock ? <IconCheck size={14} /> : <IconClose size={14} />}
          {product.inStock ? 'In stock' : 'Out of stock'}
        </span>
      </div>

      <div className="shop-card-body">
        <span className="shop-card-category">{product.category.name}</span>
        <h3 className="shop-card-title">
          <Link to={href}>{product.name}</Link>
        </h3>
        {product.brand && <span className="shop-card-brand">{product.brand}</span>}
        {quote ? (
          <span className="shop-card-price shop-card-price-quote">Price on request</span>
        ) : (
          <span className="shop-card-price">{formatTzs(product.priceTzs as number)}</span>
        )}
        <Link to={href} className="shop-card-action" tabIndex={-1} aria-hidden="true">
          View details
          <IconArrow size={16} />
        </Link>
      </div>
    </article>
  )
}

// Same box as a real card, so nothing jumps when the products arrive.
export function ProductCardSkeleton() {
  return (
    <div className="shop-card shop-card-skeleton" aria-hidden="true">
      <div className="shop-card-media shop-skeleton-block" />
      <div className="shop-card-body">
        <span className="shop-skeleton-line" />
        <span className="shop-skeleton-line shop-skeleton-line-lg" />
        <span className="shop-skeleton-line shop-skeleton-line-lg" />
        <span className="shop-skeleton-line shop-skeleton-line-xl" />
        <span className="shop-card-action shop-skeleton-block" />
      </div>
    </div>
  )
}

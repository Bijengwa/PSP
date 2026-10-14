import { Link } from 'react-router'
import { IconArrow, IconSearch } from './Icons'
import PageMeta from './PageMeta'

// Any public address the shop does not know, inside the shop layout.
export default function NotFoundPage() {
  return (
    <div className="shop-container shop-not-found">
      <PageMeta title="Page not found" description="This page does not exist on the PSP Engineering Group shop." />
      <div className="shop-state">
        <span className="shop-state-icon">
          <IconSearch size={24} />
        </span>
        <span className="shop-not-found-code">404</span>
        <h1>Page not found</h1>
        <p>The page you are looking for does not exist. It may have moved, or the link may be wrong.</p>
        <div className="shop-not-found-actions">
          <Link to="/products" className="shop-button shop-button-primary">
            Browse products
            <IconArrow size={18} />
          </Link>
          <Link to="/" className="shop-button shop-button-secondary">
            Go to the home page
          </Link>
        </div>
      </div>
    </div>
  )
}

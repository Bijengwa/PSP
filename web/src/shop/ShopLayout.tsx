import { Suspense, useEffect, useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useCartCount } from './cart'
import { IconCart, IconClose, IconMenu, IconPhone, IconPin, IconSearch } from './Icons'
import ThemeToggle from './ThemeToggle'
import './shop.css'

// Placeholder as in the design until PSP supplies the real number.
const PHONE = '+255 [PHONE NUMBER]'

const NAV = [
  { to: '/products', label: 'Products' },
  { to: '/#categories', label: 'Categories' },
  { to: '/#services', label: 'Services' },
  { to: '/#contact', label: 'Contact' },
]

export default function ShopLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const cartCount = useCartCount()
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')

  // Scroll to in-page anchors (the drawer closes from its own link clicks).
  useEffect(() => {
    if (location.hash) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView()
    } else {
      window.scrollTo(0, 0)
    }
  }, [location.pathname, location.hash])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  function search(event: FormEvent) {
    event.preventDefault()
    const q = query.trim()
    navigate(q ? `/products?q=${encodeURIComponent(q)}` : '/products')
  }

  return (
    <div className="shop">
      <a className="shop-skip" href="#main">
        Skip to content
      </a>

      <div className="shop-topbar">
        <div className="shop-container shop-topbar-inner">
          <div className="shop-topbar-group">
            <span className="shop-topbar-item">
              <IconPin size={14} />
              Dar es Salaam, Tanzania
            </span>
            <span className="shop-topbar-item">
              <IconPhone size={14} />
              {PHONE}
            </span>
            <span className="shop-topbar-item shop-from-md">Mon–Sat, 8:00–18:00</span>
          </div>
          <div className="shop-topbar-group">
            <span className="shop-topbar-item shop-from-lg">Delivery across Tanzania</span>
            <ThemeToggle />
          </div>
        </div>
      </div>

      <header className="shop-header">
        <div className="shop-container shop-header-inner">
          <button
            type="button"
            className="shop-menu-button"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls="shop-nav"
            onClick={() => setMenuOpen(true)}
          >
            <IconMenu size={22} />
          </button>

          <Link to="/" className="shop-brand">
            <span className="shop-brand-name">PSP Engineering Group</span>
            <span className="shop-brand-sub">Medical equipment · Tanzania</span>
          </Link>

          <nav id="shop-nav" className={`shop-nav${menuOpen ? ' is-open' : ''}`} aria-label="Main">
            <div className="shop-nav-head">
              <span className="shop-brand-name">Menu</span>
              <button
                type="button"
                className="shop-menu-button"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
              >
                <IconClose size={22} />
              </button>
            </div>
            <ul>
              {NAV.map((item) => (
                <li key={item.label}>
                  <NavLink
                    to={item.to}
                    end
                    className={({ isActive }) => `shop-nav-link${isActive && !item.to.includes('#') ? ' active' : ''}`}
                    onClick={() => setMenuOpen(false)}
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          {menuOpen && <div className="shop-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

          <form className="shop-search" role="search" onSubmit={search}>
            <label>
              <IconSearch size={18} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search equipment, brand or SKU"
                aria-label="Search products"
                autoComplete="off"
              />
            </label>
          </form>

          <Link to="/cart" className="shop-cart" aria-label={`Cart, ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}>
            <IconCart size={18} />
            <span className="shop-cart-text">Cart</span>
            {cartCount > 0 && <span className="shop-badge">{cartCount > 99 ? '99+' : cartCount}</span>}
          </Link>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <Suspense fallback={<p className="shop-placeholder">Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>

      <footer id="contact" className="shop-footer">
        <div className="shop-container">
          <div className="shop-footer-grid">
            <div className="shop-footer-col">
              <span className="shop-footer-brand">PSP Engineering Group</span>
              <p>
                Importer and distributor of medical equipment for hospitals, clinics, laboratories and pharmacies in
                Tanzania.
              </p>
            </div>
            <div className="shop-footer-col">
              <h2>Shop</h2>
              <Link to="/products">All products</Link>
              <Link to="/products?category=patient-monitoring">Patient monitoring</Link>
              <Link to="/products?category=imaging">Imaging</Link>
              <Link to="/products?category=hospital-furniture">Hospital furniture</Link>
            </div>
            <div className="shop-footer-col">
              <h2>Services</h2>
              <span>Installation and training</span>
              <span>Maintenance and repair</span>
              <span>Request a quotation</span>
            </div>
            <div className="shop-footer-col">
              <h2>Contact</h2>
              <span>[STREET ADDRESS], Dar es Salaam</span>
              <span>{PHONE}</span>
              <span>Mon–Sat, 8:00–18:00</span>
            </div>
          </div>
          <div className="shop-footer-bottom">
            <span>© {new Date().getFullYear()} PSP Engineering Group</span>
            <span>Prices in Tanzanian shillings (TSh)</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

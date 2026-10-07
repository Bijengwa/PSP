import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Link, NavLink } from 'react-router'
import { apiRequest } from '../../../api/client'
import { OFFICE_HOME_PATH, useAuth } from '../../auth/AuthProvider'

// Simple line icons (24x24, stroke = currentColor) so they follow the theme.
const ICON_PATHS: Record<string, ReactNode> = {
  home: (
    <>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  products: (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ),
  addProduct: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  inventory: (
    <>
      <path d="M12 3l9 4.5-9 4.5-9-4.5z" />
      <path d="M3 12l9 4.5 9-4.5" />
      <path d="M3 16.5L12 21l9-4.5" />
    </>
  ),
  orders: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  customers: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" />
    </>
  ),
  staff: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <circle cx="12" cy="10" r="3" />
      <path d="M7.5 18a4.5 4.5 0 0 1 9 0" />
    </>
  ),
  resetRequests: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8-8M16 7l2 2M14 9l2 2" />
    </>
  ),
  reports: (
    <>
      <path d="M4 20h16" />
      <path d="M7 16v-5M12 16V6M17 16v-8" />
    </>
  ),
  notifications: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  store: (
    <>
      <path d="M4 9l1.5-5h13L20 9" />
      <path d="M4 9h16v2a3 3 0 0 1-5.33 1.9A3 3 0 0 1 12 14a3 3 0 0 1-2.67-1.1A3 3 0 0 1 4 11z" />
      <path d="M5 13.5V20h14v-6.5" />
    </>
  ),
  arrow: <path d="M7 17L17 7M9 7h8v8" />,
}

type IconName = keyof typeof ICON_PATHS

function NavIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="office-nav-icon"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

export const RESET_REQUESTS_PATH = '/office/reset-requests'
// The reset-requests page fires this after a reset or dismissal, so the badge
// updates without waiting for its next refresh.
export const RESET_REQUESTS_CHANGED = 'psp:reset-requests-changed'
const BADGE_REFRESH_MS = 60 * 1000

// Sidebar navigation, grouped as in docs/management-plan.md §2.
// Header.tsx reads it for page titles. Exporting it here only costs a full reload
// (instead of fast refresh) when this file changes.
// eslint-disable-next-line react-refresh/only-export-components
export const NAV_GROUPS: {
  label: string
  items: { label: string; to: string; icon: IconName; adminOnly?: boolean }[]
}[] = [
  { label: 'Overview', items: [{ label: 'Home', to: OFFICE_HOME_PATH, icon: 'home' }] },
  {
    label: 'Catalog',
    items: [
      { label: 'Products', to: '/office/products', icon: 'products' },
      { label: 'Add Product', to: '/office/products/new', icon: 'addProduct' },
      { label: 'Inventory', to: '/office/inventory', icon: 'inventory' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Orders', to: '/office/orders', icon: 'orders' },
      { label: 'Customers', to: '/office/customers', icon: 'customers' },
    ],
  },
  {
    label: 'Management',
    items: [
      { label: 'Staff', to: '/office/staff', icon: 'staff' },
      { label: 'Reset requests', to: RESET_REQUESTS_PATH, icon: 'resetRequests', adminOnly: true },
      { label: 'Reports', to: '/office/reports', icon: 'reports' },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Notifications', to: '/office/notifications', icon: 'notifications' },
      { label: 'Settings', to: '/office/settings', icon: 'settings' },
    ],
  },
]

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}

// Pending forgot-password requests, for the sidebar badge. Admins only; it
// refreshes every minute and whenever the reset-requests page changes the queue.
function usePendingResetCount(enabled: boolean) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let controller: AbortController | null = null
    function load() {
      controller?.abort()
      controller = new AbortController()
      apiRequest<{ total: number }>('/api/office/reset-requests?status=pending', { signal: controller.signal }).then(
        (result) => {
          if (result.ok) setCount(result.data.total)
        },
        () => {}, // aborted
      )
    }
    load()
    const timer = window.setInterval(load, BADGE_REFRESH_MS)
    window.addEventListener(RESET_REQUESTS_CHANGED, load)
    return () => {
      controller?.abort()
      window.clearInterval(timer)
      window.removeEventListener(RESET_REQUESTS_CHANGED, load)
    }
  }, [enabled])

  return enabled ? count : 0
}

type SidebarProps = {
  id: string
  drawerOpen: boolean
  drawerShown: boolean
  closeButtonRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}

// The office sidebar. On mobile it is an overlay drawer; OfficeLayout owns its state.
export default function Sidebar({ id, drawerOpen, drawerShown, closeButtonRef, onClose }: SidebarProps) {
  const { state } = useAuth()
  const isAdmin = state.status === 'authenticated' && state.staff.role === 'admin'
  const pendingResets = usePendingResetCount(isAdmin)

  return (
    <aside
      id={id}
      className={drawerOpen ? 'office-aside office-aside-open' : 'office-aside'}
      role={drawerShown ? 'dialog' : undefined}
      aria-modal={drawerShown || undefined}
      aria-label={drawerShown ? 'Office navigation' : undefined}
    >
      <div className="office-aside-head">
        <Link to={OFFICE_HOME_PATH} className="office-brand" onClick={onClose}>
          <span className="office-brand-mark" aria-hidden="true">
            P
          </span>
          <span className="office-brand-text">
            <span className="office-brand-name">PSP Engineering</span>
            <span className="office-brand-sub">Admin portal</span>
          </span>
        </Link>
        <button
          ref={closeButtonRef}
          type="button"
          className="office-icon-button office-drawer-close"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>

      <nav className="office-nav" aria-label="Office">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="office-nav-group">
            <h2 id={`office-nav-${group.label}`} className="office-nav-heading">
              {group.label}
            </h2>
            <ul className="office-nav-list" aria-labelledby={`office-nav-${group.label}`}>
              {group.items
                .filter((item) => isAdmin || !item.adminOnly)
                .map((item) => {
                  const badge = item.to === RESET_REQUESTS_PATH ? pendingResets : 0
                  return (
                    <li key={item.to}>
                      {/* `end` keeps Products from staying active on /office/products/new. */}
                      <NavLink
                        to={item.to}
                        end
                        className="office-nav-link"
                        aria-label={badge > 0 ? `${item.label}, ${badge} pending` : undefined}
                        onClick={onClose}
                      >
                        <NavIcon name={item.icon} />
                        <span>{item.label}</span>
                        {badge > 0 && (
                          <span className="office-nav-badge" aria-hidden="true">
                            {badge > 99 ? '99+' : badge}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  )
                })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="office-aside-foot">
        <a href="/" className="office-store-link" target="_blank" rel="noopener">
          <NavIcon name="store" />
          <span className="office-store-text">
            <span className="office-store-title">View the store</span>
            <span className="office-store-sub">See it as customers do</span>
          </span>
          <NavIcon name="arrow" size={16} />
        </a>
      </div>
    </aside>
  )
}

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { OFFICE_HOME_PATH, useAuth, type Staff } from '../auth/AuthProvider'

// Built in M2.1; until then this route shows a placeholder inside the shell.
export const CHANGE_PASSWORD_PATH = '/office/auth/change-password'

// Sidebar navigation, grouped as in docs/management-plan.md §2.
const NAV_GROUPS = [
  { label: 'Home', items: [{ label: 'Home', to: OFFICE_HOME_PATH }] },
  {
    label: 'Catalog',
    items: [
      { label: 'Products', to: '/office/products' },
      { label: 'Add Product', to: '/office/products/new' },
      { label: 'Inventory', to: '/office/inventory' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Orders', to: '/office/orders' },
      { label: 'Customers', to: '/office/customers' },
    ],
  },
  {
    label: 'Management',
    items: [
      { label: 'Staff', to: '/office/staff' },
      { label: 'Reports', to: '/office/reports' },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Notifications', to: '/office/notifications' },
      { label: 'Settings', to: '/office/settings' },
    ],
  },
]

// Header titles for every office route; anything else is the Not found page.
const PAGE_TITLES: Record<string, string> = Object.fromEntries([
  ...NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.to, item.label])),
  [CHANGE_PASSWORD_PATH, 'Change password'],
])

function pageTitle(pathname: string) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return PAGE_TITLES[path] ?? 'Not found'
}

function initials(fullName: string) {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
}

// Closes an open popover on Escape (returning focus to its button) and on a
// pointer press outside `containerRef`.
function useDismiss(open: boolean, containerRef: RefObject<HTMLElement | null>, close: (refocus: boolean) => void) {
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) close(false)
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, containerRef, close])
}

// True when keyboard focus moves from inside the popover to somewhere outside it.
function focusLeft(event: FocusEvent<HTMLElement>) {
  const next = event.relatedTarget as Node | null
  return next !== null && !event.currentTarget.contains(next)
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Notifications button with a non-modal popover. Real notifications arrive in M7+.
function NotificationsPopover() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])
  useDismiss(open, containerRef, close)

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  return (
    <div className="office-popover-anchor" ref={containerRef} onBlur={(event) => focusLeft(event) && close(false)}>
      <button
        ref={buttonRef}
        type="button"
        className="office-icon-button"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <BellIcon />
      </button>
      {open && (
        <div ref={panelRef} id={panelId} className="office-popover" role="dialog" aria-label="Notifications" tabIndex={-1}>
          <p className="office-popover-heading">Notifications</p>
          <p className="office-popover-empty">No notifications</p>
        </div>
      )}
    </div>
  )
}

// Profile button with a menu (WAI-ARIA menu button pattern): arrow keys, Home
// and End move between items; Escape, Tab and outside clicks close it.
function ProfileMenu({ staff }: { staff: Staff }) {
  const [open, setOpen] = useState(false)
  const [focusTarget, setFocusTarget] = useState<'first' | 'last'>('first')
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const buttonId = useId()
  const menuId = useId()

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])
  useDismiss(open, containerRef, close)

  function menuItems() {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  }

  useEffect(() => {
    if (!open) return
    const items = menuItems()
    items[focusTarget === 'first' ? 0 : items.length - 1]?.focus()
  }, [open, focusTarget])

  function openMenu(target: 'first' | 'last') {
    setFocusTarget(target)
    setOpen(true)
  }

  function onButtonKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(event.key === 'ArrowDown' ? 'first' : 'last')
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const items = menuItems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Tab') close(false)
    if (next !== null) {
      event.preventDefault()
      items[next]?.focus()
    }
  }

  return (
    <div className="office-popover-anchor" ref={containerRef} onBlur={(event) => focusLeft(event) && close(false)}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="office-profile-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu('first'))}
        onKeyDown={onButtonKeyDown}
      >
        <span className="office-avatar" aria-hidden="true">
          {initials(staff.fullName)}
        </span>
        <span className="office-user-text">
          <b>{staff.fullName}</b>
          <span>{staff.role}</span>
        </span>
      </button>
      {open && (
        <div className="office-popover office-popover-menu">
          <div className="office-menu-identity">
            <b>{staff.fullName}</b>
            <span>{staff.role}</span>
          </div>
          <ul ref={menuRef} id={menuId} className="office-menu" role="menu" aria-labelledby={buttonId} onKeyDown={onMenuKeyDown}>
            <li role="none">
              {/* The own-profile page is built in M4.3. */}
              <span role="menuitem" tabIndex={-1} aria-disabled="true" className="office-menu-item" title="Available later">
                Profile
              </span>
            </li>
            <li role="none">
              <Link role="menuitem" tabIndex={-1} className="office-menu-item" to={CHANGE_PASSWORD_PATH} onClick={() => close(false)}>
                Change password
              </Link>
            </li>
            <li role="none">
              <Link role="menuitem" tabIndex={-1} className="office-menu-item" to="/office/settings" onClick={() => close(false)}>
                Settings
              </Link>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}

// The office layout: sidebar, header (page title, notifications, profile menu,
// logout) and a workspace where the current office page renders (<Outlet />).
export default function OfficeLayout() {
  const { state, logout } = useAuth()
  const { pathname } = useLocation()
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // RequireAuth only renders this page for an authenticated staff member.
  if (state.status !== 'authenticated') return null
  const { staff } = state

  async function handleLogout() {
    setLoggingOut(true)
    setError(null)
    const result = await logout()
    // On success the auth state changes and RequireAuth sends the person to login.
    if (!result.ok) {
      setLoggingOut(false)
      setError(result.message)
    }
  }

  return (
    <div className="office">
      <aside className="office-aside">
        <Link to={OFFICE_HOME_PATH} className="office-brand">
          <span className="office-brand-name">PSP Engineering Group</span>
          <span className="office-brand-sub">Admin portal</span>
        </Link>
        <nav className="office-nav" aria-label="Office">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="office-nav-group">
              <h2 id={`office-nav-${group.label}`} className="office-nav-heading">
                {group.label}
              </h2>
              <ul className="office-nav-list" aria-labelledby={`office-nav-${group.label}`}>
                {group.items.map((item) => (
                  <li key={item.to}>
                    {/* `end` keeps Products from staying active on /office/products/new. */}
                    <NavLink to={item.to} end className="office-nav-link">
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="office-body">
        <header className="office-topbar">
          {/* Not a heading: each workspace page has its own h1. */}
          <p className="office-topbar-title">{pageTitle(pathname)}</p>
          <div className="office-topbar-actions">
            <NotificationsPopover />
            <ProfileMenu staff={staff} />
            {/* Moves to Settings in M1.7. */}
            <button type="button" className="button button-secondary" onClick={handleLogout} disabled={loggingOut}>
              {loggingOut ? 'Logging out…' : 'Log out'}
            </button>
          </div>
        </header>

        <main className="office-main">
          {error && (
            <div className="office-error" role="alert">
              Could not log out: {error}
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  )
}

// Home page shown in the workspace at /office.
export function OfficeHome() {
  const { state } = useAuth()
  if (state.status !== 'authenticated') return null

  return (
    <>
      <h1 className="office-title">Home</h1>
      <p className="office-lead">Welcome, {state.staff.fullName}.</p>
    </>
  )
}

// Placeholder for a workspace page whose module is not built yet: the title only.
export function PlaceholderPage({ title }: { title: string }) {
  return <h1 className="office-title">{title}</h1>
}

// Unknown /office/* paths, shown inside the shell.
export function OfficeNotFound() {
  return (
    <>
      <h1 className="office-title">Not found</h1>
      <p className="office-lead">This page does not exist.</p>
      <Link to={OFFICE_HOME_PATH}>Go to Home</Link>
    </>
  )
}

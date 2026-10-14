import type { RefObject } from 'react'
import { useLocation } from 'react-router'
import type { Staff } from '../../auth/AuthProvider'
import NotificationsPopover from './NotificationsPopover'
import ProfileMenu from './ProfileMenu'
import { NAV_GROUPS } from './Sidebar'

// Header titles for every office route; anything else is the Not found page.
const PAGE_TITLES: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.to, item.label])),
)

function pageTitle(pathname: string) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (/^\/office\/products\/[^/]+$/.test(path) && !PAGE_TITLES[path]) return 'Edit Product'
  if (/^\/office\/staff\/[^/]+$/.test(path) && !PAGE_TITLES[path]) return 'Staff Profile'
  if (path === '/office/customers/new') return 'Add Customer'
  if (/^\/office\/customers\/[^/]+\/edit$/.test(path)) return 'Edit Customer'
  if (path === '/office/profile') return 'My Profile'
  return PAGE_TITLES[path] ?? 'Not found'
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
    </svg>
  )
}

type HeaderProps = {
  staff: Staff
  drawerId: string
  drawerShown: boolean
  menuButtonRef: RefObject<HTMLButtonElement | null>
  onOpenDrawer: () => void
}

// The office header: drawer opener (mobile only; on desktop the toggle lives in the
// sidebar), page title, notifications and profile menu.
export default function Header({ staff, drawerId, drawerShown, menuButtonRef, onOpenDrawer }: HeaderProps) {
  const { pathname } = useLocation()

  return (
    <header className="office-topbar">
      <button
        ref={menuButtonRef}
        type="button"
        className="office-icon-button office-menu-toggle"
        aria-label="Open navigation"
        aria-expanded={drawerShown}
        aria-controls={drawerId}
        onClick={onOpenDrawer}
      >
        <MenuIcon />
      </button>
      {/* Not a heading: each workspace page has its own h1. */}
      <p className="office-topbar-title">{pageTitle(pathname)}</p>
      <div className="office-topbar-actions">
        <NotificationsPopover />
        <ProfileMenu staff={staff} />
      </div>
    </header>
  )
}

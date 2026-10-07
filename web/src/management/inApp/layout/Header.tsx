import type { RefObject } from 'react'
import { useLocation } from 'react-router'
import type { Staff } from '../../auth/AuthProvider'
import NotificationsPopover from './NotificationsPopover'
import ProfileMenu, { CHANGE_PASSWORD_PATH } from './ProfileMenu'
import { NAV_GROUPS } from './Sidebar'

// Header titles for every office route; anything else is the Not found page.
const PAGE_TITLES: Record<string, string> = Object.fromEntries([
  ...NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.to, item.label])),
  [CHANGE_PASSWORD_PATH, 'Change password'],
])

function pageTitle(pathname: string) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
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
  loggingOut: boolean
  onLogout: () => void
}

// The office header: hamburger (mobile), page title, notifications, profile menu and logout.
export default function Header({ staff, drawerId, drawerShown, menuButtonRef, onOpenDrawer, loggingOut, onLogout }: HeaderProps) {
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
        {/* Moves to Settings in M1.7. */}
        <button type="button" className="button button-secondary" onClick={onLogout} disabled={loggingOut}>
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </div>
    </header>
  )
}

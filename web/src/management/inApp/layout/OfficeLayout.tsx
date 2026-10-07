import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Outlet } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import Header from './Header'
import Sidebar from './Sidebar'

// Below this width the sidebar becomes an overlay drawer (matches index.css).
const MOBILE_QUERY = '(max-width: 768px)'

function subscribeToMobile(onChange: () => void) {
  const query = window.matchMedia(MOBILE_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function isMobileViewport() {
  return window.matchMedia(MOBILE_QUERY).matches
}

// The office layout: sidebar, header (page title, notifications, profile menu,
// logout) and a workspace where the current office page renders (<Outlet />).
// On mobile the sidebar is an overlay drawer opened from the header's hamburger.
export default function OfficeLayout() {
  const { state, logout } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isMobile = useSyncExternalStore(subscribeToMobile, isMobileViewport)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerShown = drawerOpen && isMobile
  const drawerId = useId()
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const drawerWasShown = useRef(false)

  // Focus moves into the drawer when it opens and back to the hamburger when it closes.
  useEffect(() => {
    if (drawerShown) closeButtonRef.current?.focus()
    else if (drawerWasShown.current) menuButtonRef.current?.focus()
    drawerWasShown.current = drawerShown
  }, [drawerShown])

  useEffect(() => {
    if (!drawerShown) return
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [drawerShown])

  const closeDrawer = () => setDrawerOpen(false)

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
      {/* Tapping outside the open drawer closes it; keyboard users have Escape and the close button. */}
      {drawerShown && <div className="office-backdrop" aria-hidden="true" onClick={closeDrawer} />}
      <Sidebar
        id={drawerId}
        drawerOpen={drawerOpen}
        drawerShown={drawerShown}
        closeButtonRef={closeButtonRef}
        onClose={closeDrawer}
      />

      {/* While the drawer is open the rest of the page cannot be focused or clicked. */}
      <div className="office-body" inert={drawerShown}>
        <Header
          staff={staff}
          drawerId={drawerId}
          drawerShown={drawerShown}
          menuButtonRef={menuButtonRef}
          onOpenDrawer={() => setDrawerOpen(true)}
          loggingOut={loggingOut}
          onLogout={handleLogout}
        />

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

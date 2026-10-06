import { useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
import { OFFICE_HOME_PATH, useAuth } from '../auth/AuthProvider'

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

function initials(fullName: string) {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
}

// The office layout: sidebar, top bar with the signed-in staff member and
// logout, and a workspace where the current office page renders (<Outlet />).
export default function OfficeLayout() {
  const { state, logout } = useAuth()
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
          <div className="office-user">
            <span className="office-avatar" aria-hidden="true">
              {initials(staff.fullName)}
            </span>
            <span className="office-user-text">
              <b>{staff.fullName}</b>
              <span>{staff.role}</span>
            </span>
          </div>
          <button type="button" className="button button-secondary" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
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

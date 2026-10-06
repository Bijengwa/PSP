import { useState } from 'react'
import { Link, NavLink } from 'react-router'
import { OFFICE_HOME_PATH, useAuth } from '../auth/AuthProvider'

function initials(fullName: string) {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
}

// The office shell: sidebar, top bar with the signed-in staff member and
// logout. Dashboard content comes in a later phase.
export default function Dashboard() {
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
          <NavLink to={OFFICE_HOME_PATH} end className="office-nav-link">
            Dashboard
          </NavLink>
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
          <h1 className="office-title">Dashboard</h1>
          <p className="office-lead">Welcome, {staff.fullName}.</p>
        </main>
      </div>
    </div>
  )
}

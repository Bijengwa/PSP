import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { LOGIN_PATH, useAuth } from '../../auth/AuthProvider'
import { CHANGE_PASSWORD_PATH } from '../../auth/AuthProvider'

// Home page shown in the workspace at /office.
export default function OfficeHome() {
  const { state } = useAuth()
  if (state.status !== 'authenticated') return null

  return (
    <>
      <h1 className="office-title">Home</h1>
      <p className="office-lead">Welcome, {state.staff.fullName}.</p>
    </>
  )
}

// The theme preference is applied by the script in index.html (before first
// paint, and again on 'storage' events), so this page only stores it and
// signals that script.
const THEME_KEY = 'psp-theme'
const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const
type ThemePreference = (typeof THEME_OPTIONS)[number]['value']

function readTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // Storage blocked: System.
  }
  return 'system'
}

function saveTheme(theme: ThemePreference) {
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Storage blocked: the theme stays as it was.
  }
  window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }))
}

// Settings at /office/settings: appearance, security and account (logout).
export function SettingsPage() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [theme, setTheme] = useState(readTheme)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function changeTheme(next: ThemePreference) {
    setTheme(next)
    saveTheme(next)
  }

  async function handleLogout() {
    setLoggingOut(true)
    setError(null)
    const result = await logout()
    if (result.ok) {
      // Replace this entry so Back does not return here; any other office page
      // in the history is sent to login by RequireAuth.
      navigate(LOGIN_PATH, { replace: true })
    } else {
      setLoggingOut(false)
      setError(result.message)
    }
  }

  return (
    <>
      <h1 className="office-title">Settings</h1>

      <section className="office-settings-section" aria-labelledby="settings-appearance">
        <h2 id="settings-appearance">Appearance</h2>
        <fieldset className="office-segmented">
          <legend>Theme</legend>
          {THEME_OPTIONS.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={theme === option.value}
                onChange={() => changeTheme(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        <p className="office-settings-hint">System follows your device setting.</p>
      </section>

      <section className="office-settings-section" aria-labelledby="settings-security">
        <h2 id="settings-security">Security</h2>
        <Link className="button button-secondary" to={CHANGE_PASSWORD_PATH}>
          Change password
        </Link>
      </section>

      <section className="office-settings-section" aria-labelledby="settings-account">
        <h2 id="settings-account">Account</h2>
        {error && (
          <div className="office-error" role="alert">
            Could not log out: {error}
          </div>
        )}
        <button type="button" className="button button-secondary" onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </section>
    </>
  )
}

import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import type { ApiResult } from '../../api/client'
import { LOGIN_PATH, OFFICE_HOME_PATH, useAuth } from './AuthProvider'
import './auth.css'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function errorMessage(result: Extract<ApiResult<unknown>, { ok: false }>) {
  switch (result.status) {
    case 401:
      return result.message // "Invalid email or password"
    case 429:
      return 'Too many attempts. Please wait a few minutes and try again.'
    case 503:
      return 'Sign-in is temporarily unavailable. Please try again shortly.'
    default:
      return result.message
  }
}

// Only send people back to office pages, never to an arbitrary location.
function redirectTarget(state: unknown) {
  const from = (state as { from?: unknown } | null)?.from
  if (typeof from === 'string' && from.startsWith(OFFICE_HOME_PATH) && !from.startsWith(LOGIN_PATH)) {
    return from
  }
  return OFFICE_HOME_PATH
}

export default function Login() {
  const { state, login } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (state.status === 'authenticated') {
    return <Navigate to={redirectTarget(location.state)} replace />
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const trimmedEmail = email.trim()
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setError('Enter a valid email address.')
      return
    }
    if (!password) {
      setError('Enter your password.')
      return
    }

    setError(null)
    setSubmitting(true)
    const result = await login(trimmedEmail, password)
    // On success the auth state changes and the redirect above takes over.
    if (!result.ok) {
      setSubmitting(false)
      setPassword('')
      setError(errorMessage(result))
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-name">PSP Engineering Group</span>
          <span className="auth-brand-sub">Admin portal</span>
        </div>

        <h1 className="auth-title">Log in</h1>
        <p className="auth-lead">Staff only. Use the email address IT registered for you.</p>

        <form className="auth-form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="field-input"
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              aria-invalid={error !== null}
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
          </label>

          <label className="field">
            <span className="field-label">Password</span>
            <input
              className="field-input"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error !== null}
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
          </label>

          <div id="login-error" className="auth-error" role="alert" hidden={!error}>
            {error}
          </div>

          <button type="submit" className="button button-primary auth-submit" disabled={submitting}>
            {submitting && <span className="spinner" aria-hidden="true" />}
            {submitting ? 'Logging in…' : 'Log in'}
          </button>
        </form>
      </div>
    </main>
  )
}

type FormError = { message: string; reasons: string[] }

function changeErrorMessage(result: Extract<ApiResult<unknown>, { ok: false }>): FormError {
  const reasons = Array.isArray(result.details) ? result.details.filter((d): d is string => typeof d === 'string') : []
  if (result.status === 503) return { message: 'The service is temporarily unavailable. Please try again shortly.', reasons }
  return { message: result.message, reasons }
}

// /office/auth/change-password, behind RequireAuth. While a temporary password
// is set the guard keeps the person here; otherwise it is the voluntary change
// reached from the Profile menu or Settings.
export function ChangePassword() {
  const { state, changePassword, logout } = useAuth()
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<FormError | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const forced = state.status === 'authenticated' && state.staff.mustChangePassword

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError({ message: 'Fill in all three fields.', reasons: [] })
      return
    }
    if (newPassword !== confirmPassword) {
      setError({ message: 'The new passwords do not match.', reasons: [] })
      return
    }
    if (newPassword === currentPassword) {
      setError({ message: 'Choose a password different from the current one.', reasons: [] })
      return
    }

    setError(null)
    setSubmitting(true)
    const result = await changePassword(currentPassword, newPassword)
    if (result.ok) {
      navigate(OFFICE_HOME_PATH, { replace: true })
      return
    }
    setSubmitting(false)
    if (result.code === 'INVALID_CURRENT_PASSWORD') setCurrentPassword('')
    setError(changeErrorMessage(result))
  }

  async function handleLogout() {
    const result = await logout()
    if (result.ok) navigate(LOGIN_PATH, { replace: true })
    else setError({ message: result.message, reasons: [] })
  }

  const describedBy = (...ids: string[]) => [...ids, ...(error ? ['change-error'] : [])].join(' ') || undefined

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-name">PSP Engineering Group</span>
          <span className="auth-brand-sub">Admin portal</span>
        </div>

        <h1 className="auth-title">{forced ? 'Choose a new password' : 'Change password'}</h1>
        <p className="auth-lead">
          {forced
            ? 'You signed in with a temporary password. Choose your own password to continue.'
            : 'Other devices will be signed out. You stay signed in here.'}
        </p>

        <form className="auth-form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
          <label className="field">
            <span className="field-label">{forced ? 'Temporary password' : 'Current password'}</span>
            <input
              className="field-input"
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error !== null}
              aria-describedby={describedBy()}
              required
            />
          </label>

          <label className="field">
            <span className="field-label">New password</span>
            <input
              className="field-input"
              type="password"
              name="newPassword"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error !== null}
              aria-describedby={describedBy('new-password-hint')}
              required
            />
            <span id="new-password-hint" className="field-hint">
              At least 10 characters, with upper and lower case letters, a digit and a symbol. Do not use your name
              or email.
            </span>
          </label>

          <label className="field">
            <span className="field-label">Confirm new password</span>
            <input
              className="field-input"
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error !== null}
              aria-describedby={describedBy()}
              required
            />
          </label>

          <div id="change-error" className="auth-error" role="alert" hidden={!error}>
            {error?.message}
            {error && error.reasons.length > 0 && (
              <ul className="auth-error-list">
                {error.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </div>

          <button type="submit" className="button button-primary auth-submit" disabled={submitting}>
            {submitting && <span className="spinner" aria-hidden="true" />}
            {submitting ? 'Saving…' : 'Change password'}
          </button>
        </form>

        <div className="auth-alt">
          {forced ? (
            <button type="button" className="button button-secondary auth-submit" onClick={handleLogout} disabled={submitting}>
              Log out
            </button>
          ) : (
            <Link className="button button-secondary auth-submit" to={OFFICE_HOME_PATH}>
              Cancel
            </Link>
          )}
        </div>
      </div>
    </main>
  )
}

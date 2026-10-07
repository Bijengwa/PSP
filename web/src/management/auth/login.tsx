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

// The password rules from the auth spec §7, mirroring passwordProblems in
// node/src/auth/password.js. The server stays authoritative; this list only
// shows each rule live while the person types. Keep the two in step.
const MIN_PASSWORD_LENGTH = 10
const MIN_PERSONAL_PART = 3
const COMMON_PASSWORDS = new Set([
  'password1!', 'password12!', 'password123!', 'passw0rd123!', 'p@ssword123', 'p@ssw0rd123',
  'welcome123!', 'welcome@123', 'qwerty123!', 'qwerty@123', 'admin@1234', 'admin12345!',
  'letmein123!', 'iloveyou123!', 'changeme123!', 'abcd@12345', 'abc123456!', 'summer2026!',
  'winter2026!', 'tanzania123!', 'company123!', 'psp@123456',
])

function personalParts(email: string, fullName: string) {
  const localPart = email.split('@')[0]
  return [...fullName.split(/\s+/), ...localPart.split(/[^a-z0-9]+/i)]
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= MIN_PERSONAL_PART)
}

function passwordRules(password: string, currentPassword: string, staff: { email: string; fullName: string } | null) {
  const lower = password.toLowerCase()
  const personal = staff ? personalParts(staff.email, staff.fullName) : []
  const typed = password.length > 0
  return [
    { label: `At least ${MIN_PASSWORD_LENGTH} characters`, met: password.length >= MIN_PASSWORD_LENGTH },
    { label: 'A lowercase letter', met: /[a-z]/.test(password) },
    { label: 'An uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'A digit', met: /[0-9]/.test(password) },
    { label: 'A symbol', met: /[^A-Za-z0-9]/.test(password) },
    { label: 'Not your name or email', met: typed && !personal.some((part) => lower.includes(part)) },
    { label: 'Not a common password', met: typed && !COMMON_PASSWORDS.has(lower) },
    { label: 'Different from the current password', met: typed && password !== currentPassword },
  ]
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

  const staff = state.status === 'authenticated' ? state.staff : null
  const forced = staff?.mustChangePassword ?? false
  const rules = passwordRules(newPassword, currentPassword, staff)

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
    if (rules.some((rule) => !rule.met)) {
      setError({ message: 'The new password does not meet every rule yet.', reasons: [] })
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
              aria-describedby={describedBy('new-password-rules')}
              required
            />
          </label>
          <ul id="new-password-rules" className="password-rules" aria-label="Password rules">
            {rules.map((rule) => (
              <li key={rule.label} className={rule.met ? 'password-rule is-met' : 'password-rule'}>
                <span className="password-rule-mark" aria-hidden="true" />
                {rule.label}
                <span className="visually-hidden">{rule.met ? ', met' : ', not met'}</span>
              </li>
            ))}
          </ul>

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

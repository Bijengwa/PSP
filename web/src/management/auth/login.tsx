import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
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

import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import { LOGIN_PATH, useAuth } from '../../auth/AuthProvider'
import { CHANGE_PASSWORD_PATH } from '../../auth/AuthProvider'
import { RESET_REQUESTS_CHANGED } from '../layout/Sidebar'

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

type ResetRequest = {
  id: string
  email: string
  createdAt: string
  staff: { id: string; fullName: string; isActive: boolean } | null
}

type QueueState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; requests: ResetRequest[]; total: number }

const REQUESTED_AT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function queueErrorMessage(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 403) return 'Only administrators can see reset requests.'
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

// Inline form on a queue row: IT types a temporary password and hands it to the
// person in person. The server checks its strength; its reasons are listed here.
function TemporaryPasswordForm({
  staff,
  onDone,
  onCancel,
}: {
  staff: NonNullable<ResetRequest['staff']>
  onDone: () => void
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; reasons: string[] } | null>(null)
  const inputId = `temporary-password-${staff.id}`
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await apiRequest<unknown>(`/api/office/staff/${staff.id}/reset-password`, {
      method: 'POST',
      body: { temporaryPassword: password },
    })
    if (result.ok) {
      onDone()
      return
    }
    setBusy(false)
    const reasons = Array.isArray(result.details) ? result.details.filter((d): d is string => typeof d === 'string') : []
    setError({ message: queueErrorMessage(result), reasons })
  }

  return (
    <form className="office-reset-form" onSubmit={handleSubmit} noValidate>
      <label className="office-reset-label" htmlFor={inputId}>
        Temporary password for {staff.fullName}
      </label>
      <input
        id={inputId}
        className="office-reset-input"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        aria-invalid={error ? true : undefined}
        disabled={busy}
        required
        autoFocus
      />
      <p id={hintId} className="office-settings-hint">
        At least 10 characters with upper and lower case letters, a digit and a symbol, and not their name or email.
        Give it to them in person; they must choose their own password at next login.
      </p>
      {error && (
        <div id={errorId} className="office-error" role="alert">
          {error.message}
          {error.reasons.length > 0 && (
            <ul>
              {error.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="office-reset-actions">
        <button type="submit" className="button button-primary" disabled={busy || !password}>
          {busy ? 'Saving…' : 'Set temporary password'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// /office/reset-requests (admins): forgot-password requests waiting for IT.
export function ResetRequestsPage() {
  const [queue, setQueue] = useState<QueueState>({ status: 'loading' })
  const [reload, setReload] = useState(0)
  const [openForm, setOpenForm] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ requests: ResetRequest[]; total: number }>('/api/office/reset-requests?status=pending', {
      signal: controller.signal,
    }).then(
      (result) => {
        if (result.ok) setQueue({ status: 'ready', ...result.data })
        else setQueue({ status: 'error', message: queueErrorMessage(result) })
      },
      () => {}, // aborted on unmount
    )
    return () => controller.abort()
  }, [reload])

  function queueChanged(message: string) {
    setNotice(message)
    setActionError(null)
    setOpenForm(null)
    setReload((n) => n + 1)
    window.dispatchEvent(new Event(RESET_REQUESTS_CHANGED))
  }

  async function dismiss(request: ResetRequest) {
    setDismissing(request.id)
    setNotice(null)
    setActionError(null)
    const result = await apiRequest<null>(`/api/office/reset-requests/${request.id}/dismiss`, { method: 'POST' })
    setDismissing(null)
    // 409: someone else already handled it, so it leaves the queue either way.
    if (result.ok || result.status === 409) queueChanged(`Request from ${request.email} dismissed.`)
    else setActionError(queueErrorMessage(result))
  }

  return (
    <>
      <h1 className="office-title">Reset requests</h1>
      <p className="office-lead">Forgot-password requests waiting for IT, oldest first.</p>

      <div className="office-reset-status" role="status">
        {notice}
      </div>
      {actionError && (
        <div className="office-error" role="alert">
          {actionError}
        </div>
      )}

      {queue.status === 'loading' && <p className="office-settings-hint">Loading…</p>}
      {queue.status === 'error' && (
        <div className="office-error" role="alert">
          {queue.message}
        </div>
      )}
      {queue.status === 'ready' && queue.requests.length === 0 && <p className="office-reset-empty">No pending requests.</p>}
      {queue.status === 'ready' && queue.requests.length > 0 && (
        <>
          {queue.total > queue.requests.length && (
            <p className="office-settings-hint">
              Showing the oldest {queue.requests.length} of {queue.total}.
            </p>
          )}
          <ul className="office-queue">
            {queue.requests.map((request) => (
              <li key={request.id} className="office-queue-item">
                <div className="office-queue-row">
                  <div className="office-queue-text">
                    <span className="office-queue-email">{request.email}</span>
                    <span className="office-queue-meta">
                      {REQUESTED_AT.format(new Date(request.createdAt))} ·{' '}
                      {request.staff
                        ? `${request.staff.fullName}${request.staff.isActive ? '' : ' (inactive)'}`
                        : 'No matching account'}
                    </span>
                  </div>
                  <div className="office-reset-actions">
                    {request.staff && openForm !== request.id && (
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => {
                          setNotice(null)
                          setOpenForm(request.id)
                        }}
                      >
                        Reset password
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => dismiss(request)}
                      disabled={dismissing === request.id}
                    >
                      {dismissing === request.id ? 'Dismissing…' : 'Dismiss'}
                    </button>
                  </div>
                </div>
                {request.staff && openForm === request.id && (
                  <TemporaryPasswordForm
                    staff={request.staff}
                    onDone={() =>
                      queueChanged(`Temporary password set for ${request.staff?.fullName}. Their sessions have ended.`)
                    }
                    onCancel={() => setOpenForm(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

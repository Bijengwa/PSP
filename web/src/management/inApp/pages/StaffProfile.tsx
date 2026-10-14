import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { apiRequest } from '../../../api/client'
import { CHANGE_PASSWORD_PATH, useAuth } from '../../auth/AuthProvider'
import '../../auth/auth.css'
import { initials } from '../layout/ProfileMenu'

type StaffDetail = {
  id: string
  fullName: string
  email: string
  phone: string | null
  role: string
  isActive: boolean
  mustChangePassword: boolean
  lastLoginAt: string | null
  createdAt: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; staff: StaffDetail }

type FieldName = 'fullName' | 'phone'
type FieldErrors = Partial<Record<FieldName, string>>

const STAFF_PATH = '/office/staff'
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const ROLE_LABELS: Record<string, string> = { admin: 'Admin', staff: 'Staff' }
const roleLabel = (role: string) => ROLE_LABELS[role] ?? role

function status(staff: StaffDetail) {
  if (!staff.isActive) return { label: 'Inactive', tone: 'inactive' }
  if (staff.mustChangePassword) return { label: 'Password change pending', tone: 'pending' }
  return { label: 'Active', tone: 'active' }
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function BackToStaff() {
  return (
    <Link className="office-back-link" to={STAFF_PATH}>
      <BackIcon />
      Staff
    </Link>
  )
}

// Avatar, name (the page heading), email and badges.
function ProfileHead({ fullName, email, children }: { fullName: string; email: string; children: ReactNode }) {
  return (
    <div className="office-profile-head">
      <span className="office-avatar office-avatar-large" aria-hidden="true">
        {initials(fullName)}
      </span>
      <div className="office-profile-identity">
        <h1 className="office-title">{fullName}</h1>
        <p className="office-profile-email">{email}</p>
        <div className="office-badges">{children}</div>
      </div>
    </div>
  )
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="office-profile-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const notSet = <span className="office-profile-empty">Not set</span>

// The form only catches what is cheap to see; the server stays the authority.
function validate(fullName: string, phone: string) {
  const errors: FieldErrors = {}
  if (!fullName.trim()) errors.fullName = 'Enter the full name.'
  else if (fullName.trim().replace(/\s+/g, ' ').length > 120) errors.fullName = 'Use at most 120 characters.'
  if (!phone.trim()) errors.phone = 'Enter a phone number.'
  return errors
}

type EditFormProps = { staff: StaffDetail; onSaved: (staff: StaffDetail) => void; onCancel: () => void }

// Name and phone, edited in place. Nothing typed is lost when a save fails.
function ContactForm({ staff, onSaved, onCancel }: EditFormProps) {
  const [fullName, setFullName] = useState(staff.fullName)
  const [phone, setPhone] = useState(staff.phone ?? '')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The field to focus once the inputs are enabled again (a new object each time).
  const [focusTarget, setFocusTarget] = useState<{ name: FieldName }>({ name: 'fullName' })
  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (saving) return
    ;(focusTarget.name === 'fullName' ? nameRef : phoneRef).current?.focus()
  }, [focusTarget, saving])

  function showErrors(errors: FieldErrors) {
    setFieldErrors(errors)
    if (errors.fullName) setFocusTarget({ name: 'fullName' })
    else if (errors.phone) setFocusTarget({ name: 'phone' })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return

    const errors = validate(fullName, phone)
    setFormError(null)
    if (Object.keys(errors).length > 0) {
      setFormError('Check the highlighted fields.')
      showErrors(errors)
      return
    }
    setFieldErrors({})

    setSaving(true)
    const result = await apiRequest<{ staff: StaffDetail }>(`/api/office/staff/${staff.id}`, {
      method: 'PATCH',
      body: { fullName, phone },
    })
    setSaving(false)

    if (result.ok) {
      onSaved(result.data.staff)
      return
    }

    // 401 and 503 are also handled by the auth provider (login / unavailable screen).
    if (result.status === 403) setFormError('Only administrators can edit staff profiles.')
    else if (result.status === 404) setFormError('This person no longer exists.')
    else if (result.status === 503) setFormError('The service is temporarily unavailable. Please try again shortly.')
    else setFormError(result.message)

    if (result.details && typeof result.details === 'object' && !Array.isArray(result.details)) {
      const details = result.details as Record<string, unknown>
      const next: FieldErrors = {}
      if (typeof details.fullName === 'string') next.fullName = details.fullName
      if (typeof details.phone === 'string') next.phone = details.phone
      showErrors(next)
    }
  }

  const describedBy = (name: FieldName, ...extra: string[]) =>
    [...extra, ...(fieldErrors[name] ? [`profile-${name}-error`] : [])].join(' ') || undefined

  return (
    <form className="office-profile-form" onSubmit={handleSubmit} noValidate aria-busy={saving}>
      <div className="field">
        <label className="field-label" htmlFor="profile-fullName">
          Full name
        </label>
        <input
          ref={nameRef}
          id="profile-fullName"
          className="field-input"
          name="fullName"
          autoComplete="off"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          disabled={saving}
          maxLength={200}
          aria-invalid={fieldErrors.fullName ? true : undefined}
          aria-describedby={describedBy('fullName')}
          required
        />
        {fieldErrors.fullName && (
          <p id="profile-fullName-error" className="field-error">
            {fieldErrors.fullName}
          </p>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor="profile-phone">
          Phone
        </label>
        <input
          ref={phoneRef}
          id="profile-phone"
          className="field-input office-number-input"
          type="tel"
          name="phone"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          disabled={saving}
          maxLength={40}
          aria-invalid={fieldErrors.phone ? true : undefined}
          aria-describedby={describedBy('phone', 'profile-phone-hint')}
          required
        />
        <p id="profile-phone-hint" className="office-settings-hint">
          Include the country code, for example +255 700 000 000.
        </p>
        {fieldErrors.phone && (
          <p id="profile-phone-error" className="field-error">
            {fieldErrors.phone}
          </p>
        )}
      </div>

      <div className="office-error" role="alert" hidden={!formError}>
        {formError}
      </div>

      <div className="office-reset-actions">
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <span className="spinner" aria-hidden="true" />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}

type AccessProps = {
  staff: StaffDetail
  isSelf: boolean
  onChanged: (staff: StaffDetail) => void
}

// Deactivate (after a confirmation) or reactivate. Deactivation signs the person
// out everywhere at once; the account is kept. The server refuses the admin's own
// account and the last active admin, and its message is shown here.
function AccessCard({ staff, isSelf, onChanged }: AccessProps) {
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Where focus goes after the next render: the confirmation, or back to the action.
  const focusTo = useRef<'confirm' | 'action' | null>(null)

  useEffect(() => {
    const target = focusTo.current
    if (!target) return
    focusTo.current = null
    ;(target === 'confirm' ? cancelRef : actionRef).current?.focus()
  })

  async function setActive(isActive: boolean) {
    if (working) return
    setWorking(true)
    setError(null)
    const result = await apiRequest<{ staff: StaffDetail }>(`/api/office/staff/${staff.id}`, {
      method: 'PATCH',
      body: { isActive },
    })
    setWorking(false)

    if (result.ok) {
      setConfirming(false)
      onChanged(result.data.staff)
      focusTo.current = 'action'
      return
    }
    // 401 and 503 are also handled by the auth provider (login / unavailable screen).
    if (result.status === 403) setError('Only administrators can change who has access.')
    else if (result.status === 404) setError('This person no longer exists.')
    else if (result.status === 503) setError('The service is temporarily unavailable. Please try again shortly.')
    else setError(result.message)
  }

  function cancel() {
    setConfirming(false)
    setError(null)
    focusTo.current = 'action'
  }

  const firstName = staff.fullName.split(' ')[0]

  return (
    <section className="office-card" aria-labelledby="profile-access-heading">
      <div className="office-profile-card-head">
        <h2 id="profile-access-heading">Access</h2>
        {!confirming &&
          !isSelf &&
          (staff.isActive ? (
            <button
              ref={actionRef}
              type="button"
              className="button button-danger-outline"
              onClick={() => {
                setError(null)
                setConfirming(true)
                focusTo.current = 'confirm'
              }}
            >
              Deactivate
            </button>
          ) : (
            <button
              ref={actionRef}
              type="button"
              className="button button-primary"
              onClick={() => setActive(true)}
              disabled={working}
            >
              {working && <span className="spinner" aria-hidden="true" />}
              {working ? 'Reactivating…' : 'Reactivate'}
            </button>
          ))}
      </div>

      <p className="office-card-sub">
        {isSelf
          ? 'This is your own account. Another admin can deactivate it if needed.'
          : staff.isActive
            ? `${firstName} can sign in. Deactivating signs them out on every device at once. Nothing is deleted.`
            : `This account is deactivated, so ${firstName} cannot sign in. Reactivate it to give access back.`}
      </p>

      {confirming && (
        <div className="office-confirm" role="group" aria-labelledby="profile-deactivate-question">
          <p id="profile-deactivate-question" className="office-confirm-question">
            Deactivate {staff.fullName}?
          </p>
          <p className="office-confirm-text">
            They are signed out right away and cannot sign in until an admin reactivates the account.
          </p>
          <div className="office-reset-actions">
            <button type="button" className="button button-danger" onClick={() => setActive(false)} disabled={working}>
              {working && <span className="spinner" aria-hidden="true" />}
              {working ? 'Deactivating…' : 'Deactivate account'}
            </button>
            <button ref={cancelRef} type="button" className="button button-secondary" onClick={cancel} disabled={working}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="office-error" role="alert" hidden={!error}>
        {error}
      </div>
    </section>
  )
}

// /office/staff/:id (admins): one person's profile. Name and phone can be
// corrected, and access deactivated or given back; email and role cannot change here.
export default function StaffProfile() {
  const { id = '' } = useParams()
  const { state, refresh } = useAuth()
  const selfId = state.status === 'authenticated' ? state.staff.id : null

  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const refocusEdit = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ staff: StaffDetail }>(`/api/office/staff/${encodeURIComponent(id)}`, { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setLoad({ status: 'ready', staff: result.data.staff })
        else if (result.status === 404) setLoad({ status: 'missing' })
        else if (result.status === 403) setLoad({ status: 'error', message: 'Only administrators can see staff profiles.' })
        else if (result.status === 503) {
          setLoad({ status: 'error', message: 'The service is temporarily unavailable. Please try again shortly.' })
        } else setLoad({ status: 'error', message: result.message })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [id, attempt])

  // Focus returns to Edit once the form has closed.
  useEffect(() => {
    if (!editing && refocusEdit.current) {
      refocusEdit.current = false
      editButtonRef.current?.focus()
    }
  }, [editing])

  function closeForm() {
    refocusEdit.current = true
    setEditing(false)
  }

  function saved(staff: StaffDetail) {
    setLoad({ status: 'ready', staff })
    setNotice('Changes saved.')
    closeForm()
    // The header and profile menu show the signed-in person's own name.
    if (staff.id === selfId) void refresh()
  }

  function statusChanged(staff: StaffDetail) {
    setLoad({ status: 'ready', staff })
    setNotice(
      staff.isActive
        ? `${staff.fullName} is active again and can sign in.`
        : `${staff.fullName} is deactivated and has been signed out.`,
    )
  }

  function retry() {
    setLoad({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  if (load.status === 'loading') {
    return (
      <div className="office-profile">
        <BackToStaff />
        <ul className="office-skeleton office-profile-skeleton" aria-busy="true" aria-label="Loading profile">
          {[0, 1, 2].map((n) => (
            <li key={n} className="office-skeleton-row" />
          ))}
        </ul>
      </div>
    )
  }

  if (load.status === 'missing') {
    return (
      <div className="office-profile">
        <BackToStaff />
        <h1 className="office-title">Staff member not found</h1>
        <p className="office-lead">This person does not exist, or the link is incomplete.</p>
        <div className="office-reset-actions">
          <Link className="button button-primary" to={STAFF_PATH}>
            Back to staff
          </Link>
        </div>
      </div>
    )
  }

  if (load.status === 'error') {
    return (
      <div className="office-profile">
        <BackToStaff />
        <h1 className="office-title">Staff profile</h1>
        <div className="office-error" role="alert">
          {load.message}
        </div>
        <div className="office-reset-actions">
          <button type="button" className="button button-secondary" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const { staff } = load
  const badge = status(staff)

  return (
    <div className="office-profile">
      <BackToStaff />
      <ProfileHead fullName={staff.fullName} email={staff.email}>
        <span className="office-status">{roleLabel(staff.role)}</span>
        <span className={`office-status office-status-${badge.tone}`}>{badge.label}</span>
        {staff.id === selfId && <span className="office-status">You</span>}
      </ProfileHead>

      <div className="office-reset-status office-profile-notice" role="status">
        {notice}
      </div>

      <section className="office-card" aria-labelledby="profile-contact-heading">
        <div className="office-profile-card-head">
          <h2 id="profile-contact-heading">Contact details</h2>
          {!editing && (
            <button
              ref={editButtonRef}
              type="button"
              className="button button-secondary"
              onClick={() => {
                setNotice(null)
                setEditing(true)
              }}
            >
              Edit
            </button>
          )}
        </div>
        {editing ? (
          <ContactForm staff={staff} onSaved={saved} onCancel={closeForm} />
        ) : (
          <Facts
            rows={[
              ['Full name', staff.fullName],
              ['Email', staff.email],
              ['Phone', staff.phone ? <span className="office-number">{staff.phone}</span> : notSet],
            ]}
          />
        )}
      </section>

      <section className="office-card" aria-labelledby="profile-account-heading">
        <h2 id="profile-account-heading">Account</h2>
        <Facts
          rows={[
            ['Role', roleLabel(staff.role)],
            ['Status', badge.label],
            ['Last sign-in', staff.lastLoginAt ? DATE_TIME.format(new Date(staff.lastLoginAt)) : 'Never'],
            ['Registered', DATE.format(new Date(staff.createdAt))],
          ]}
        />
        <p className="office-settings-hint office-profile-note">The email address is the sign-in name and cannot be changed.</p>
      </section>

      <AccessCard staff={staff} isSelf={staff.id === selfId} onChanged={statusChanged} />
    </div>
  )
}

// /office/profile: the signed-in person's own profile, read only. It shows what
// /api/auth/me reports; IT keeps the details up to date.
export function MyProfile() {
  const { state } = useAuth()
  if (state.status !== 'authenticated') return null
  const { staff } = state

  return (
    <div className="office-profile">
      <ProfileHead fullName={staff.fullName} email={staff.email}>
        <span className="office-status">{roleLabel(staff.role)}</span>
      </ProfileHead>

      <section className="office-card" aria-labelledby="my-profile-details-heading">
        <h2 id="my-profile-details-heading">Your details</h2>
        <Facts
          rows={[
            ['Full name', staff.fullName],
            ['Email', staff.email],
            ['Role', roleLabel(staff.role)],
          ]}
        />
        <p className="office-settings-hint office-profile-note">
          {staff.role === 'admin' ? (
            <>
              You can correct your name and phone in{' '}
              <Link to={`${STAFF_PATH}/${staff.id}`}>your staff profile</Link>.
            </>
          ) : (
            'If your name or phone number is wrong, ask IT to correct it.'
          )}
        </p>
      </section>

      <section className="office-card" aria-labelledby="my-profile-security-heading">
        <h2 id="my-profile-security-heading">Security</h2>
        <p className="office-card-sub">Choose a new password at any time. Your other devices are signed out.</p>
        <div className="office-reset-actions">
          <Link className="button button-secondary" to={CHANGE_PASSWORD_PATH}>
            Change password
          </Link>
        </div>
      </section>
    </div>
  )
}

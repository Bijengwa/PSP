import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { apiRequest } from '../../../api/client'
import { passwordRules } from '../../auth/login'
import '../../auth/auth.css'

type Role = 'IT' | 'staff'
type FieldName = 'fullName' | 'email' | 'phone' | 'role' | 'temporaryPassword'
type FieldErrors = Partial<Record<FieldName, string>>
type TextFieldName = Exclude<FieldName, 'role' | 'temporaryPassword'>

type RegisteredStaff = { id: string; fullName: string; email: string; phone: string; role: Role }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLE_LABELS: Record<Role, string> = { IT: 'IT', staff: 'Staff' }
const FIELD_NAMES: FieldName[] = ['fullName', 'email', 'phone', 'role', 'temporaryPassword']

// The form only catches what is cheap to see; the server stays the authority.
function validate(values: { fullName: string; email: string; phone: string; temporaryPassword: string }) {
  const errors: FieldErrors = {}
  if (!values.fullName.trim()) errors.fullName = 'Enter the full name.'
  if (!values.email.trim()) errors.email = 'Enter an email address.'
  else if (!EMAIL_PATTERN.test(values.email.trim())) errors.email = 'Enter a valid email address.'
  if (!values.phone.trim()) errors.phone = 'Enter a phone number.'
  if (!values.temporaryPassword) errors.temporaryPassword = 'Enter a temporary password.'
  return errors
}

// /office/staff/new (admins): IT registers a person with a temporary password.
// They are forced to choose their own at first sign-in (must_change_password).
export default function RegisterStaff() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [passwordReasons, setPasswordReasons] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<RegisteredStaff | null>(null)

  const rules = passwordRules(temporaryPassword, null, { email, fullName })

  function reset() {
    setFullName('')
    setEmail('')
    setPhone('')
    setRole('staff')
    setTemporaryPassword('')
    setFieldErrors({})
    setFormError(null)
    setPasswordReasons([])
    setCreated(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const errors = validate({ fullName, email, phone, temporaryPassword })
    setFieldErrors(errors)
    setPasswordReasons([])
    setFormError(null)
    if (Object.keys(errors).length > 0) return
    if (rules.some((rule) => !rule.met)) {
      setFieldErrors({ temporaryPassword: 'The temporary password does not meet every rule yet.' })
      return
    }

    setSubmitting(true)
    const result = await apiRequest<{ staff: RegisteredStaff }>('/api/office/staff', {
      method: 'POST',
      body: { fullName, email, phone, role, temporaryPassword },
    })
    setSubmitting(false)

    if (result.ok) {
      setTemporaryPassword('')
      setCreated(result.data.staff)
      return
    }

    // 401 and 503 are also handled by the auth provider (login / unavailable screen).
    if (result.status === 403) {
      setFormError('Only IT can register staff.')
    } else if (result.status === 503) {
      setFormError('The service is temporarily unavailable. Please try again shortly.')
    } else {
      setFormError(result.message)
    }

    if (Array.isArray(result.details)) {
      setPasswordReasons(result.details.filter((d): d is string => typeof d === 'string'))
      if (result.code === 'WEAK_PASSWORD') setFieldErrors({ temporaryPassword: 'This password is not strong enough.' })
    } else if (result.details && typeof result.details === 'object') {
      const next: FieldErrors = {}
      for (const name of FIELD_NAMES) {
        const message = (result.details as Record<string, unknown>)[name]
        if (typeof message === 'string') next[name] = message
      }
      setFieldErrors(next)
    }
  }

  if (created) {
    return (
      <>
        <h1 className="office-title">Register Staff</h1>
        <section className="office-register-done" role="status">
          <h2>{created.fullName} is registered</h2>
          <p>
            {created.email} can sign in as {ROLE_LABELS[created.role]} with the temporary password you set. They will be
            asked to choose their own password the first time they sign in. Give them the temporary password in person.
          </p>
          <div className="office-reset-actions">
            <button type="button" className="button button-primary" onClick={reset}>
              Register another person
            </button>
            <Link className="button button-secondary" to="/office/staff">
              Go to staff
            </Link>
          </div>
        </section>
      </>
    )
  }

  const describedBy = (name: FieldName, ...extra: string[]) =>
    [...extra, ...(fieldErrors[name] ? [`register-${name}-error`] : [])].join(' ') || undefined

  function textField(
    name: TextFieldName,
    label: string,
    value: string,
    onChange: (value: string) => void,
    props: { type?: string; autoComplete?: string; inputMode?: 'tel' | 'email' } = {},
  ) {
    return (
      <div className="field">
        <label className="field-label" htmlFor={`register-${name}`}>
          {label}
        </label>
        <input
          id={`register-${name}`}
          className="field-input"
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={submitting}
          aria-invalid={fieldErrors[name] ? true : undefined}
          aria-describedby={describedBy(name)}
          required
          {...props}
        />
        {fieldErrors[name] && (
          <p id={`register-${name}-error`} className="field-error">
            {fieldErrors[name]}
          </p>
        )}
      </div>
    )
  }

  return (
    <>
      <h1 className="office-title">Register Staff</h1>
      <p className="office-lead">
        Add a person to the office with a temporary password. They must choose their own password the first time they
        sign in.
      </p>

      <form className="office-register-form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
        {textField('fullName', 'Full name', fullName, setFullName, { autoComplete: 'off' })}
        {textField('email', 'Email', email, setEmail, { type: 'email', autoComplete: 'off', inputMode: 'email' })}
        {textField('phone', 'Phone', phone, setPhone, { type: 'tel', autoComplete: 'off', inputMode: 'tel' })}

        <div className="field">
          <label className="field-label" htmlFor="register-role">
            Role
          </label>
          <select
            id="register-role"
            className="field-input"
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={submitting}
            aria-invalid={fieldErrors.role ? true : undefined}
            aria-describedby={describedBy('role', 'register-role-hint')}
          >
            <option value="staff">Staff</option>
            <option value="IT">IT</option>
          </select>
          <p id="register-role-hint" className="office-settings-hint">
            Admins can register staff and see everything. Staff are normal employees.
          </p>
          {fieldErrors.role && (
            <p id="register-role-error" className="field-error">
              {fieldErrors.role}
            </p>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="register-temporaryPassword">
            Temporary password
          </label>
          <input
            id="register-temporaryPassword"
            className="field-input"
            type="password"
            name="temporaryPassword"
            autoComplete="new-password"
            value={temporaryPassword}
            onChange={(event) => setTemporaryPassword(event.target.value)}
            disabled={submitting}
            aria-invalid={fieldErrors.temporaryPassword ? true : undefined}
            aria-describedby={describedBy('temporaryPassword', 'register-password-rules')}
            required
          />
          {fieldErrors.temporaryPassword && (
            <p id="register-temporaryPassword-error" className="field-error">
              {fieldErrors.temporaryPassword}
            </p>
          )}
        </div>
        <ul id="register-password-rules" className="password-rules" aria-label="Password rules">
          {rules.map((rule) => (
            <li key={rule.label} className={rule.met ? 'password-rule is-met' : 'password-rule'}>
              <span className="password-rule-mark" aria-hidden="true" />
              {rule.label}
              <span className="visually-hidden">{rule.met ? ', met' : ', not met'}</span>
            </li>
          ))}
        </ul>

        <div className="office-error" role="alert" hidden={!formError}>
          {formError}
          {passwordReasons.length > 0 && (
            <ul>
              {passwordReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="office-reset-actions">
          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting && <span className="spinner" aria-hidden="true" />}
            {submitting ? 'Registering…' : 'Register staff'}
          </button>
        </div>
      </form>
    </>
  )
}

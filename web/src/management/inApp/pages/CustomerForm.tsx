import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'
import { displayName, phoneText, type Customer } from './CustomersList'

type CustomerType = Customer['type']

export type CustomerAddress = { id: string; label: string; area: string; address: string; isDefault: boolean }
export type CustomerRecord = Customer & { notes: string; addresses: CustomerAddress[] }

type Values = {
  type: CustomerType
  fullName: string
  companyName: string
  contactPerson: string
  tin: string
  phone: string
  email: string
  notes: string
}

// One address row in the editor. `key` only keeps React rows stable.
type AddressRow = { key: string; label: string; area: string; address: string; isDefault: boolean }

// Field names, including "addresses.<row>.area" style keys for address rows.
type FieldErrors = Record<string, string>

type Duplicate = Customer & { matchedOn: ('phone' | 'email')[] }

export const CUSTOMERS_PATH = '/office/customers'

const MAX_NOTES = 2000
const MAX_ADDRESSES = 10
const DUPLICATE_DEBOUNCE_MS = 400

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TZ_PHONE_PATTERN = /^(?:\+?255|0)?([267]\d{8})$/
const INTL_PHONE_PATTERN = /^(?:\+|00)([1-9]\d{7,14})$/
const TIN_PATTERN = /^\d[\d-]*$/

// Same rule as the server: "0712 345 678" -> "+255712345678", "+254 711 000 111" ->
// "+254711000111", anything else null.
function normalizePhone(raw: string) {
  const compact = raw.replace(/[\s().-]/g, '')
  const tz = compact.match(TZ_PHONE_PATTERN)
  if (tz) return `+255${tz[1]}`
  const intl = compact.match(INTL_PHONE_PATTERN)
  return intl ? `+${intl[1]}` : null
}

function validEmail(raw: string) {
  const email = raw.trim().toLowerCase()
  return email && email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null
}

const EMPTY: Values = {
  type: 'individual',
  fullName: '',
  companyName: '',
  contactPerson: '',
  tin: '',
  phone: '',
  email: '',
  notes: '',
}

function valuesOf(customer: CustomerRecord): Values {
  return {
    type: customer.type,
    fullName: customer.fullName ?? '',
    companyName: customer.companyName ?? '',
    contactPerson: customer.contactPerson ?? '',
    tin: customer.tin ?? '',
    phone: customer.phone ? phoneText(customer.phone) : '',
    email: customer.email ?? '',
    notes: customer.notes,
  }
}

let rowCounter = 0
const nextKey = () => `address-${(rowCounter += 1)}`

const blankRow = (isDefault: boolean): AddressRow => ({ key: nextKey(), label: '', area: '', address: '', isDefault })
const isBlankRow = (row: AddressRow) => !row.label.trim() && !row.area.trim() && !row.address.trim()

const length = (text: string) => text.trim().replace(/\s+/g, ' ').length

// The form only catches what is cheap to see; the server stays the authority.
function validate(values: Values, rows: AddressRow[]) {
  const errors: FieldErrors = {}
  if (values.type === 'individual') {
    if (length(values.fullName) < 2 || length(values.fullName) > 100) {
      errors.fullName = 'Enter the full name (2 to 100 characters).'
    }
  } else {
    if (length(values.companyName) < 2 || length(values.companyName) > 150) {
      errors.companyName = 'Enter the company name (2 to 150 characters).'
    }
    const tin = values.tin.replace(/\s/g, '')
    if (tin && (tin.length > 20 || !TIN_PATTERN.test(tin))) {
      errors.tin = 'Use digits and dashes only, for example 123-456-789.'
    }
  }
  if (values.phone.trim() && !normalizePhone(values.phone)) {
    errors.phone = 'Enter a phone number, for example 0712 345 678 or +254 711 000 111.'
  }
  if (values.email.trim() && !validEmail(values.email)) errors.email = 'Enter a valid email address.'
  if (values.notes.trim().length > MAX_NOTES) errors.notes = `Use at most ${MAX_NOTES} characters.`
  rows.forEach((row, index) => {
    if (isBlankRow(row)) return
    if (length(row.area) < 2 || length(row.area) > 100) {
      errors[`addresses.${index}.area`] = 'Enter the area or city (2 to 100 characters).'
    }
    if (length(row.address) < 2 || length(row.address) > 200) {
      errors[`addresses.${index}.address`] = 'Enter a street or landmark (2 to 200 characters).'
    }
  })
  return errors
}

function errorMessage(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

function fieldErrorsFrom(details: unknown): FieldErrors {
  const next: FieldErrors = {}
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    for (const [name, message] of Object.entries(details)) {
      if (typeof message === 'string') next[name] = message
    }
  }
  return next
}

// ---------- icons (line icons, currentColor) ----------

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const CheckIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
)
const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" />
  </Icon>
)
const AlertIcon = () => (
  <Icon>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
)
const PersonIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />
  </Icon>
)
const BuildingIcon = () => (
  <Icon>
    <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
    <path d="M15 9h4a1 1 0 0 1 1 1v11" />
    <path d="M8 8h3M8 12h3M8 16h3M3 21h18" />
  </Icon>
)

const TYPE_OPTIONS: { type: CustomerType; label: string; text: string; icon: React.ReactNode }[] = [
  { type: 'individual', label: 'Individual', text: 'A person buying for themselves', icon: <PersonIcon /> },
  { type: 'company', label: 'Company', text: 'A hospital, clinic or business', icon: <BuildingIcon /> },
]

function matchText(match: Duplicate) {
  const on = match.matchedOn
  if (on.includes('phone') && on.includes('email')) return 'same phone and email'
  return on.includes('phone') ? 'same phone' : 'same email'
}

// Other customers with the typed phone or email. Asked after a short pause, and only
// for a phone or email that would be accepted. A duplicate is a warning, never a block.
function useDuplicates(phone: string, email: string, excludeId?: string) {
  const [matches, setMatches] = useState<Duplicate[]>([])
  const normalPhone = phone.trim() ? normalizePhone(phone) : null
  const normalEmail = email.trim() ? validEmail(email) : null

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (!normalPhone && !normalEmail) {
        setMatches([])
        return
      }
      const params = new URLSearchParams()
      if (normalPhone) params.set('phone', normalPhone)
      if (normalEmail) params.set('email', normalEmail)
      if (excludeId) params.set('exclude', excludeId)
      apiRequest<{ matches: Duplicate[] }>(`/api/office/customers/duplicates?${params}`, {
        signal: controller.signal,
      }).then(
        // A failed check shows no warning; saving still works and the server decides.
        (result) => setMatches(result.ok ? result.data.matches : []),
        () => {}, // aborted
      )
    }, DUPLICATE_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [normalPhone, normalEmail, excludeId])

  return matches
}

// ---------- the editor (Add and Edit share it) ----------

type EditorProps = { customer?: CustomerRecord; notice?: string | null }

function CustomerEditor({ customer, notice: initialNotice = null }: EditorProps) {
  const navigate = useNavigate()
  const editing = Boolean(customer)
  const formRef = useRef<HTMLFormElement>(null)

  const [values, setValues] = useState<Values>(() => (customer ? valuesOf(customer) : EMPTY))
  const [rows, setRows] = useState<AddressRow[]>(() =>
    (customer?.addresses ?? []).map((a) => ({
      key: a.id,
      label: a.label,
      area: a.area,
      address: a.address,
      isDefault: a.isDefault,
    })),
  )
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(initialNotice)
  const [busy, setBusy] = useState(false)

  const duplicates = useDuplicates(values.phone, values.email, customer?.id)
  const company = values.type === 'company'

  // "Changes saved." goes away on its own.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const set = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }))

  // ----- addresses -----

  const setRow = (index: number, patch: Partial<AddressRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const makeDefault = (index: number) =>
    setRows((current) => current.map((row, i) => ({ ...row, isDefault: i === index })))

  function addRow() {
    setRows((current) => [...current, blankRow(current.length === 0)])
  }

  // Removing the default makes the first remaining address the default. Errors are
  // keyed by row number, so they are cleared rather than shifted onto the wrong row.
  function removeRow(index: number) {
    setRows((current) => {
      const next = current.filter((_, i) => i !== index)
      if (next.length > 0 && !next.some((row) => row.isDefault)) next[0] = { ...next[0], isDefault: true }
      return next
    })
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([name]) => !name.startsWith('addresses.'))))
  }

  // ----- saving -----

  function focusFirstError() {
    window.requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const found = validate(values, rows)
    setErrors(found)
    setFormError(null)
    setNotice(null)
    if (Object.keys(found).length > 0) {
      setFormError('Check the highlighted fields.')
      focusFirstError()
      return
    }

    const body = {
      type: values.type,
      fullName: values.fullName,
      companyName: values.companyName,
      contactPerson: values.contactPerson,
      tin: values.tin,
      phone: values.phone,
      email: values.email,
      notes: values.notes,
      addresses: rows.map(({ label, area, address, isDefault }) => ({ label, area, address, isDefault })),
    }

    setBusy(true)
    const saved = editing
      ? await apiRequest<{ customer: CustomerRecord }>(`/api/office/customers/${customer?.id}`, { method: 'PATCH', body })
      : await apiRequest<{ customer: CustomerRecord }>('/api/office/customers', { method: 'POST', body })
    setBusy(false)

    if (!saved.ok) {
      // Everything typed stays in the form.
      setFormError(errorMessage(saved))
      setErrors(fieldErrorsFrom(saved.details))
      focusFirstError()
      return
    }

    const name = displayName(saved.data.customer)
    if (editing) {
      // The edit page loads the customer again, so the form shows what is stored.
      navigate(`${CUSTOMERS_PATH}/${saved.data.customer.id}/edit`, { replace: true, state: { notice: 'Changes saved.' } })
    } else {
      navigate(CUSTOMERS_PATH, { state: { notice: `${name} was added.` } })
    }
  }

  // ----- render helpers -----

  const err = (name: string) =>
    errors[name] ? (
      <p id={`customer-${name.replace(/\./g, '-')}-error`} className="field-error">
        {errors[name]}
      </p>
    ) : null
  const describedBy = (name: string, ...extra: string[]) =>
    [...extra, ...(errors[name] ? [`customer-${name.replace(/\./g, '-')}-error`] : [])].join(' ') || undefined
  const invalid = (name: string) => (errors[name] ? true : undefined)

  function textField(
    name: 'fullName' | 'companyName' | 'contactPerson' | 'tin' | 'phone' | 'email',
    label: string,
    props: {
      placeholder?: string
      maxLength?: number
      type?: string
      inputMode?: 'tel' | 'email' | 'numeric'
      hint?: string
      optional?: boolean
    } = {},
  ) {
    const { hint, optional, ...inputProps } = props
    const hintId = hint ? `customer-${name}-hint` : undefined
    return (
      <div className="field">
        <label className="field-label" htmlFor={`customer-${name}`}>
          {label}
          {optional && <span className="office-optional"> (optional)</span>}
        </label>
        <input
          id={`customer-${name}`}
          className="field-input"
          name={name}
          autoComplete="off"
          value={values[name]}
          onChange={(event) => set({ [name]: event.target.value } as Partial<Values>)}
          disabled={busy}
          aria-invalid={invalid(name)}
          aria-describedby={describedBy(name, ...(hintId ? [hintId] : []))}
          {...inputProps}
        />
        {hint && (
          <p id={hintId} className="office-settings-hint">
            {hint}
          </p>
        )}
        {err(name)}
      </div>
    )
  }

  const title = editing && customer ? displayName(customer) : 'Add customer'

  return (
    <form ref={formRef} className="office-product-page" onSubmit={handleSubmit} noValidate aria-busy={busy}>
      <div className="office-product-head">
        <div className="office-product-heading">
          <h1 className="office-title">{title}</h1>
          <p className="office-lead">
            {editing && customer ? (
              <>
                <span className={`office-status office-status-${customer.type}`}>
                  {customer.type === 'company' ? 'Company' : 'Individual'}
                </span>{' '}
                · Added {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(customer.createdAt))}
              </>
            ) : (
              'A person or company PSP sells to'
            )}
          </p>
        </div>
        <div className="office-product-actions">
          <Link className="button button-secondary" to={CUSTOMERS_PATH}>
            Cancel
          </Link>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <CheckIcon />}
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Save customer'}
          </button>
        </div>
      </div>

      <div className="office-status-line" role="status">
        {notice}
      </div>
      <div className="office-error" role="alert" hidden={!formError}>
        {formError}
      </div>

      <div className="office-product-grid">
        <div className="office-product-main">
          {/* 1. Who the customer is */}
          <section className="office-card" aria-labelledby="card-customer">
            <h2 id="card-customer">Customer</h2>
            <p className="office-card-sub">Company details appear when the customer is a company</p>

            <fieldset className="office-role-options office-customer-types" disabled={busy}>
              <legend className="field-label">Type</legend>
              {TYPE_OPTIONS.map((option) => (
                <label key={option.type} className="office-role-option">
                  <input
                    type="radio"
                    name="type"
                    value={option.type}
                    checked={values.type === option.type}
                    onChange={() => set({ type: option.type })}
                    aria-describedby={`customer-type-${option.type}-text`}
                  />
                  <span className="office-role-option-name">
                    <span className="office-customer-type-icon">{option.icon}</span>
                    {option.label}
                  </span>
                  <span id={`customer-type-${option.type}-text`} className="office-role-option-text">
                    {option.text}
                  </span>
                </label>
              ))}
            </fieldset>

            {company ? (
              <>
                {textField('companyName', 'Company name', {
                  placeholder: 'e.g. Bugando Medical Centre',
                  maxLength: 150,
                })}
                <div className="office-product-row">
                  {textField('contactPerson', 'Contact person', {
                    placeholder: 'e.g. Dr. Neema Kweka',
                    maxLength: 100,
                    optional: true,
                  })}
                  {textField('tin', 'TIN', {
                    placeholder: 'e.g. 123-456-789',
                    maxLength: 20,
                    inputMode: 'numeric',
                    optional: true,
                  })}
                </div>
              </>
            ) : (
              textField('fullName', 'Full name', { placeholder: 'e.g. Asha Mushi', maxLength: 100 })
            )}
          </section>

          {/* 2. Phone and email, with the duplicate warning */}
          <section className="office-card" aria-labelledby="card-contact">
            <h2 id="card-contact">Contact</h2>
            <p className="office-card-sub">Used to match shop orders to this customer</p>

            <div className="office-product-row">
              {textField('phone', 'Phone', {
                type: 'tel',
                inputMode: 'tel',
                placeholder: 'e.g. 0712 345 678',
                maxLength: 30,
                optional: true,
                hint: 'Tanzanian numbers are saved as +255. Use + for other countries.',
              })}
              {textField('email', 'Email', {
                type: 'email',
                inputMode: 'email',
                placeholder: 'e.g. name@example.com',
                maxLength: 254,
                optional: true,
              })}
            </div>

            <div aria-live="polite">
              {duplicates.length > 0 && (
                <div className="office-duplicate">
                  <p className="office-duplicate-title">
                    <AlertIcon />
                    {duplicates.length === 1 ? 'A customer with these details exists' : 'Customers with these details exist'}
                  </p>
                  <ul className="office-duplicate-list">
                    {duplicates.map((match) => (
                      <li key={match.id}>
                        <Link
                          className="office-staff-link office-duplicate-link"
                          to={`${CUSTOMERS_PATH}/${match.id}/edit`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {displayName(match)}
                          <span className="visually-hidden"> (opens in a new tab)</span>
                        </Link>
                        <span className="office-staff-meta">{matchText(match)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="office-duplicate-note">
                    Check it is not the same {duplicates.length === 1 ? 'customer' : 'customers'} before saving. You can
                    still save.
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* 3. Addresses */}
          <section className="office-card" aria-labelledby="card-addresses">
            <h2 id="card-addresses">Addresses</h2>
            <p className="office-card-sub">Where to deliver. The default address is used first.</p>

            {rows.length === 0 ? (
              <p className="office-address-empty">No addresses yet.</p>
            ) : (
              <ul className="office-address-list">
                {rows.map((row, index) => {
                  const base = `addresses.${index}`
                  const id = (field: string) => `customer-address-${index}-${field}`
                  return (
                    <li key={row.key} className="office-address">
                      <div className="office-address-head">
                        <h3>Address {index + 1}</h3>
                        <button
                          type="button"
                          className="office-photo-button office-spec-remove"
                          aria-label={`Remove address ${index + 1}`}
                          disabled={busy}
                          onClick={() => removeRow(index)}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                      <div className="office-product-row">
                        <div className="field">
                          <label className="field-label" htmlFor={id('label')}>
                            Label<span className="office-optional"> (optional)</span>
                          </label>
                          <input
                            id={id('label')}
                            className="field-input"
                            placeholder="e.g. Head office"
                            value={row.label}
                            onChange={(event) => setRow(index, { label: event.target.value })}
                            disabled={busy}
                            maxLength={50}
                            aria-invalid={invalid(`${base}.label`)}
                            aria-describedby={describedBy(`${base}.label`)}
                          />
                          {err(`${base}.label`)}
                        </div>
                        <div className="field">
                          <label className="field-label" htmlFor={id('area')}>
                            Area or city
                          </label>
                          <input
                            id={id('area')}
                            className="field-input"
                            placeholder="e.g. Mikocheni, Dar es Salaam"
                            value={row.area}
                            onChange={(event) => setRow(index, { area: event.target.value })}
                            disabled={busy}
                            maxLength={100}
                            aria-invalid={invalid(`${base}.area`)}
                            aria-describedby={describedBy(`${base}.area`)}
                          />
                          {err(`${base}.area`)}
                        </div>
                      </div>
                      <div className="field">
                        <label className="field-label" htmlFor={id('address')}>
                          Street, plot or landmark
                        </label>
                        <input
                          id={id('address')}
                          className="field-input"
                          placeholder="e.g. Plot 12, Old Bagamoyo Road"
                          value={row.address}
                          onChange={(event) => setRow(index, { address: event.target.value })}
                          disabled={busy}
                          maxLength={200}
                          aria-invalid={invalid(`${base}.address`)}
                          aria-describedby={describedBy(`${base}.address`)}
                        />
                        {err(`${base}.address`)}
                      </div>
                      <label className="office-check">
                        <input
                          type="radio"
                          name="default-address"
                          checked={row.isDefault}
                          onChange={() => makeDefault(index)}
                          disabled={busy}
                        />
                        <span>Default address</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
            {err('addresses')}
            <div>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || rows.length >= MAX_ADDRESSES}
                onClick={addRow}
              >
                <PlusIcon />
                Add address
              </button>
            </div>
          </section>
        </div>

        <div className="office-product-side">
          {/* 4. Notes */}
          <section className="office-card" aria-labelledby="card-notes">
            <h2 id="card-notes">Notes</h2>
            <p className="office-card-sub">Only staff see these</p>
            <div className="field">
              <label className="visually-hidden" htmlFor="customer-notes">
                Customer notes
              </label>
              <textarea
                id="customer-notes"
                className="field-input office-product-textarea office-customer-notes"
                rows={6}
                placeholder="e.g. Pays by bank transfer. Call before delivery."
                value={values.notes}
                onChange={(event) => set({ notes: event.target.value })}
                disabled={busy}
                aria-invalid={invalid('notes')}
                aria-describedby={describedBy('notes', 'customer-notes-count')}
              />
              <p
                id="customer-notes-count"
                className={`office-settings-hint office-number${values.notes.length > MAX_NOTES ? ' is-over' : ''}`}
              >
                {values.notes.length.toLocaleString('en-US')} / {MAX_NOTES.toLocaleString('en-US')}
              </p>
              {err('notes')}
            </div>
          </section>
        </div>
      </div>
    </form>
  )
}

// /office/customers/new
export default function AddCustomer() {
  return <CustomerEditor />
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; customer: CustomerRecord }

// /office/customers/:id/edit. Every visit (including after a save, which navigates here
// with a notice) loads the customer again, so the form always shows what is stored.
export function EditCustomer() {
  const { id } = useParams()
  const location = useLocation()
  const notice = (location.state as { notice?: string } | null)?.notice ?? null
  // A new key on every visit remounts the loader, so it fetches again from "loading".
  return <EditLoader key={`${id}-${location.key}`} id={id ?? ''} notice={notice} />
}

function EditLoader({ id, notice }: { id: string; notice: string | null }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ customer: CustomerRecord }>(`/api/office/customers/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    }).then(
      (result) => {
        if (result.ok) setLoad({ status: 'ready', customer: result.data.customer })
        else {
          setLoad({
            status: 'error',
            message: result.status === 404 ? 'This customer does not exist.' : errorMessage(result),
          })
        }
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [id, attempt])

  if (load.status === 'loading') {
    return (
      <ul className="office-skeleton" aria-busy="true" aria-label="Loading customer">
        {[0, 1, 2].map((n) => (
          <li key={n} className="office-skeleton-row" />
        ))}
      </ul>
    )
  }
  if (load.status === 'error') {
    return (
      <>
        <h1 className="office-title">Customer</h1>
        <div className="office-error" role="alert">
          {load.message}
        </div>
        <div className="office-reset-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setLoad({ status: 'loading' })
              setAttempt((value) => value + 1)
            }}
          >
            Try again
          </button>
          <Link className="button button-secondary" to={CUSTOMERS_PATH}>
            Back to customers
          </Link>
        </div>
      </>
    )
  }

  return <CustomerEditor customer={load.customer} notice={notice} />
}

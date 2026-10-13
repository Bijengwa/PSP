import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Link } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import { useAuth } from '../../auth/AuthProvider'
import '../../auth/auth.css'
import { TemporaryPasswordForm } from './OfficeHome'

type StaffMember = {
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

type StaffPage = { staff: StaffMember[]; total: number; page: number; pageSize: number }
type StatusFilter = '' | 'active' | 'inactive'

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: StaffPage }

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const ROLE_LABELS: Record<string, string> = { admin: 'Admin', staff: 'Staff' }

// Phones get a card list instead of a table. Only one layout is rendered, so the
// reset form's input id exists once. Keep the width in step with index.css.
const COMPACT_QUERY = '(max-width: 640px)'

function subscribeToCompact(onChange: () => void) {
  const query = window.matchMedia(COMPACT_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function listErrorMessage(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 403) return 'Only administrators can see the staff list.'
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

function statusLabel(member: StaffMember) {
  if (!member.isActive) return 'Inactive'
  return member.mustChangePassword ? 'Password change pending' : 'Active'
}

// /office/staff (admins): everyone who can sign in, with search, a status filter
// and a Reset password action. Activate/deactivate and role change come later.
export default function StaffList() {
  const { state } = useAuth()
  const compact = useSyncExternalStore(subscribeToCompact, () => window.matchMedia(COMPACT_QUERY).matches)
  const selfId = state.status === 'authenticated' ? state.staff.id : null

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [page, setPage] = useState(1)
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [resetting, setResetting] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ page: String(page) })
    if (query) params.set('q', query)
    if (status) params.set('status', status)

    apiRequest<StaffPage>(`/api/office/staff?${params}`, { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setList({ status: 'ready', data: result.data })
        else setList({ status: 'error', message: listErrorMessage(result) })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [query, status, page])

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setList({ status: 'loading' })
    setPage(1)
    setQuery(search.trim())
  }

  function changeStatus(next: StatusFilter) {
    setList({ status: 'loading' })
    setPage(1)
    setStatus(next)
  }

  function goToPage(next: number) {
    setList({ status: 'loading' })
    setPage(next)
  }

  function resetDone(member: StaffMember) {
    setResetting(null)
    setNotice(
      `Temporary password set for ${member.fullName}. Give it to them in person; they must choose their own at next login.`,
    )
    // They must change their password now; refresh so the status shows it.
    setList((current) =>
      current.status === 'ready'
        ? {
            status: 'ready',
            data: {
              ...current.data,
              staff: current.data.staff.map((s) => (s.id === member.id ? { ...s, mustChangePassword: true } : s)),
            },
          }
        : current,
    )
  }

  function actions(member: StaffMember) {
    if (member.id === selfId) {
      return <span className="office-settings-hint">Change your own password in Settings.</span>
    }
    if (!member.isActive) return <span className="office-settings-hint">Inactive</span>
    return (
      <button
        type="button"
        className="button button-secondary"
        aria-expanded={resetting === member.id}
        onClick={() => {
          setNotice(null)
          setResetting(resetting === member.id ? null : member.id)
        }}
      >
        Reset password
      </button>
    )
  }

  function resetForm(member: StaffMember) {
    if (resetting !== member.id) return null
    return <TemporaryPasswordForm staff={member} onDone={() => resetDone(member)} onCancel={() => setResetting(null)} />
  }

  const totalPages = list.status === 'ready' ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1

  return (
    <>
      <h1 className="office-title">Staff</h1>
      <p className="office-lead">Everyone who can sign in to the office.</p>

      <div className="office-staff-toolbar">
        <form className="office-staff-search" role="search" onSubmit={handleSearch}>
          <label className="visually-hidden" htmlFor="staff-search">
            Search by name or email
          </label>
          <input
            id="staff-search"
            className="field-input"
            type="search"
            placeholder="Search by name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={100}
          />
          <button type="submit" className="button button-secondary">
            Search
          </button>
        </form>
        <div className="office-staff-filter">
          <label className="visually-hidden" htmlFor="staff-status">
            Status
          </label>
          <select
            id="staff-status"
            className="field-input"
            value={status}
            onChange={(event) => changeStatus(event.target.value as StatusFilter)}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <Link className="button button-primary" to="/office/staff/new">
            Register staff
          </Link>
        </div>
      </div>

      <div className="office-reset-status" role="status">
        {notice}
      </div>

      {list.status === 'loading' && <p className="office-reset-empty">Loading staff…</p>}
      {list.status === 'error' && (
        <div className="office-error" role="alert">
          {list.message}
        </div>
      )}

      {list.status === 'ready' && list.data.staff.length === 0 && <p className="office-reset-empty">No staff match.</p>}

      {list.status === 'ready' && list.data.staff.length > 0 && (
        <>
          {!compact && (
            <div className="office-staff-table-wrap">
              <table className="office-staff-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last login</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.staff.map((member) => (
                    <tr key={member.id}>
                      <td>
                        <span className="office-staff-name">{member.fullName}</span>
                        <span className="office-staff-meta">{member.email}</span>
                        {member.phone && <span className="office-staff-meta">{member.phone}</span>}
                        {resetForm(member)}
                      </td>
                      <td>{ROLE_LABELS[member.role] ?? member.role}</td>
                      <td>{statusLabel(member)}</td>
                      <td>{member.lastLoginAt ? DATE_TIME.format(new Date(member.lastLoginAt)) : 'Never'}</td>
                      <td>{actions(member)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {compact && (
            <ul className="office-staff-cards">
              {list.data.staff.map((member) => (
                <li key={member.id} className="office-staff-card">
                  <span className="office-staff-name">{member.fullName}</span>
                  <span className="office-staff-meta">{member.email}</span>
                  {member.phone && <span className="office-staff-meta">{member.phone}</span>}
                  <dl className="office-staff-facts">
                    <div>
                      <dt>Role</dt>
                      <dd>{ROLE_LABELS[member.role] ?? member.role}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{statusLabel(member)}</dd>
                    </div>
                    <div>
                      <dt>Last login</dt>
                      <dd>{member.lastLoginAt ? DATE_TIME.format(new Date(member.lastLoginAt)) : 'Never'}</dd>
                    </div>
                  </dl>
                  <div className="office-reset-actions">{actions(member)}</div>
                  {resetForm(member)}
                </li>
              ))}
            </ul>
          )}

          <nav className="office-staff-paging" aria-label="Staff pages">
            <span>
              {list.data.total} {list.data.total === 1 ? 'person' : 'people'}
            </span>
            {totalPages > 1 && (
              <span className="office-reset-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </button>
              </span>
            )}
          </nav>
        </>
      )}
    </>
  )
}

import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { apiRequest, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'
import { usePermission } from '../../auth/AuthProvider'
import { initials } from '../layout/ProfileMenu'

type CustomerType = 'individual' | 'company'

export type Customer = {
  id: string
  type: CustomerType
  fullName: string | null
  companyName: string | null
  tin: string | null
  contactPerson: string | null
  phone: string | null
  email: string | null
  createdAt: string
  updatedAt: string
}

type Counts = { all: number; individual: number; company: number }
type CustomersPage = { customers: Customer[]; total: number; page: number; pageSize: number; counts: Counts }
type TypeTab = '' | CustomerType

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: CustomersPage }

const SEARCH_DEBOUNCE_MS = 300
const NOTICE_MS = 5000
const CUSTOMERS_PATH = '/office/customers'

const TABS: { key: TypeTab; label: string; count: keyof Counts }[] = [
  { key: '', label: 'All customers', count: 'all' },
  { key: 'individual', label: 'Individuals', count: 'individual' },
  { key: 'company', label: 'Companies', count: 'company' },
]

const TYPE_LABELS: Record<CustomerType, string> = { individual: 'Individual', company: 'Company' }

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

// Phones get a card list instead of a table. Only one layout is rendered.
const COMPACT_QUERY = '(max-width: 900px)'

function subscribeToCompact(onChange: () => void) {
  const query = window.matchMedia(COMPACT_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function errorText(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

// "+255712345678" is shown as "+255 712 345 678"; anything else as stored.
// eslint-disable-next-line react-refresh/only-export-components
export function phoneText(phone: string) {
  const match = phone.match(/^\+255(\d{3})(\d{3})(\d{3})$/)
  return match ? `+255 ${match[1]} ${match[2]} ${match[3]}` : phone
}

// eslint-disable-next-line react-refresh/only-export-components
export function displayName(customer: Customer) {
  return (customer.type === 'company' ? customer.companyName : customer.fullName) ?? ''
}

// ---------- icons (line icons, currentColor) ----------

function Svg({ children, size = 18 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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

const SearchIcon = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Svg>
)
const BuildingIcon = () => (
  <Svg>
    <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
    <path d="M15 9h4a1 1 0 0 1 1 1v11" />
    <path d="M8 8h3M8 12h3M8 16h3M3 21h18" />
  </Svg>
)
const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
const CloseIcon = () => (
  <Svg size={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

function Avatar({ customer }: { customer: Customer }) {
  return customer.type === 'company' ? (
    <span className="office-avatar office-avatar-company" aria-hidden="true">
      <BuildingIcon />
    </span>
  ) : (
    <span className="office-avatar" aria-hidden="true">
      {initials(displayName(customer))}
    </span>
  )
}

function NameCell({ customer }: { customer: Customer }) {
  return (
    <span className="office-product-cell">
      <Avatar customer={customer} />
      <span>
        <Link className="office-staff-name office-staff-link" to={`${CUSTOMERS_PATH}/${customer.id}`}>
          {displayName(customer)}
        </Link>
        {customer.type === 'company' && customer.contactPerson && (
          <span className="office-staff-meta">Contact: {customer.contactPerson}</span>
        )}
        {customer.type === 'company' && customer.tin && (
          <span className="office-staff-meta office-number">TIN {customer.tin}</span>
        )}
      </span>
    </span>
  )
}

function TypeBadge({ customer }: { customer: Customer }) {
  return <span className={`office-status office-status-${customer.type}`}>{TYPE_LABELS[customer.type]}</span>
}

function Contacts({ customer }: { customer: Customer }) {
  if (!customer.phone && !customer.email) return <span className="office-staff-meta">No contact details</span>
  return (
    <>
      {customer.phone && <span className="office-customer-phone">{phoneText(customer.phone)}</span>}
      {customer.email && <span className="office-staff-meta">{customer.email}</span>}
    </>
  )
}

// /office/customers: the customer directory. Type tabs with counts, search by name,
// company, phone or email, paged. A name opens the customer's detail page.
export default function CustomersList() {
  const compact = useSyncExternalStore(subscribeToCompact, () => window.matchMedia(COMPACT_QUERY).matches)
  const canCreate = usePermission('customers.create')
  const location = useLocation()
  const navigate = useNavigate()

  // The success message from the form that just saved. It goes away on its own, can be
  // closed, and is dropped from the history entry so a reload does not bring it back.
  const [notice, setNotice] = useState<string | null>(
    () => (location.state as { notice?: string } | null)?.notice ?? null,
  )

  useEffect(() => {
    if ((location.state as { notice?: string } | null)?.notice) {
      navigate(location.pathname, { replace: true, state: null })
    }
    // Runs once, for the state this visit arrived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<TypeTab>('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [list, setList] = useState<ListState>({ status: 'loading' })

  // Search as you type, after a short pause.
  useEffect(() => {
    const trimmed = search.trim()
    if (trimmed === query) return
    const timer = window.setTimeout(() => {
      setList({ status: 'loading' })
      setPage(1)
      setQuery(trimmed)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search, query])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ page: String(page) })
    if (query) params.set('q', query)
    if (tab) params.set('type', tab)

    apiRequest<CustomersPage>(`/api/office/customers?${params}`, { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setList({ status: 'ready', data: result.data })
        else setList({ status: 'error', message: errorText(result) })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [query, tab, page, reload])

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (search.trim() !== query) {
      setList({ status: 'loading' })
      setPage(1)
      setQuery(search.trim())
    }
  }

  function clearSearch() {
    setSearch('')
    setList({ status: 'loading' })
    setPage(1)
    setQuery('')
  }

  function goToPage(next: number) {
    setList({ status: 'loading' })
    setPage(next)
  }

  const totalPages = list.status === 'ready' ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1
  const nothingYet = list.status === 'ready' && list.data.counts.all === 0 && !query

  return (
    <>
      <div className="office-product-head">
        <div className="office-product-heading">
          <h1 className="office-title">Customers</h1>
          <p className="office-lead">The people and companies PSP sells to</p>
        </div>
        {canCreate && (
          <div className="office-product-actions">
            <Link className="button button-primary" to={`${CUSTOMERS_PATH}/new`}>
              <PlusIcon />
              Add customer
            </Link>
          </div>
        )}
      </div>

      {notice && (
        <div className="office-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="office-notice-close"
            aria-label="Dismiss message"
            onClick={() => setNotice(null)}
          >
            <CloseIcon />
          </button>
        </div>
      )}

      <section className="office-list-card" aria-label="Customers">
        <div className="office-tabs" role="group" aria-label="Customer type">
          {TABS.map((item) => (
            <button
              key={item.key || 'all'}
              type="button"
              className={tab === item.key ? 'office-tab is-active' : 'office-tab'}
              aria-pressed={tab === item.key}
              onClick={() => {
                if (tab === item.key) return
                setList({ status: 'loading' })
                setPage(1)
                setTab(item.key)
              }}
            >
              {item.label}
              {list.status === 'ready' && <span className="office-tab-count">{list.data.counts[item.count]}</span>}
            </button>
          ))}
        </div>

        <div className="office-list-filters">
          <form className="office-search" role="search" onSubmit={handleSearch}>
            <span className="office-search-icon">
              <SearchIcon />
            </span>
            <label className="visually-hidden" htmlFor="customer-search">
              Search by name, company, phone or email
            </label>
            <input
              id="customer-search"
              className="field-input"
              type="search"
              placeholder="Name, company, phone or email"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={100}
            />
          </form>
        </div>

        {list.status === 'loading' && (
          <ul className="office-skeleton" aria-busy="true" aria-label="Loading customers">
            {[0, 1, 2, 3].map((n) => (
              <li key={n} className="office-skeleton-row" />
            ))}
          </ul>
        )}
        {list.status === 'error' && (
          <>
            <div className="office-error office-list-error" role="alert">
              {list.message}
            </div>
            <button
              type="button"
              className="button button-secondary office-retry"
              onClick={() => {
                setList({ status: 'loading' })
                setReload((value) => value + 1)
              }}
            >
              Try again
            </button>
          </>
        )}
        {list.status === 'ready' && list.data.customers.length === 0 && (
          <div className="office-list-empty office-customer-empty">
            {nothingYet ? (
              <p className="office-reset-empty">No customers yet.</p>
            ) : (
              <>
                <p className="office-reset-empty">
                  {query ? `No customers match “${query}”.` : 'No customers of this type yet.'}
                </p>
                {query && (
                  <button type="button" className="button button-secondary" onClick={clearSearch}>
                    Clear search
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {list.status === 'ready' && list.data.customers.length > 0 && (
          <>
            {!compact && (
              <div className="office-staff-table-wrap">
                <table className="office-staff-table">
                  <thead>
                    <tr>
                      <th scope="col">Customer</th>
                      <th scope="col">Type</th>
                      <th scope="col">Phone and email</th>
                      <th scope="col">Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.customers.map((customer) => (
                      <tr key={customer.id}>
                        <td>
                          <NameCell customer={customer} />
                        </td>
                        <td>
                          <TypeBadge customer={customer} />
                        </td>
                        <td>
                          <Contacts customer={customer} />
                        </td>
                        <td className="office-number">{DATE.format(new Date(customer.createdAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compact && (
              <ul className="office-staff-cards office-list-cards">
                {list.data.customers.map((customer) => (
                  <li key={customer.id} className="office-staff-card">
                    <NameCell customer={customer} />
                    <dl className="office-staff-facts">
                      <div>
                        <dt>Type</dt>
                        <dd>
                          <TypeBadge customer={customer} />
                        </dd>
                      </div>
                      <div>
                        <dt>Contact</dt>
                        <dd className="office-customer-contacts">
                          <Contacts customer={customer} />
                        </dd>
                      </div>
                      <div>
                        <dt>Added</dt>
                        <dd className="office-number">{DATE.format(new Date(customer.createdAt))}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}

            <nav className="office-staff-paging office-list-footer" aria-label="Customer pages">
              <span>
                Showing {list.data.customers.length} of {list.data.total}{' '}
                {list.data.total === 1 ? 'customer' : 'customers'}
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
      </section>
    </>
  )
}

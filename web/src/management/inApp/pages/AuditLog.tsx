import { useEffect, useState, useSyncExternalStore } from 'react'
import { apiRequest, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'
import { PLACED } from './OrdersList'
import { TZS } from './ProductForm'

export type AuditEvent = {
  id: string
  type: string
  actorId: string | null
  actorName: string | null
  targetId: string | null
  targetName: string | null
  ip: string | null
  meta: Record<string, unknown>
  createdAt: string
}

type AuditPage = { events: AuditEvent[]; total: number; page: number; pageSize: number }
type Category = '' | 'auth' | 'staff' | 'reset_request' | 'product' | 'customer' | 'order'
type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: AuditPage }

const TABS: { key: Category; label: string }[] = [
  { key: '', label: 'All events' },
  { key: 'auth', label: 'Sign-in' },
  { key: 'staff', label: 'Staff' },
  { key: 'reset_request', label: 'Reset requests' },
  { key: 'product', label: 'Products' },
  { key: 'customer', label: 'Customers' },
  { key: 'order', label: 'Orders' },
]

const TYPE_LABELS: Record<string, string> = {
  'auth.login_succeeded': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.account_locked': 'Account locked',
  'auth.logged_out': 'Signed out',
  'auth.logged_out_all': 'Signed out of all devices',
  'auth.password_changed': 'Changed own password',
  'reset_request.created': 'Password reset requested',
  'reset_request.dismissed': 'Reset request dismissed',
  'staff.created': 'Staff registered',
  'staff.updated': 'Staff profile edited',
  'staff.deactivated': 'Staff deactivated',
  'staff.reactivated': 'Staff reactivated',
  'staff.role_changed': 'Staff role changed',
  'staff.password_reset': 'Password reset by IT',
  'product.created': 'Product added',
  'product.updated': 'Product edited',
  'product.price_changed': 'Price changed',
  'product.published': 'Product published',
  'product.unpublished': 'Product unpublished',
  'product.archived': 'Product archived',
  'product.restored': 'Product restored',
  'product.images_added': 'Photos added',
  'product.image_removed': 'Photo removed',
  'customer.created': 'Customer added',
  'customer.updated': 'Customer edited',
  'order.created': 'Order created',
  'order.status_changed': 'Order status changed',
  'order.paid': 'Order marked paid',
  'order.items_changed': 'Order items changed',
  'order.customer_linked': 'Order linked to a customer',
  'order.customer_created': 'Customer created from an order',
  'order.customer_unlinked': 'Order unlinked from a customer',
}

const FIELD_LABELS: Record<string, string> = { priceTzs: 'Price', costPriceTzs: 'Cost price' }

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

// A type this page does not know (a newer server) still reads sensibly.
// Also used by the page test.
// eslint-disable-next-line react-refresh/only-export-components
export function typeLabel(type: string) {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type]
  const words = type.replace(/[._]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const shortId = (id: string) => id.slice(0, 8)

function money(value: unknown) {
  return typeof value === 'number' ? `TZS ${TZS.format(value)}` : 'none'
}

// The one line under an event: what changed, from the event's own details.
// Also used by the page test.
// eslint-disable-next-line react-refresh/only-export-components
export function detailText(event: AuditEvent) {
  const { meta } = event
  const parts: string[] = []
  if (event.type === 'product.price_changed') {
    const label = FIELD_LABELS[String(meta.field)] ?? 'Price'
    parts.push(`${label}: ${money(meta.from)} to ${money(meta.to)}`)
  }
  if (typeof meta.sku === 'string' && event.type.startsWith('product.')) parts.push(`SKU ${meta.sku}`)
  if (typeof meta.orderNumber === 'string') parts.push(`Order ${meta.orderNumber}`)
  if (typeof meta.status === 'string') parts.push(`Now ${meta.status}`)
  if (typeof meta.from === 'string' && typeof meta.to === 'string') parts.push(`${meta.from} to ${meta.to}`)
  if (typeof meta.role === 'string') parts.push(`Role ${meta.role}`)
  if (typeof meta.email === 'string') parts.push(meta.email)
  if (typeof meta.reason === 'string') parts.push(`Reason: ${meta.reason}`)
  if (Array.isArray(meta.fields) && meta.fields.length && event.type !== 'product.price_changed') {
    parts.push(`Changed: ${meta.fields.join(', ')}`)
  }
  if (typeof meta.count === 'number') parts.push(`${meta.count} ${meta.count === 1 ? 'photo' : 'photos'}`)
  if (typeof meta.lines === 'number') parts.push(`${meta.lines} ${meta.lines === 1 ? 'line' : 'lines'}`)
  return parts.join(' · ')
}

function actorText(event: AuditEvent) {
  if (event.actorName) return event.actorName
  if (event.actorId) return `Staff ${shortId(event.actorId)}`
  return 'Not signed in'
}

function targetText(event: AuditEvent) {
  if (event.targetName) return event.targetName
  if (typeof event.meta.orderNumber === 'string') return event.meta.orderNumber
  if (typeof event.meta.sku === 'string') return event.meta.sku
  if (event.targetId) return shortId(event.targetId)
  return null
}

function EventCell({ event }: { event: AuditEvent }) {
  const detail = detailText(event)
  return (
    <>
      <span className="office-staff-name">{typeLabel(event.type)}</span>
      {detail && <span className="office-staff-meta">{detail}</span>}
    </>
  )
}

// /office/audit-log: who did what, newest first. Read-only; needs audit.view.
export default function AuditLog() {
  const compact = useSyncExternalStore(subscribeToCompact, () => window.matchMedia(COMPACT_QUERY).matches)
  const [tab, setTab] = useState<Category>('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [list, setList] = useState<ListState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ page: String(page) })
    if (tab) params.set('category', tab)

    apiRequest<AuditPage>(`/api/office/audit-logs?${params}`, { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setList({ status: 'ready', data: result.data })
        else setList({ status: 'error', message: errorText(result) })
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [tab, page, reload])

  const totalPages = list.status === 'ready' ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1

  return (
    <>
      <div className="office-product-head">
        <div className="office-product-heading">
          <h1 className="office-title">Audit log</h1>
          <p className="office-lead">Who did what, newest first</p>
        </div>
      </div>

      <section className="office-list-card" aria-label="Audit log">
        <div className="office-tabs office-order-tabs" role="group" aria-label="Event type">
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
            </button>
          ))}
        </div>

        {list.status === 'loading' && (
          <ul className="office-skeleton" aria-busy="true" aria-label="Loading events">
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
        {list.status === 'ready' && list.data.events.length === 0 && (
          <div className="office-list-empty office-customer-empty">
            <p className="office-reset-empty">
              {tab ? 'No events of this type yet.' : 'No events yet. Sign-ins and changes are recorded here.'}
            </p>
          </div>
        )}

        {list.status === 'ready' && list.data.events.length > 0 && (
          <>
            {!compact && (
              <div className="office-staff-table-wrap">
                <table className="office-staff-table office-audit-table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Event</th>
                      <th scope="col">By</th>
                      <th scope="col">About</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.events.map((event) => (
                      <tr key={event.id}>
                        <td className="office-number">{PLACED.format(new Date(event.createdAt))}</td>
                        <td>
                          <EventCell event={event} />
                        </td>
                        <td>
                          <span className="office-staff-name">{actorText(event)}</span>
                          {event.ip && <span className="office-staff-meta office-number">{event.ip}</span>}
                        </td>
                        <td>{targetText(event) ?? <span className="office-staff-meta">None</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compact && (
              <ul className="office-staff-cards office-list-cards">
                {list.data.events.map((event) => (
                  <li key={event.id} className="office-staff-card office-audit-card">
                    <EventCell event={event} />
                    <dl className="office-staff-facts">
                      <div>
                        <dt>When</dt>
                        <dd className="office-number">{PLACED.format(new Date(event.createdAt))}</dd>
                      </div>
                      <div>
                        <dt>By</dt>
                        <dd>
                          {actorText(event)}
                          {event.ip && <span className="office-staff-meta office-number">{event.ip}</span>}
                        </dd>
                      </div>
                      {targetText(event) && (
                        <div>
                          <dt>About</dt>
                          <dd>{targetText(event)}</dd>
                        </div>
                      )}
                    </dl>
                  </li>
                ))}
              </ul>
            )}

            <nav className="office-staff-paging office-list-footer" aria-label="Audit log pages">
              <span>
                Showing {list.data.events.length} of {list.data.total} {list.data.total === 1 ? 'event' : 'events'}
              </span>
              {totalPages > 1 && (
                <span className="office-reset-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={page <= 1}
                    onClick={() => {
                      setList({ status: 'loading' })
                      setPage(page - 1)
                    }}
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
                    onClick={() => {
                      setList({ status: 'loading' })
                      setPage(page + 1)
                    }}
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

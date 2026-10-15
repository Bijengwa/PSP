import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from '../../auth/AuthProvider'
import Sidebar from './Sidebar'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const people = {
  admin: { id: 'a1', fullName: 'Asha Admin', email: 'asha@psp.test', role: 'IT', mustChangePassword: false },
  staff: { id: 's1', fullName: 'Sam Staff', email: 'sam@psp.test', role: 'staff', mustChangePassword: false },
}

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })

function stubApi(me: (typeof people)[keyof typeof people], pending = 0, newOrders = 0) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/auth/me')) return ok({ staff: me })
    if (url.includes('/api/office/orders')) return ok({ orders: [], total: newOrders })
    return ok({ requests: [], total: pending })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// Shows once /me has answered, so the test reads the sidebar for the signed-in person.
function SignedIn() {
  const { state } = useAuth()
  return state.status === 'authenticated' ? <p>Signed in as {state.staff.role}</p> : null
}

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/office']}>
      <AuthProvider>
        <SignedIn />
        <Sidebar
          id="office-sidebar"
          drawerOpen={false}
          drawerShown={false}
          collapsed={false}
          isMobile={false}
          closeButtonRef={createRef<HTMLButtonElement>()}
          onClose={() => {}}
          onToggleRail={() => {}}
        />
      </AuthProvider>
    </MemoryRouter>,
  )
}

const IT_LINKS = ['Staff', 'Register Staff', /^Reset requests/]

describe('Sidebar IT group', () => {
  it('is not shown to a non-admin, and the reset badge is never asked for', async () => {
    const fetchMock = stubApi(people.staff)
    renderSidebar()
    await screen.findByText('Signed in as staff')

    const nav = screen.getByRole('navigation', { name: 'Office' })
    expect(within(nav).queryByRole('heading', { name: 'IT' })).toBeNull()
    for (const name of IT_LINKS) expect(within(nav).queryByRole('link', { name })).toBeNull()
    expect(within(nav).getByRole('link', { name: 'Products' })).not.toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/office/reset-requests'))).toBe(false)
  })

  it('is shown to an admin, with Staff, Register Staff and Reset requests and the pending badge', async () => {
    stubApi(people.admin, 3)
    renderSidebar()
    await screen.findByText('Signed in as IT')

    const nav = screen.getByRole('navigation', { name: 'Office' })
    const list = within(nav).getByRole('list', { name: 'IT' })
    expect(within(list).getByRole('link', { name: 'Staff' }).getAttribute('href')).toBe('/office/staff')
    expect(within(list).getByRole('link', { name: 'Register Staff' }).getAttribute('href')).toBe('/office/staff/new')
    expect(
      (await within(list).findByRole('link', { name: 'Reset requests, 3 pending' })).getAttribute('href'),
    ).toBe('/office/reset-requests')
  })
})

describe('Sidebar Orders badge', () => {
  it('shows the count of new orders to any signed-in staff member', async () => {
    const fetchMock = stubApi(people.staff, 0, 4)
    renderSidebar()
    await screen.findByText('Signed in as staff')

    const nav = screen.getByRole('navigation', { name: 'Office' })
    const link = await within(nav).findByRole('link', { name: 'Orders, 4 new' })
    expect(link.getAttribute('href')).toBe('/office/orders')
    expect(within(link).getByText('4')).not.toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/office/orders?status=new'))).toBe(true)
  })

  it('shows no badge when there are no new orders', async () => {
    const fetchMock = stubApi(people.admin, 0, 0)
    renderSidebar()
    await screen.findByText('Signed in as IT')
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/office/orders'))).toBe(true),
    )

    const link = within(screen.getByRole('navigation', { name: 'Office' })).getByRole('link', { name: 'Orders' })
    expect(link.querySelector('.office-nav-badge')).toBeNull()
  })
})

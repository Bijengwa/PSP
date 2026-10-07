import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../../api/client'
import { AuthProvider, CHANGE_PASSWORD_PATH, LOGIN_PATH } from './AuthProvider'
import RequireAuth from './RequireAuth'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const staff = { id: '1', fullName: 'Test Admin', email: 'admin@psp.test', role: 'admin', mustChangePassword: false }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}
const ok = (data: unknown) => json(200, { success: true, data })
const fail = (status: number, code?: string) => json(status, { success: false, error: { message: 'No', code } })

// Shows where the router ended up, and the return-to path login would get.
function LoginSpy() {
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  return <p>Login page from={from ?? 'none'}</p>
}

// Calls the API on demand, as any office page would.
function Caller() {
  return (
    <button type="button" onClick={() => void apiRequest('/api/office/anything')}>
      Call API
    </button>
  )
}

function renderOffice(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path={LOGIN_PATH} element={<LoginSpy />} />
          <Route path={CHANGE_PASSWORD_PATH} element={<p>Change password page</p>} />
          <Route element={<RequireAuth />}>
            <Route path="/office/orders" element={<Caller />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

// First /me answers as `me`; the first call to /api/office/anything as `later`.
function stubApi(me: () => Response, later?: () => Response) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/auth/me')) return me()
    if (url.endsWith('/api/office/anything') && later) return later()
    return fail(404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('RequireAuth redirects', () => {
  it('sends a signed-out visitor to login, remembering the page', async () => {
    stubApi(() => fail(401))
    renderOffice('/office/orders?page=2')
    expect(await screen.findByText('Login page from=/office/orders?page=2')).not.toBeNull()
  })

  it('lets a signed-in person see the page', async () => {
    stubApi(() => ok({ staff }))
    renderOffice('/office/orders')
    expect(await screen.findByRole('button', { name: 'Call API' })).not.toBeNull()
  })

  it('sends a person on a temporary password to change-password', async () => {
    stubApi(() => ok({ staff: { ...staff, mustChangePassword: true } }))
    renderOffice('/office/orders')
    expect(await screen.findByText('Change password page')).not.toBeNull()
  })

  it('shows the unavailable screen when /me answers 503', async () => {
    stubApi(() => fail(503))
    renderOffice('/office/orders')
    expect(await screen.findByText('Service temporarily unavailable')).not.toBeNull()
    expect(screen.queryByText(/^Login page/)).toBeNull()
  })

  it('sends the person to login when a later call answers 401', async () => {
    stubApi(
      () => ok({ staff }),
      () => fail(401),
    )
    renderOffice('/office/orders')
    fireEvent.click(await screen.findByRole('button', { name: 'Call API' }))
    expect(await screen.findByText('Login page from=/office/orders')).not.toBeNull()
  })

  it('sends the person to change-password when a later call answers 403 PASSWORD_CHANGE_REQUIRED', async () => {
    stubApi(
      () => ok({ staff }),
      () => fail(403, 'PASSWORD_CHANGE_REQUIRED'),
    )
    renderOffice('/office/orders')
    fireEvent.click(await screen.findByRole('button', { name: 'Call API' }))
    expect(await screen.findByText('Change password page')).not.toBeNull()
  })

  it('shows the unavailable screen when a later call answers 503, and Try again brings the page back', async () => {
    let meCalls = 0
    stubApi(
      () => {
        meCalls += 1
        return ok({ staff })
      },
      () => fail(503),
    )
    renderOffice('/office/orders')
    fireEvent.click(await screen.findByRole('button', { name: 'Call API' }))
    expect(await screen.findByText('Service temporarily unavailable')).not.toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })
    expect(await screen.findByRole('button', { name: 'Call API' })).not.toBeNull()
    expect(meCalls).toBe(2)
  })

  it('does not treat any other 403 as a session problem', async () => {
    stubApi(
      () => ok({ staff }),
      () => fail(403, 'FORBIDDEN'),
    )
    renderOffice('/office/orders')
    fireEvent.click(await screen.findByRole('button', { name: 'Call API' }))
    await act(async () => {}) // let the failed call settle
    expect(screen.getByRole('button', { name: 'Call API' })).not.toBeNull()
    expect(screen.queryByText('Change password page')).toBeNull()
    expect(screen.queryByText(/^Login page/)).toBeNull()
  })
})

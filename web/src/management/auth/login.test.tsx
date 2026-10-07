import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, LOGIN_PATH } from './AuthProvider'
import Login, { safeReturnPath } from './login'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('safeReturnPath', () => {
  it('accepts office pages', () => {
    expect(safeReturnPath('/office')).toBe('/office')
    expect(safeReturnPath('/office/orders')).toBe('/office/orders')
    expect(safeReturnPath('/office/orders?page=2')).toBe('/office/orders?page=2')
    expect(safeReturnPath('/office/staff#top')).toBe('/office/staff#top')
  })

  it('falls back to the office home for anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['/office/orders']]) {
      expect(safeReturnPath(value)).toBe('/office')
    }
  })

  it('rejects other sites and non-office paths', () => {
    for (const value of [
      'https://evil.example/office',
      'http://evil.example',
      '//evil.example',
      '/',
      '/shop',
      '/officeevil',
      'office/orders',
      'javascript:alert(1)',
    ]) {
      expect(safeReturnPath(value)).toBe('/office')
    }
  })

  it('rejects slash, backslash and control character tricks', () => {
    for (const value of ['/office//evil.example', '/office\\evil', '/office/\\evil.example', '/office/a\nb', '/office/a\tb', '/office/\u0000']) {
      expect(safeReturnPath(value)).toBe('/office')
    }
  })

  it('rejects paths that climb out of /office', () => {
    expect(safeReturnPath('/office/../admin')).toBe('/office')
    expect(safeReturnPath('/office/%2e%2e/admin')).toBe('/office')
    expect(safeReturnPath('/office/..%2fadmin')).toBe('/office/..%2fadmin') // stays under /office: one segment
  })

  it('never returns to the login or forgot-password pages', () => {
    expect(safeReturnPath('/office/auth/login')).toBe('/office')
    expect(safeReturnPath('/office/auth/login/')).toBe('/office')
    expect(safeReturnPath('/office/auth/forgot-password')).toBe('/office')
  })
})

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

const staff = { id: '1', fullName: 'Test Admin', email: 'admin@psp.test', role: 'admin', mustChangePassword: false }

describe('login return-to', () => {
  it('sends the person to the page they asked for after logging in', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/me')) return json(401, { success: false, error: { message: 'Not signed in' } })
      if (url.endsWith('/api/auth/login')) return json(200, { success: true, data: { staff } })
      return json(404, { success: false, error: { message: 'Not found' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter initialEntries={[{ pathname: LOGIN_PATH, state: { from: '/office/orders?page=2' } }]}>
        <AuthProvider>
          <Routes>
            <Route path={LOGIN_PATH} element={<Login />} />
            <Route path="/office/orders" element={<p>Orders page</p>} />
            <Route path="/office" element={<p>Office home</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    // Wait for /me to settle, so the login response is what signs the person in.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@psp.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    expect(await screen.findByText('Orders page')).not.toBeNull()
  })

  it('ignores an unsafe return-to and lands on the office home', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/me')) return json(401, { success: false, error: { message: 'Not signed in' } })
      if (url.endsWith('/api/auth/login')) return json(200, { success: true, data: { staff } })
      return json(404, { success: false, error: { message: 'Not found' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter initialEntries={[{ pathname: LOGIN_PATH, state: { from: '//evil.example' } }]}>
        <AuthProvider>
          <Routes>
            <Route path={LOGIN_PATH} element={<Login />} />
            <Route path="/office" element={<p>Office home</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@psp.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    expect(await screen.findByText('Office home')).not.toBeNull()
  })
})

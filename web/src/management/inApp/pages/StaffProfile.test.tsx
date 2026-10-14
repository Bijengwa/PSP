import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../auth/AuthProvider'
import ProfileMenu from '../layout/ProfileMenu'
import StaffProfile, { MyProfile } from './StaffProfile'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const admin = { id: 'a1', fullName: 'Asha Admin', email: 'asha@psp.test', role: 'admin', mustChangePassword: false }
const person = {
  id: 'p1',
  fullName: 'Sam Staff',
  email: 'sam@psp.test',
  phone: '+255 700 000 001',
  role: 'staff',
  isActive: true,
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: '2026-10-01T08:00:00.000Z',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}
const ok = (data: unknown) => json(200, { success: true, data })

type Handler = (url: string, init?: RequestInit) => Response

function stubApi(handler: Handler, me = admin) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    url.endsWith('/api/auth/me') ? ok({ staff: me }) : handler(url, init),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/office/staff/:id" element={<StaffProfile />} />
          <Route path="/office/profile" element={<MyProfile />} />
          <Route path="/office/staff" element={<p>Staff list</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('StaffProfile', () => {
  it('shows the profile, saves an edit and shows the new values', async () => {
    const fetchMock = stubApi((_, init) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        return ok({ staff: { ...person, fullName: body.fullName, phone: body.phone } })
      }
      return ok({ staff: person })
    })
    renderAt('/office/staff/p1')

    expect(await screen.findByRole('heading', { level: 1, name: 'Sam Staff' })).not.toBeNull()
    expect(screen.getByText('+255 700 000 001')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Samuel Mushi' } })
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+255 712 345 678' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Samuel Mushi' })).not.toBeNull()
    expect(screen.getByText('+255 712 345 678')).not.toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Changes saved.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }))

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(patch?.[0]).toMatch(/\/api\/office\/staff\/p1$/)
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ fullName: 'Samuel Mushi', phone: '+255 712 345 678' })
  })

  it('shows server field errors next to the fields and keeps what was typed', async () => {
    stubApi((_, init) =>
      init?.method === 'PATCH'
        ? json(400, {
            success: false,
            error: {
              message: 'Check the highlighted fields.',
              code: 'VALIDATION_ERROR',
              details: { phone: 'Enter a valid phone number, for example +255 700 000 000.' },
            },
          })
        : ok({ staff: person }),
    )
    renderAt('/office/staff/p1')

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    const error = await screen.findByText('Enter a valid phone number, for example +255 700 000 000.')
    const phone = screen.getByLabelText('Phone') as HTMLInputElement
    expect(phone.value).toBe('abc')
    expect(phone.getAttribute('aria-invalid')).toBe('true')
    expect(phone.getAttribute('aria-describedby')).toContain(error.id)
    expect(screen.getByRole('alert').textContent).toBe('Check the highlighted fields.')
    expect(document.activeElement).toBe(phone)
  })

  it('catches an empty name before sending anything', async () => {
    const fetchMock = stubApi(() => ok({ staff: person }))
    renderAt('/office/staff/p1')

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Enter the full name.')).not.toBeNull()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })

  it('Cancel closes the form without saving', async () => {
    stubApi(() => ok({ staff: person }))
    renderAt('/office/staff/p1')

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Someone Else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByLabelText('Full name')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Sam Staff' })).not.toBeNull()
  })

  it('an unknown person shows a not-found message', async () => {
    stubApi(() => json(404, { success: false, error: { message: 'Not found' } }))
    renderAt('/office/staff/nobody')

    expect(await screen.findByRole('heading', { level: 1, name: 'Staff member not found' })).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to staff' })).not.toBeNull()
  })

  it('a failed load shows the error with a retry that works', async () => {
    let calls = 0
    stubApi(() => {
      calls += 1
      return calls === 1 ? json(500, { success: false, error: { message: 'Database error' } }) : ok({ staff: person })
    })
    renderAt('/office/staff/p1')

    expect((await screen.findByRole('alert')).textContent).toBe('Database error')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Sam Staff' })).not.toBeNull()
  })
})

describe('MyProfile', () => {
  it('shows the signed-in person read only', async () => {
    stubApi(() => json(404, {}), { ...admin, id: 's9', fullName: 'Neema Staff', email: 'neema@psp.test', role: 'staff' })
    renderAt('/office/profile')

    expect(await screen.findByRole('heading', { level: 1, name: 'Neema Staff' })).not.toBeNull()
    const details = screen.getByRole('region', { name: 'Your details' })
    expect(within(details).getByText('neema@psp.test')).not.toBeNull()
    expect(within(details).getByText('Staff')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('link', { name: 'Change password' })).not.toBeNull()
  })

  it('the profile menu opens it', () => {
    render(
      <MemoryRouter>
        <ProfileMenu staff={admin} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Asha Admin/ }))
    expect(screen.getByRole('menuitem', { name: 'Profile' }).getAttribute('href')).toBe('/office/profile')
  })
})

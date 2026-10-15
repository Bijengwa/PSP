import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../auth/AuthProvider'
import ProfileMenu from '../layout/ProfileMenu'
import StaffProfile, { MyProfile } from './StaffProfile'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const admin = { id: 'a1', fullName: 'Asha Admin', email: 'asha@psp.test', role: 'IT', mustChangePassword: false }
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
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' })))

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
    // Focus moves in an effect, which can run just after the error text appears.
    await waitFor(() => expect(document.activeElement).toBe(phone))
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

describe('StaffProfile access', () => {
  it('deactivates only after confirming, then offers Reactivate', async () => {
    const fetchMock = stubApi((_, init) =>
      init?.method === 'PATCH' ? ok({ staff: { ...person, isActive: false } }) : ok({ staff: person }),
    )
    renderAt('/office/staff/p1')

    const access = await screen.findByRole('region', { name: 'Access' })
    fireEvent.click(within(access).getByRole('button', { name: 'Deactivate' }))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)

    const confirm = within(access).getByRole('group', { name: 'Deactivate Sam Staff?' })
    // Up to 5 s: in the full parallel suite the focus effect can run after the 1 s default.
    await waitFor(() => expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' })), {
      timeout: 5000,
    })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Deactivate account' }))

    const reactivate = await within(access).findByRole('button', { name: 'Reactivate' })
    await waitFor(() => expect(document.activeElement).toBe(reactivate), { timeout: 5000 })
    expect(screen.getByRole('status').textContent).toBe('Sam Staff is deactivated and has been signed out.')
    expect(screen.getAllByText('Inactive').length).toBeGreaterThan(0)

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(patch?.[0]).toMatch(/\/api\/office\/staff\/p1$/)
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ isActive: false })
    // The two 5 s waits above need more than the 5 s default for the whole test.
  }, 15000)

  it('Cancel closes the confirmation without sending anything', async () => {
    const fetchMock = stubApi(() => ok({ staff: person }))
    renderAt('/office/staff/p1')

    const access = await screen.findByRole('region', { name: 'Access' })
    fireEvent.click(within(access).getByRole('button', { name: 'Deactivate' }))
    fireEvent.click(within(access).getByRole('button', { name: 'Cancel' }))

    expect(within(access).queryByRole('group')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(within(access).getByRole('button', { name: 'Deactivate' })))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })

  it('reactivates an inactive person', async () => {
    const fetchMock = stubApi((_, init) =>
      init?.method === 'PATCH' ? ok({ staff: person }) : ok({ staff: { ...person, isActive: false } }),
    )
    renderAt('/office/staff/p1')

    const access = await screen.findByRole('region', { name: 'Access' })
    expect(within(access).getByText(/This account is deactivated/)).not.toBeNull()
    fireEvent.click(within(access).getByRole('button', { name: 'Reactivate' }))

    expect(await within(access).findByRole('button', { name: 'Deactivate' })).not.toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Sam Staff is active again and can sign in.')
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ isActive: true })
  })

  it('shows the server refusal and keeps the person active', async () => {
    stubApi((_, init) =>
      init?.method === 'PATCH'
        ? json(409, {
            success: false,
            error: { message: 'The last active admin cannot be deactivated.', code: 'LAST_ADMIN' },
          })
        : ok({ staff: person }),
    )
    renderAt('/office/staff/p1')

    const access = await screen.findByRole('region', { name: 'Access' })
    fireEvent.click(within(access).getByRole('button', { name: 'Deactivate' }))
    fireEvent.click(within(access).getByRole('button', { name: 'Deactivate account' }))

    expect((await within(access).findByRole('alert')).textContent).toBe('The last active admin cannot be deactivated.')
    expect(within(access).getByRole('button', { name: 'Deactivate account' })).not.toBeNull()
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0)
  })

  it('offers no deactivation on your own profile', async () => {
    stubApi(() => ok({ staff: { ...person, id: admin.id, fullName: admin.fullName, role: 'IT' } }))
    renderAt(`/office/staff/${admin.id}`)

    const access = await screen.findByRole('region', { name: 'Access' })
    expect(within(access).getByText(/This is your own account/)).not.toBeNull()
    expect(within(access).queryByRole('button')).toBeNull()
  })
})

describe('StaffProfile role', () => {
  const roles = [
    { name: 'IT', description: 'Full access to the office' },
    { name: 'staff', description: 'Normal office employee' },
  ]

  // Profile reads, the roles list, and `patch` for the role change.
  function stubRoles(patch: (body: { role: string }) => Response, rolesResponse = () => ok({ roles })) {
    return stubApi((url, init) => {
      if (url.endsWith('/api/office/roles')) return rolesResponse()
      if (init?.method === 'PATCH') return patch(JSON.parse(String(init.body)))
      return ok({ staff: person })
    })
  }

  it('changes the role to one of the existing roles and says the person was signed out', async () => {
    const fetchMock = stubRoles((body) => ok({ staff: { ...person, role: body.role } }))
    renderAt('/office/staff/p1')

    const card = await screen.findByRole('region', { name: 'Role' })
    fireEvent.click(within(card).getByRole('button', { name: 'Change role' }))

    const staffOption = await within(card).findByRole('radio', { name: /Staff/ })
    await waitFor(() => expect(document.activeElement).toBe(staffOption))
    expect((staffOption as HTMLInputElement).checked).toBe(true)
    const adminOption = within(card).getByRole('radio', { name: /IT/ })
    expect(adminOption.getAttribute('aria-describedby')).toBe('role-IT-description')
    const save = within(card).getByRole('button', { name: 'Save role' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.click(adminOption)
    expect(save.disabled).toBe(false)
    expect(within(card).getByText('Sam Staff is signed out right away and signs in again as IT.')).not.toBeNull()
    fireEvent.click(save)

    const change = await within(card).findByRole('button', { name: 'Change role' })
    await waitFor(() => expect(document.activeElement).toBe(change))
    expect(screen.getByRole('status').textContent).toBe('Sam Staff is now IT and has been signed out.')
    expect(within(card).getByText(/Sam is IT./)).not.toBeNull()

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(patch?.[0]).toMatch(/\/api\/office\/staff\/p1$/)
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ role: 'IT' })
  })

  it('shows the server refusal and keeps the choice', async () => {
    stubRoles(() =>
      json(409, {
        success: false,
        error: { message: 'The last active admin cannot be given another role.', code: 'LAST_ADMIN' },
      }),
    )
    renderAt('/office/staff/p1')

    const card = await screen.findByRole('region', { name: 'Role' })
    fireEvent.click(within(card).getByRole('button', { name: 'Change role' }))
    fireEvent.click(await within(card).findByRole('radio', { name: /IT/ }))
    fireEvent.click(within(card).getByRole('button', { name: 'Save role' }))

    expect((await within(card).findByRole('alert')).textContent).toBe(
      'The last active admin cannot be given another role.',
    )
    expect((within(card).getByRole('radio', { name: /IT/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('a failed roles load shows the error with a retry that works', async () => {
    let calls = 0
    stubRoles(
      () => ok({ staff: person }),
      () => {
        calls += 1
        return calls === 1 ? json(500, { success: false, error: { message: 'Database error' } }) : ok({ roles })
      },
    )
    renderAt('/office/staff/p1')

    const card = await screen.findByRole('region', { name: 'Role' })
    fireEvent.click(within(card).getByRole('button', { name: 'Change role' }))
    expect((await within(card).findByRole('alert')).textContent).toBe('Database error')
    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
    expect(await within(card).findByRole('radio', { name: /IT/ })).not.toBeNull()
  })

  it('Cancel closes the choice without sending anything', async () => {
    const fetchMock = stubRoles(() => ok({ staff: person }))
    renderAt('/office/staff/p1')

    const card = await screen.findByRole('region', { name: 'Role' })
    fireEvent.click(within(card).getByRole('button', { name: 'Change role' }))
    fireEvent.click(await within(card).findByRole('radio', { name: /IT/ }))
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }))

    expect(within(card).queryByRole('radio')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Change role' })))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })

  it('offers no role change on your own admin profile', async () => {
    stubApi(() => ok({ staff: { ...person, id: admin.id, fullName: admin.fullName, role: 'IT' } }))
    renderAt(`/office/staff/${admin.id}`)

    const card = await screen.findByRole('region', { name: 'Role' })
    expect(within(card).getByText(/You cannot remove your own IT role/)).not.toBeNull()
    expect(within(card).queryByRole('button')).toBeNull()
  })
})

describe('StaffProfile password reset', () => {
  const STRONG = 'Blue-Lantern-73!'

  function stubReset(reset: (body: { temporaryPassword: string }) => Response) {
    return stubApi((url, init) => {
      if (url.endsWith('/reset-password')) return reset(JSON.parse(String(init?.body)))
      return ok({ staff: person })
    })
  }

  it('sets a temporary password, says the person was signed out, and forgets the password', async () => {
    const fetchMock = stubReset(() =>
      ok({ staff: { ...person, mustChangePassword: true }, resolvedRequests: 2 }),
    )
    const badgeRefresh = vi.fn()
    window.addEventListener('psp:reset-requests-changed', badgeRefresh)
    renderAt('/office/staff/p1')

    const card = await screen.findByRole('region', { name: 'Password' })
    fireEvent.click(within(card).getByRole('button', { name: 'Reset password' }))

    const input = within(card).getByLabelText('Temporary password') as HTMLInputElement
    // Up to 5 s: in the full parallel suite the focus effect can run after the 1 s default.
    await waitFor(() => expect(document.activeElement).toBe(input), { timeout: 5000 })
    expect(input.type).toBe('password')
    expect(input.getAttribute('aria-describedby')).toContain('profile-password-rules')
    expect(within(card).getByRole('list', { name: 'Password rules' })).not.toBeNull()

    fireEvent.change(input, { target: { value: STRONG } })
    fireEvent.click(within(card).getByRole('button', { name: 'Set temporary password' }))

    const again = await within(card).findByRole('button', { name: 'Reset password' })
    await waitFor(() => expect(document.activeElement).toBe(again), { timeout: 5000 })
    expect(screen.getByRole('status').textContent).toBe(
      'Temporary password set for Sam Staff. They have been signed out. 2 pending reset requests were resolved.',
    )
    expect(screen.getAllByText('Password change pending').length).toBeGreaterThan(0)
    expect(within(card).queryByLabelText('Temporary password')).toBeNull()
    expect(document.body.textContent).not.toContain(STRONG)
    expect(badgeRefresh).toHaveBeenCalledTimes(1)
    window.removeEventListener('psp:reset-requests-changed', badgeRefresh)

    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/reset-password'))
    expect(post?.[0]).toMatch(/\/api\/office\/staff\/p1\/reset-password$/)
    expect(post?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ temporaryPassword: STRONG })
  }, 15000)

  it('catches a weak password before sending anything', async () => {
    const fetchMock = stubReset(() => ok({ staff: person, resolvedRequests: 0 }))
    renderAt('/office/staff/p1')

    const card = await screen.findByRole('region', { name: 'Password' })
    fireEvent.click(within(card).getByRole('button', { name: 'Reset password' }))
    const input = within(card).getByLabelText('Temporary password')
    fireEvent.change(input, { target: { value: 'short' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Set temporary password' }))

    expect((await within(card).findByRole('alert')).textContent).toBe(
      'The temporary password does not meet the rules below.',
    )
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reset-password'))).toBe(false)
  })

  it('shows the server reasons and keeps what was typed', async () => {
    stubReset(() =>
      json(400, {
        success: false,
        error: {
          message: 'The temporary password does not meet the rules',
          code: 'WEAK_PASSWORD',
          details: ['Choose a less common password.'],
        },
      }),
    )
    renderAt('/office/staff/p1')

    const card = await screen.findByRole('region', { name: 'Password' })
    fireEvent.click(within(card).getByRole('button', { name: 'Reset password' }))
    const input = within(card).getByLabelText('Temporary password') as HTMLInputElement
    fireEvent.change(input, { target: { value: STRONG } })
    fireEvent.click(within(card).getByRole('button', { name: 'Set temporary password' }))

    const alert = await within(card).findByRole('alert')
    expect(alert.textContent).toContain('The temporary password does not meet the rules')
    expect(within(alert).getByText('Choose a less common password.')).not.toBeNull()
    expect(input.value).toBe(STRONG)
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('Cancel closes the form without sending anything', async () => {
    const fetchMock = stubReset(() => ok({ staff: person, resolvedRequests: 0 }))
    renderAt('/office/staff/p1')

    const card = await screen.findByRole('region', { name: 'Password' })
    fireEvent.click(within(card).getByRole('button', { name: 'Reset password' }))
    fireEvent.change(within(card).getByLabelText('Temporary password'), { target: { value: STRONG } })
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }))

    expect(within(card).queryByLabelText('Temporary password')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Reset password' })))
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reset-password'))).toBe(false)
  })

  it('on your own profile it points to Change password instead', async () => {
    stubApi(() => ok({ staff: { ...person, id: admin.id, fullName: admin.fullName, role: 'IT' } }))
    renderAt(`/office/staff/${admin.id}`)

    const card = await screen.findByRole('region', { name: 'Password' })
    expect(within(card).queryByRole('button')).toBeNull()
    expect(within(card).getByRole('link', { name: 'Change password' }).getAttribute('href')).toBe(
      '/office/auth/change-password',
    )
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

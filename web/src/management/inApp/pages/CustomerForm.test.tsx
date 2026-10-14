import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AddCustomer, { EditCustomer, type CustomerRecord } from './CustomerForm'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const stored: CustomerRecord = {
  id: 'c1',
  type: 'company',
  fullName: null,
  companyName: 'Bugando Medical Centre',
  tin: '123-456-789',
  contactPerson: 'Dr. Neema Kweka',
  phone: '+255712345678',
  email: 'procurement@bugando.test',
  notes: 'Pays by bank transfer.',
  addresses: [{ id: 'a1', label: 'Head office', area: 'Mwanza', address: 'Plot 1, Wurzburg Road', isDefault: true }],
  createdAt: '2026-10-02T08:00:00.000Z',
  updatedAt: '2026-10-02T08:00:00.000Z',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

type Call = { url: URL; method: string; body: unknown }

// Answers API calls with `handler`; every call is recorded with its parsed body.
function stubApi(handler: (call: Call) => Response) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = {
        url: new URL(url, 'http://localhost'),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(call)
      return handler(call)
    }),
  )
  return calls
}

const noDuplicates = () => json(200, { success: true, data: { matches: [] } })
const saves = (calls: Call[]) => calls.filter((call) => call.method !== 'GET')

// Shows where the form went after saving, and the notice it passed along.
function Landing() {
  const location = useLocation()
  return <p data-testid="landing">{`${location.pathname} ${(location.state as { notice?: string } | null)?.notice ?? ''}`}</p>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/office/customers" element={<Landing />} />
        <Route path="/office/customers/new" element={<AddCustomer />} />
        <Route path="/office/customers/:id" element={<Landing />} />
        <Route path="/office/customers/:id/edit" element={<EditCustomer />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AddCustomer', () => {
  it('shows company fields only when the type is company', () => {
    stubApi(noDuplicates)
    renderAt('/office/customers/new')

    expect(screen.getByRole('radio', { name: /Individual/ })).toHaveProperty('checked', true)
    expect(screen.getByLabelText('Full name')).not.toBeNull()
    expect(screen.queryByLabelText('Company name')).toBeNull()
    expect(screen.queryByLabelText(/TIN/)).toBeNull()
    expect(screen.queryByLabelText(/Contact person/)).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: /Company/ }))
    expect(screen.getByLabelText('Company name')).not.toBeNull()
    expect(screen.getByLabelText(/TIN/)).not.toBeNull()
    expect(screen.getByLabelText(/Contact person/)).not.toBeNull()
    expect(screen.queryByLabelText('Full name')).toBeNull()
  })

  it('shows field errors tied to the inputs and sends nothing when the form is invalid', async () => {
    const calls = stubApi(noDuplicates)
    renderAt('/office/customers/new')

    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(screen.getByRole('alert').textContent).toBe('Check the highlighted fields.')
    const name = screen.getByLabelText('Full name')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(name.getAttribute('aria-describedby') ?? '')
    expect(error?.textContent).toBe('Enter the full name (2 to 100 characters).')
    expect(screen.getByLabelText(/Phone/).getAttribute('aria-invalid')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(saves(calls)).toEqual([])
  })

  it('creates a company with an address and returns to the list with a notice', async () => {
    let release: (response: Response) => void = () => {}
    const calls = stubApi((call) => {
      if (call.method === 'POST') return new Promise<Response>((resolve) => (release = resolve)) as never
      return noDuplicates()
    })
    renderAt('/office/customers/new')

    fireEvent.click(screen.getByRole('radio', { name: /Company/ }))
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Kilimanjaro Clinic' } })
    fireEvent.change(screen.getByLabelText(/TIN/), { target: { value: '100-200-300' } })
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '0754 100 200' } })
    fireEvent.change(screen.getByLabelText('Customer notes'), { target: { value: 'Call first.' } })
    fireEvent.click(screen.getByRole('button', { name: /Add address/ }))
    fireEvent.change(screen.getByLabelText('Area or city'), { target: { value: 'Moshi' } })
    fireEvent.change(screen.getByLabelText('Street, plot or landmark'), { target: { value: 'Plot 4, Mawenzi Road' } })
    expect(screen.getByRole('radio', { name: 'Default address' })).toHaveProperty('checked', true)

    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }))
    const busy = await screen.findByRole('button', { name: /Saving/ })
    expect(busy).toHaveProperty('disabled', true)
    // A second submit while sending does nothing.
    fireEvent.submit(busy.closest('form') as HTMLFormElement)
    expect(saves(calls)).toHaveLength(1)

    expect(saves(calls)[0]).toMatchObject({
      method: 'POST',
      body: {
        type: 'company',
        companyName: 'Kilimanjaro Clinic',
        tin: '100-200-300',
        phone: '0754 100 200',
        notes: 'Call first.',
        addresses: [{ label: '', area: 'Moshi', address: 'Plot 4, Mawenzi Road', isDefault: true }],
      },
    })

    release(
      json(201, {
        success: true,
        data: { customer: { ...stored, id: 'c7', companyName: 'Kilimanjaro Clinic' } },
      }),
    )
    expect((await screen.findByTestId('landing')).textContent).toBe('/office/customers Kilimanjaro Clinic was added.')
  })

  it('warns about a duplicate phone with a link to the existing customer, but still saves', async () => {
    const calls = stubApi((call) => {
      if (call.url.pathname === '/api/office/customers/duplicates') {
        return json(200, {
          success: true,
          data: { matches: [{ ...stored, id: 'c9', type: 'individual', fullName: 'Asha Mushi', matchedOn: ['phone'] }] },
        })
      }
      return json(201, { success: true, data: { customer: { ...stored, type: 'individual', fullName: 'Asha M.' } } })
    })
    renderAt('/office/customers/new')

    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '0712 345 678' } })
    const link = await screen.findByRole('link', { name: /Asha Mushi/ })
    expect(link.getAttribute('href')).toBe('/office/customers/c9')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('A customer with these details exists')).not.toBeNull()
    expect(screen.getByText('same phone')).not.toBeNull()

    const check = calls.find((call) => call.url.pathname === '/api/office/customers/duplicates')
    expect(check?.url.searchParams.get('phone')).toBe('+255712345678')
    expect(check?.url.searchParams.has('exclude')).toBe(false)

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Asha M.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }))
    expect(await screen.findByTestId('landing')).not.toBeNull()
  })

  it('does not check duplicates for a phone that would be refused', async () => {
    const calls = stubApi(noDuplicates)
    renderAt('/office/customers/new')
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '0712' } })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(calls.filter((call) => call.url.pathname.endsWith('/duplicates'))).toEqual([])
  })

  it('shows server field errors and keeps what was typed', async () => {
    stubApi((call) =>
      call.method === 'POST'
        ? json(400, {
            success: false,
            error: {
              message: 'Check the highlighted fields.',
              code: 'VALIDATION_ERROR',
              details: { email: 'Enter a valid email address.', 'addresses.0.area': 'Enter the area or city (2 to 100 characters).' },
            },
          })
        : noDuplicates(),
    )
    renderAt('/office/customers/new')

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Juma Said' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'juma@mail.test' } })
    fireEvent.click(screen.getByRole('button', { name: /Add address/ }))
    fireEvent.change(screen.getByLabelText('Area or city'), { target: { value: 'Arusha' } })
    fireEvent.change(screen.getByLabelText('Street, plot or landmark'), { target: { value: 'Plot 9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByText('Enter a valid email address.')).not.toBeNull()
    expect(screen.getByText('Enter the area or city (2 to 100 characters).')).not.toBeNull()
    expect(screen.getByLabelText('Area or city').getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByLabelText('Full name') as HTMLInputElement).value).toBe('Juma Said')
    expect((screen.getByLabelText(/Email/) as HTMLInputElement).value).toBe('juma@mail.test')
    expect(screen.getByRole('button', { name: 'Save customer' })).toHaveProperty('disabled', false)
  })

  it('adds, removes and switches the default address', () => {
    stubApi(noDuplicates)
    renderAt('/office/customers/new')

    expect(screen.getByText('No addresses yet.')).not.toBeNull()
    const add = screen.getByRole('button', { name: /Add address/ })
    fireEvent.click(add)
    fireEvent.click(add)
    const defaults = () => screen.getAllByRole('radio', { name: 'Default address' }) as HTMLInputElement[]
    expect(defaults().map((radio) => radio.checked)).toEqual([true, false])

    fireEvent.click(defaults()[1])
    expect(defaults().map((radio) => radio.checked)).toEqual([false, true])

    // Removing the default makes the remaining one the default.
    fireEvent.click(screen.getByRole('button', { name: 'Remove address 2' }))
    expect(defaults().map((radio) => radio.checked)).toEqual([true])
  })
})

describe('EditCustomer', () => {
  it('loads the stored customer, saves with PATCH and goes back to the detail page', async () => {
    let current = stored
    const calls = stubApi((call) => {
      if (call.url.pathname.endsWith('/duplicates')) return noDuplicates()
      if (call.method === 'PATCH') {
        current = { ...stored, contactPerson: 'Dr. Juma' }
        return json(200, { success: true, data: { customer: current } })
      }
      return json(200, { success: true, data: { customer: current } })
    })
    renderAt('/office/customers/c1/edit')

    expect(screen.getByLabelText('Loading customer')).not.toBeNull()
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Bugando Medical Centre')
    expect(screen.getByRole('radio', { name: /Company/ })).toHaveProperty('checked', true)
    expect((screen.getByLabelText(/Phone/) as HTMLInputElement).value).toBe('+255 712 345 678')
    expect((screen.getByLabelText('Customer notes') as HTMLInputElement).value).toBe('Pays by bank transfer.')
    expect(screen.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe('/office/customers/c1')
    expect((screen.getByLabelText(/Label/) as HTMLInputElement).value).toBe('Head office')

    // The duplicate check leaves out the customer being edited.
    await waitFor(() => expect(calls.some((call) => call.url.pathname.endsWith('/duplicates'))).toBe(true))
    expect(calls.find((call) => call.url.pathname.endsWith('/duplicates'))?.url.searchParams.get('exclude')).toBe('c1')

    fireEvent.change(screen.getByLabelText(/Contact person/), { target: { value: 'Dr. Juma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect((await screen.findByTestId('landing')).textContent).toBe('/office/customers/c1 Changes saved.')
    const patch = saves(calls)[0]
    expect(patch.url.pathname).toBe('/api/office/customers/c1')
    expect(patch.body).toMatchObject({ type: 'company', contactPerson: 'Dr. Juma', companyName: 'Bugando Medical Centre' })
  })

  it('shows a missing customer with Try again and a way back', async () => {
    let attempts = 0
    stubApi(() => {
      attempts += 1
      return attempts === 1
        ? json(404, { success: false, error: { message: 'Not found' } })
        : json(200, { success: true, data: { customer: stored } })
    })
    renderAt('/office/customers/nope/edit')

    expect((await screen.findByRole('alert')).textContent).toBe('This customer does not exist.')
    expect(screen.getByRole('link', { name: 'Back to customers' }).getAttribute('href')).toBe('/office/customers')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Bugando Medical Centre' })).not.toBeNull()
    expect(within(document.body).queryByText('This customer does not exist.')).toBeNull()
  })
})

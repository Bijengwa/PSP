import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CustomerDetail from './CustomerDetail'
import type { CustomerRecord } from './CustomerForm'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const company: CustomerRecord = {
  id: 'c1',
  type: 'company',
  fullName: null,
  companyName: 'Bugando Medical Centre',
  tin: '123-456-789',
  contactPerson: 'Dr. Neema Kweka',
  phone: '+255712345678',
  email: 'procurement@bugando.test',
  notes: 'Pays by bank transfer.\nCall before delivery.',
  addresses: [
    { id: 'a1', label: 'Head office', area: 'Mwanza', address: 'Plot 1, Wurzburg Road', isDefault: true },
    { id: 'a2', label: '', area: 'Nyamagana, Mwanza', address: 'Medical stores, Block C', isDefault: false },
  ],
  createdAt: '2026-10-02T08:00:00.000Z',
  updatedAt: '2026-10-03T08:00:00.000Z',
}

const individual: CustomerRecord = {
  ...company,
  id: 'c2',
  type: 'individual',
  fullName: 'Juma Said',
  companyName: null,
  tin: null,
  contactPerson: null,
  phone: null,
  email: null,
  notes: '',
  addresses: [],
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

// Answers every API call with `handler`; returns the requested paths.
function stubApi(handler: () => Response) {
  const paths: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      paths.push(new URL(url, 'http://localhost').pathname)
      return handler()
    }),
  )
  return paths
}

const found = (customer: CustomerRecord) => () => json(200, { success: true, data: { customer } })

function renderAt(path: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route path="/office/customers/:id" element={<CustomerDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CustomerDetail', () => {
  it('shows a company with its contacts, addresses, notes and an empty Orders section', async () => {
    const paths = stubApi(found(company))
    renderAt('/office/customers/c1')

    expect(screen.getByLabelText('Loading customer')).not.toBeNull()
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Bugando Medical Centre')
    expect(paths).toEqual(['/api/office/customers/c1'])
    expect(screen.getByText('Company')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Customers' }).getAttribute('href')).toBe('/office/customers')
    expect(screen.getByRole('link', { name: 'Edit customer' }).getAttribute('href')).toBe('/office/customers/c1/edit')

    const contact = screen.getByRole('region', { name: 'Contact' })
    expect(within(contact).getByRole('link', { name: '+255 712 345 678' }).getAttribute('href')).toBe('tel:+255712345678')
    expect(within(contact).getByRole('link', { name: 'procurement@bugando.test' }).getAttribute('href')).toBe(
      'mailto:procurement@bugando.test',
    )
    expect(within(contact).getByText('Dr. Neema Kweka')).not.toBeNull()
    expect(within(contact).getByText('123-456-789')).not.toBeNull()

    // Default first, with its badge; an address without a label is titled by its area.
    const items = within(screen.getByRole('region', { name: 'Addresses' })).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByText('Head office')).not.toBeNull()
    expect(within(items[0]).getByText('Default')).not.toBeNull()
    expect(within(items[0]).getByText('Mwanza')).not.toBeNull()
    expect(within(items[1]).getByText('Nyamagana, Mwanza')).not.toBeNull()
    expect(within(items[1]).queryByText('Default')).toBeNull()

    expect(screen.getByRole('region', { name: 'Notes' }).textContent).toContain('Pays by bank transfer.\nCall before delivery.')
    expect(within(screen.getByRole('region', { name: 'Orders' })).getByText(/will be listed here/)).not.toBeNull()
  })

  it('shows an individual with nothing filled in', async () => {
    stubApi(found(individual))
    renderAt('/office/customers/c2')

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Juma Said')
    expect(screen.getByText('Individual')).not.toBeNull()
    const contact = screen.getByRole('region', { name: 'Contact' })
    expect(within(contact).getAllByText('Not set')).toHaveLength(2)
    expect(within(contact).queryByText('TIN')).toBeNull()
    expect(within(contact).queryByText('Contact person')).toBeNull()

    const addresses = screen.getByRole('region', { name: 'Addresses' })
    expect(within(addresses).getByText(/No addresses yet/)).not.toBeNull()
    expect(within(addresses).getByRole('link', { name: 'Add one' }).getAttribute('href')).toBe('/office/customers/c2/edit')
    expect(within(screen.getByRole('region', { name: 'Notes' })).getByText('No notes.')).not.toBeNull()
  })

  it('shows the notice from the edit form and lets it be dismissed', async () => {
    stubApi(found(company))
    renderAt('/office/customers/c1', { notice: 'Changes saved.' })

    expect((await screen.findByRole('status')).textContent).toBe('Changes saved.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
    expect(screen.queryByText('Changes saved.')).toBeNull()
  })

  it('shows a missing customer with a way back', async () => {
    stubApi(() => json(404, { success: false, error: { message: 'Not found' } }))
    renderAt('/office/customers/nope')

    expect(await screen.findByRole('heading', { name: 'Customer not found' })).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to customers' }).getAttribute('href')).toBe('/office/customers')
  })

  it('shows an error with Try again', async () => {
    let attempts = 0
    stubApi(() => {
      attempts += 1
      return attempts === 1
        ? json(503, { success: false, error: { message: 'Unavailable' } })
        : json(200, { success: true, data: { customer: company } })
    })
    renderAt('/office/customers/c1')

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The service is temporarily unavailable. Please try again shortly.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Bugando Medical Centre' })).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'

beforeEach(() => vi.stubGlobal('scrollTo', () => {})) // jsdom has no scrolling

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )

describe('shop 404 and page changes', () => {
  it('shows an unknown public address as the shop 404, inside the shop layout', async () => {
    renderAt('/no-such-page')

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy()
    await waitFor(() => expect(document.title).toBe('Page not found | PSP Engineering Group'))
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main')
    expect(screen.getByRole('banner')).toBeTruthy()
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('contentinfo')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Browse products' }).getAttribute('href')).toBe('/products')
  })

  it('moves focus to the main content after going to another page', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))) // the catalogue stays loading
    renderAt('/no-such-page')

    const link = await screen.findByRole('link', { name: 'Browse products' })
    link.focus()
    fireEvent.click(link)

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('main')))
  })
})

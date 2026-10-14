import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'

beforeEach(() => vi.stubGlobal('scrollTo', () => {})) // jsdom has no scrolling

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The whole app loads its lazy pages first, which can take more than the default
// second when the full suite runs in parallel.
const LAZY_LOAD = { timeout: 5000 }

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )

describe('shop 404 and page changes', () => {
  it('shows an unknown public address as the shop 404, inside the shop layout', async () => {
    renderAt('/no-such-page')

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' }, LAZY_LOAD)).toBeTruthy()
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

    const link = await screen.findByRole('link', { name: 'Browse products' }, LAZY_LOAD)
    link.focus()
    fireEvent.click(link)

    // The products page is another lazy chunk.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('main')), LAZY_LOAD)
  })
})

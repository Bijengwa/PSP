import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest, onSessionProblem, sessionProblem, type SessionProblem } from './client'

function reply(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

function failure(code?: string) {
  return { success: false, error: { message: 'nope', code } }
}

// Calls /api/x with the given fetch result and returns every session problem
// the client reported while doing it.
async function problemsFor(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock)
  const seen: SessionProblem[] = []
  const stop = onSessionProblem((problem) => seen.push(problem))
  try {
    await apiRequest('/api/x')
  } finally {
    stop()
  }
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sessionProblem', () => {
  it('maps 401, 403 PASSWORD_CHANGE_REQUIRED and 503', () => {
    expect(sessionProblem(401)).toBe('unauthenticated')
    expect(sessionProblem(403, 'PASSWORD_CHANGE_REQUIRED')).toBe('password-change-required')
    expect(sessionProblem(503)).toBe('unavailable')
  })

  it('ignores everything else', () => {
    expect(sessionProblem(200)).toBeNull()
    expect(sessionProblem(400)).toBeNull()
    expect(sessionProblem(403)).toBeNull()
    expect(sessionProblem(403, 'FORBIDDEN')).toBeNull()
    expect(sessionProblem(404)).toBeNull()
    expect(sessionProblem(429)).toBeNull()
    expect(sessionProblem(500)).toBeNull()
    expect(sessionProblem(0)).toBeNull()
  })
})

describe('apiRequest session reporting', () => {
  it('reports a 401 as unauthenticated', async () => {
    expect(await problemsFor(reply(401, failure('UNAUTHENTICATED')))).toEqual(['unauthenticated'])
  })

  it('reports 403 PASSWORD_CHANGE_REQUIRED', async () => {
    expect(await problemsFor(reply(403, failure('PASSWORD_CHANGE_REQUIRED')))).toEqual(['password-change-required'])
  })

  it('reports a 503 as unavailable', async () => {
    expect(await problemsFor(reply(503, failure('SERVICE_UNAVAILABLE')))).toEqual(['unavailable'])
  })

  it('does not report any other 403', async () => {
    expect(await problemsFor(reply(403, failure('FORBIDDEN')))).toEqual([])
  })

  it('does not report a 400', async () => {
    expect(await problemsFor(reply(400, failure('VALIDATION_ERROR')))).toEqual([])
  })

  it('does not report a success', async () => {
    expect(await problemsFor(reply(200, { success: true, data: { ok: 1 } }))).toEqual([])
  })

  it('does not report a network error, and answers with status 0', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const seen: SessionProblem[] = []
    const stop = onSessionProblem((problem) => seen.push(problem))
    const result = await apiRequest('/api/x')
    stop()
    expect(seen).toEqual([])
    expect(result).toMatchObject({ ok: false, status: 0 })
  })

  it('stops reporting once the listener is removed', async () => {
    const fetchMock = reply(401, failure())
    vi.stubGlobal('fetch', fetchMock)
    const listener = vi.fn()
    const stop = onSessionProblem(listener)
    stop()
    await apiRequest('/api/x')
    expect(listener).not.toHaveBeenCalled()
  })
})

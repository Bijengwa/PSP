// The one place the app talks to the PSP API. Every request sends cookies
// (credentials: 'include') because the staff session lives in an httpOnly
// cookie; the session ID is never visible to, or stored by, this code.
const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; code?: string; details?: unknown }

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

type ApiPayload = {
  success?: boolean
  data?: unknown
  error?: { message?: string; code?: string; details?: unknown }
}

// What a refused request says about the staff session. The auth provider
// listens here, so from any call a 401 sends the person to login, a 403
// PASSWORD_CHANGE_REQUIRED to the change-password page, and a 503 to the
// "Service temporarily unavailable" screen.
export type SessionProblem = 'unauthenticated' | 'password-change-required' | 'unavailable'

export function sessionProblem(status: number, code?: string): SessionProblem | null {
  if (status === 401) return 'unauthenticated'
  if (status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') return 'password-change-required'
  if (status === 503) return 'unavailable'
  return null
}

let sessionProblemListener: ((problem: SessionProblem) => void) | null = null

export function onSessionProblem(listener: (problem: SessionProblem) => void) {
  sessionProblemListener = listener
  return () => {
    if (sessionProblemListener === listener) sessionProblemListener = null
  }
}

// Resolves to a result for every HTTP outcome, so callers branch on `ok`
// instead of catching. `status` is 0 when the server could not be reached.
// Only an aborted request rejects.
export async function apiRequest<T>(path: string, { method = 'GET', body, signal }: RequestOptions = {}): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    return { ok: false, status: 0, message: 'Cannot reach the server. Check your connection and try again.' }
  }

  const payload = (await response.json().catch(() => null)) as ApiPayload | null
  if (response.ok && payload?.success) {
    return { ok: true, data: payload.data as T }
  }
  const problem = sessionProblem(response.status, payload?.error?.code)
  if (problem) sessionProblemListener?.(problem)
  return {
    ok: false,
    status: response.status,
    message: payload?.error?.message ?? 'Something went wrong. Please try again.',
    code: payload?.error?.code,
    details: payload?.error?.details,
  }
}

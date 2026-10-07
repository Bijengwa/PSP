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

// The auth provider listens here, so a 403 PASSWORD_CHANGE_REQUIRED from any
// call sends the person to the change-password page.
let passwordChangeRequiredListener: (() => void) | null = null

export function onPasswordChangeRequired(listener: () => void) {
  passwordChangeRequiredListener = listener
  return () => {
    if (passwordChangeRequiredListener === listener) passwordChangeRequiredListener = null
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
  if (response.status === 403 && payload?.error?.code === 'PASSWORD_CHANGE_REQUIRED') {
    passwordChangeRequiredListener?.()
  }
  return {
    ok: false,
    status: response.status,
    message: payload?.error?.message ?? 'Something went wrong. Please try again.',
    code: payload?.error?.code,
    details: payload?.error?.details,
  }
}

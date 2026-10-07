import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiRequest, onPasswordChangeRequired, type ApiResult } from '../../api/client'

export const LOGIN_PATH = '/office/auth/login'
export const OFFICE_HOME_PATH = '/office'
export const CHANGE_PASSWORD_PATH = '/office/auth/change-password'
export const FORGOT_PASSWORD_PATH = '/office/auth/forgot-password'

export type Staff = {
  id: string
  fullName: string
  email: string
  role: string
  mustChangePassword: boolean
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'authenticated'; staff: Staff }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }

type AuthContextValue = {
  state: AuthState
  login: (email: string, password: string) => Promise<ApiResult<{ staff: Staff }>>
  logout: () => Promise<ApiResult<null>>
  changePassword: (currentPassword: string, newPassword: string) => Promise<ApiResult<{ staff: Staff }>>
  retry: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Who is logged in, as the API reports it. The backend is the only source of
// truth: this state is loaded from /api/auth/me and nothing is kept in storage.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ staff: Staff }>('/api/auth/me', { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setState({ status: 'authenticated', staff: result.data.staff })
        else if (result.status === 401) setState({ status: 'unauthenticated' })
        else setState({ status: 'error', message: result.message })
      },
      () => {}, // aborted on unmount
    )
    return () => controller.abort()
  }, [attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiRequest<{ staff: Staff }>('/api/auth/login', { method: 'POST', body: { email, password } })
    if (result.ok) setState({ status: 'authenticated', staff: result.data.staff })
    return result
  }, [])

  const logout = useCallback(async () => {
    const result = await apiRequest<null>('/api/auth/logout', { method: 'POST' })
    if (result.ok) setState({ status: 'unauthenticated' })
    return result
  }, [])

  // The server cleared the flag and issued a fresh session cookie.
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const result = await apiRequest<{ staff: Staff }>('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    })
    if (result.ok) setState({ status: 'authenticated', staff: result.data.staff })
    return result
  }, [])

  // Any API call refused with PASSWORD_CHANGE_REQUIRED flags the person, and the
  // guard then keeps them on the change-password page.
  useEffect(
    () =>
      onPasswordChangeRequired(() =>
        setState((current) =>
          current.status === 'authenticated' ? { ...current, staff: { ...current.staff, mustChangePassword: true } } : current,
        ),
      ),
    [],
  )

  const value = useMemo(
    () => ({ state, login, logout, changePassword, retry }),
    [state, login, logout, changePassword, retry],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}

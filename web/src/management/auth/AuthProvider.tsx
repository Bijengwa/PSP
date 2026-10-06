import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiRequest, type ApiResult } from '../../api/client'

export const LOGIN_PATH = '/office/auth/login'
export const OFFICE_HOME_PATH = '/office'

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

  const value = useMemo(() => ({ state, login, logout, retry }), [state, login, logout, retry])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}

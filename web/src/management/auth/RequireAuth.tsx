import { Navigate, Outlet, useLocation } from 'react-router'
import { LOGIN_PATH, useAuth } from './AuthProvider'

// Guards every office route below it. Not logged in: off to the login page,
// remembering where the person was going.
export default function RequireAuth() {
  const { state, retry } = useAuth()
  const location = useLocation()

  if (state.status === 'loading') {
    return <p className="page-message">Checking your session…</p>
  }
  if (state.status === 'error') {
    return (
      <div className="page-message" role="alert">
        <p>{state.message}</p>
        <button type="button" className="button button-secondary" onClick={retry}>
          Try again
        </button>
      </div>
    )
  }
  if (state.status === 'unauthenticated') {
    return <Navigate to={LOGIN_PATH} replace state={{ from: location.pathname + location.search }} />
  }
  return <Outlet />
}

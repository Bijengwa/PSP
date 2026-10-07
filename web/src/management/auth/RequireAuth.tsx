import { Navigate, Outlet, useLocation } from 'react-router'
import { CHANGE_PASSWORD_PATH, LOGIN_PATH, useAuth } from './AuthProvider'

// Guards every office route below it. Not logged in: off to the login page,
// remembering where the person was going. Still on a temporary password: the
// change-password page is the only place they can be.
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
  if (state.staff.mustChangePassword && location.pathname.replace(/\/+$/, '') !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />
  }
  return <Outlet />
}

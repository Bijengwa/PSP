import { lazy, Suspense } from 'react'
import { Link, Outlet, Route, Routes } from 'react-router'
import { AuthProvider } from './management/auth/AuthProvider'
import RequireAuth from './management/auth/RequireAuth'

// The office is its own bundle: shop visitors never download it.
const Login = lazy(() => import('./management/auth/login'))
const OfficeLayout = lazy(() => import('./management/inApp/dashboard'))
const OfficeHome = lazy(() => import('./management/inApp/dashboard').then((m) => ({ default: m.OfficeHome })))

// Everything under /office shares one auth state. Shop routes stay outside it,
// so the public side never calls the auth API.
function OfficeRoot() {
  return (
    <AuthProvider>
      <Suspense fallback={<p className="page-message">Loading…</p>}>
        <Outlet />
      </Suspense>
    </AuthProvider>
  )
}

// Placeholder until the public shop is built.
function ShopHome() {
  return (
    <main className="page-message">
      <h1>PSP Engineering Group</h1>
      <p>Medical equipment · Tanzania</p>
    </main>
  )
}

function NotFound() {
  return (
    <main className="page-message">
      <h1>Page not found</h1>
      <p>The page you are looking for does not exist.</p>
      <Link to="/">Go to the home page</Link>
    </main>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ShopHome />} />

      <Route path="/office" element={<OfficeRoot />}>
        <Route path="auth/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route element={<OfficeLayout />}>
            <Route index element={<OfficeHome />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

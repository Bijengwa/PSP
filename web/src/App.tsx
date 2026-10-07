import { lazy, Suspense } from 'react'
import { Link, Outlet, Route, Routes } from 'react-router'
import { AuthProvider } from './management/auth/AuthProvider'
import RequireAuth from './management/auth/RequireAuth'

// The office is its own bundle: shop visitors never download it.
const Login = lazy(() => import('./management/auth/login'))
const ForgotPassword = lazy(() => import('./management/auth/login').then((m) => ({ default: m.ForgotPassword })))
const ChangePassword = lazy(() => import('./management/auth/login').then((m) => ({ default: m.ChangePassword })))
const OfficeLayout = lazy(() => import('./management/inApp/layout/OfficeLayout'))
const OfficeHome = lazy(() => import('./management/inApp/pages/OfficeHome'))
const SettingsPage = lazy(() => import('./management/inApp/pages/OfficeHome').then((m) => ({ default: m.SettingsPage })))
const PlaceholderPage = lazy(() => import('./management/inApp/pages/PlaceholderPage'))
const OfficeNotFound = lazy(() => import('./management/inApp/pages/OfficeNotFound'))

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
        <Route path="auth/forgot-password" element={<ForgotPassword />} />
        <Route element={<RequireAuth />}>
          {/* Outside the shell: during a forced change it is the only reachable page. */}
          <Route path="auth/change-password" element={<ChangePassword />} />
          <Route element={<OfficeLayout />}>
            <Route index element={<OfficeHome />} />
            {/* Sidebar routes: title-only placeholders until each module is built. */}
            <Route path="products" element={<PlaceholderPage title="Products" />} />
            <Route path="products/new" element={<PlaceholderPage title="Add Product" />} />
            <Route path="inventory" element={<PlaceholderPage title="Inventory" />} />
            <Route path="orders" element={<PlaceholderPage title="Orders" />} />
            <Route path="customers" element={<PlaceholderPage title="Customers" />} />
            <Route path="staff" element={<PlaceholderPage title="Staff" />} />
            <Route path="reports" element={<PlaceholderPage title="Reports" />} />
            <Route path="notifications" element={<PlaceholderPage title="Notifications" />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<OfficeNotFound />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

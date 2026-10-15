import { lazy, Suspense } from 'react'
import { Outlet, Route, Routes } from 'react-router'
import { AuthProvider } from './management/auth/AuthProvider'
import RequireAuth from './management/auth/RequireAuth'

// The office is its own bundle: shop visitors never download it.
const Login = lazy(() => import('./management/auth/login'))
const ForgotPassword = lazy(() => import('./management/auth/login').then((m) => ({ default: m.ForgotPassword })))
const ChangePassword = lazy(() => import('./management/auth/login').then((m) => ({ default: m.ChangePassword })))
const OfficeLayout = lazy(() => import('./management/inApp/layout/OfficeLayout'))
const OfficeHome = lazy(() => import('./management/inApp/pages/OfficeHome'))
const SettingsPage = lazy(() => import('./management/inApp/pages/OfficeHome').then((m) => ({ default: m.SettingsPage })))
const ResetRequestsPage = lazy(() =>
  import('./management/inApp/pages/OfficeHome').then((m) => ({ default: m.ResetRequestsPage })),
)
const RegisterStaff = lazy(() => import('./management/inApp/pages/RegisterStaff'))
const StaffList = lazy(() => import('./management/inApp/pages/StaffList'))
const StaffProfile = lazy(() => import('./management/inApp/pages/StaffProfile'))
const MyProfile = lazy(() => import('./management/inApp/pages/StaffProfile').then((m) => ({ default: m.MyProfile })))
const AddProduct = lazy(() => import('./management/inApp/pages/ProductForm'))
const EditProduct = lazy(() => import('./management/inApp/pages/ProductForm').then((m) => ({ default: m.EditProduct })))
const ProductsList = lazy(() => import('./management/inApp/pages/ProductsList'))
const CustomersList = lazy(() => import('./management/inApp/pages/CustomersList'))
const AddCustomer = lazy(() => import('./management/inApp/pages/CustomerForm'))
const EditCustomer = lazy(() =>
  import('./management/inApp/pages/CustomerForm').then((m) => ({ default: m.EditCustomer })),
)
const CustomerDetail = lazy(() => import('./management/inApp/pages/CustomerDetail'))
const OrdersList = lazy(() => import('./management/inApp/pages/OrdersList'))
const OrderDetail = lazy(() => import('./management/inApp/pages/OrderDetail'))
const OrderNew = lazy(() => import('./management/inApp/pages/OrderNew'))
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

// The shop is its own bundle too; the office never loads it.
const ShopLayout = lazy(() => import('./shop/ShopLayout'))
const ShopHome = lazy(() => import('./shop/ShopHome'))
const Catalog = lazy(() => import('./shop/Catalog'))
const ProductPage = lazy(() => import('./shop/ProductPage'))
const CartPage = lazy(() => import('./shop/CartPage'))
const CheckoutPage = lazy(() => import('./shop/CheckoutPage'))
const OrderConfirmed = lazy(() => import('./shop/CheckoutPage').then((m) => ({ default: m.OrderConfirmed })))
const ShopNotFound = lazy(() => import('./shop/NotFoundPage'))

export default function App() {
  return (
    <Routes>
      <Route
        element={
          <Suspense fallback={<p className="page-message">Loading…</p>}>
            <ShopLayout />
          </Suspense>
        }
      >
        <Route path="/" element={<ShopHome />} />
        <Route path="/products" element={<Catalog />} />
        <Route path="/products/:slug" element={<ProductPage />} />
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/order-confirmed" element={<OrderConfirmed />} />
        {/* Every other public address: the shop 404, inside the shop layout. */}
        <Route path="*" element={<ShopNotFound />} />
      </Route>

      <Route path="/office" element={<OfficeRoot />}>
        <Route path="auth/login" element={<Login />} />
        <Route path="auth/forgot-password" element={<ForgotPassword />} />
        <Route element={<RequireAuth />}>
          {/* Outside the shell: during a forced change it is the only reachable page. */}
          <Route path="auth/change-password" element={<ChangePassword />} />
          <Route element={<OfficeLayout />}>
            <Route index element={<OfficeHome />} />
            {/* Sidebar routes: title-only placeholders until each module is built. */}
            <Route path="products" element={<ProductsList />} />
            <Route path="products/new" element={<AddProduct />} />
            <Route path="products/:id" element={<EditProduct />} />
            <Route path="inventory" element={<PlaceholderPage title="Inventory" />} />
            <Route path="orders" element={<OrdersList />} />
            <Route path="orders/new" element={<OrderNew />} />
            <Route path="orders/:id" element={<OrderDetail />} />
            <Route path="customers" element={<CustomersList />} />
            <Route path="customers/new" element={<AddCustomer />} />
            <Route path="customers/:id" element={<CustomerDetail />} />
            <Route path="customers/:id/edit" element={<EditCustomer />} />
            <Route path="staff" element={<StaffList />} />
            <Route path="staff/new" element={<RegisterStaff />} />
            <Route path="staff/:id" element={<StaffProfile />} />
            <Route path="profile" element={<MyProfile />} />
            <Route path="reset-requests" element={<ResetRequestsPage />} />
            <Route path="reports" element={<PlaceholderPage title="Reports" />} />
            <Route path="notifications" element={<PlaceholderPage title="Notifications" />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<OfficeNotFound />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  )
}

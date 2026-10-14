// Responsive check: builds the app, serves it with `vite preview`, opens each route in the
// installed Edge (else Chrome) at 360, 768 and 1280px in light and dark, fails when a page
// scrolls sideways, and saves screenshots to docs/screenshots/.
// API calls are answered with fixtures, so no database or Redis is needed.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = path.resolve(webDir, '..', 'docs', 'screenshots')
const PORT = 4173
const ORIGIN = `http://127.0.0.1:${PORT}`

// `ready` is an element that shows only once the page has its data.
const ROUTES = [
  { name: 'office-products', path: '/office/products', ready: '.office-product-head' },
  { name: 'office-products-new', path: '/office/products/new', ready: '.office-product-head' },
  { name: 'office-products-edit', path: '/office/products/p1', ready: '.office-product-head' },
  { name: 'office-staff', path: '/office/staff', ready: '.office-staff-paging' },
  {
    name: 'office-staff-reset',
    path: '/office/staff',
    ready: '.password-rule.is-met',
    act: async (page) => {
      await page.getByRole('button', { name: 'Reset password' }).first().click()
      await page.getByLabel('Temporary password').fill('harbour7')
    },
  },
  { name: 'office-staff-new', path: '/office/staff/new', ready: '.office-register-form' },
  {
    name: 'office-staff-new-errors',
    path: '/office/staff/new',
    ready: '.office-register-form .field-error',
    act: async (page) => {
      await page.getByLabel('Email').fill('not-an-email')
      await page.getByLabel('Temporary password').fill('harbour7')
      await page.getByRole('button', { name: 'Register staff' }).click()
    },
  },
  { name: 'office-staff-profile', path: '/office/staff/st1', ready: '.office-profile-head' },
  {
    name: 'office-staff-profile-edit',
    path: '/office/staff/st1',
    ready: '.office-profile-form .field-error',
    act: async (page) => {
      await page.getByRole('button', { name: 'Edit' }).click()
      await page.getByLabel('Full name').fill('')
      await page.getByRole('button', { name: 'Save changes' }).click()
    },
  },
  {
    name: 'office-staff-profile-deactivate',
    path: '/office/staff/st1',
    ready: '.office-confirm',
    act: async (page) => {
      await page.getByRole('button', { name: 'Deactivate', exact: true }).click()
      await page.locator('.office-confirm').scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'office-staff-profile-role',
    path: '/office/staff/st1',
    ready: '.office-role-option',
    act: async (page) => {
      await page.getByRole('button', { name: 'Change role' }).click()
      await page.getByRole('radio', { name: /Admin/ }).check()
      await page.locator('.office-role-form').scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'office-staff-profile-password',
    path: '/office/staff/st1',
    ready: '.password-rule.is-met',
    act: async (page) => {
      await page.getByRole('button', { name: 'Reset password' }).click()
      await page.getByLabel('Temporary password').fill('harbour7')
      await page.getByLabel('Temporary password').scrollIntoViewIfNeeded()
    },
  },
  // st2 is answered as an inactive account.
  { name: 'office-staff-profile-inactive', path: '/office/staff/st2', ready: '.office-profile-head' },
  { name: 'office-my-profile', path: '/office/profile', ready: '.office-profile-head' },
  { name: 'office-customers', path: '/office/customers', ready: '.office-list-footer' },
  {
    name: 'office-customers-empty',
    path: '/office/customers',
    ready: '.office-customer-empty',
    act: async (page) => {
      await page.locator('.office-list-footer').waitFor()
      await page.getByLabel('Search by name, company, phone or email').fill('no-such-customer-with-a-long-search')
    },
  },
  { name: 'office-customer-new', path: '/office/customers/new', ready: '.office-role-option' },
  {
    // Company fields, a duplicate phone warning and field errors on a failed save.
    name: 'office-customer-new-checks',
    path: '/office/customers/new',
    ready: '.office-duplicate',
    act: async (page) => {
      await page.getByRole('radio', { name: /Company/ }).check()
      await page.getByLabel(/Phone/).fill('0712 345 678')
      await page.getByLabel(/TIN/).fill('TIN-ABC')
      await page.getByRole('button', { name: /Add address/ }).click()
      await page.getByLabel('Area or city').fill('M')
      await page.getByRole('button', { name: 'Save customer' }).click()
      await page.locator('.office-duplicate').waitFor()
      await page.evaluate(() => window.scrollTo(0, 0))
    },
  },
  { name: 'office-customer-edit', path: '/office/customers/c2/edit', ready: '.office-address' },
  { name: 'office-customer-detail', path: '/office/customers/c2', ready: '.office-customer-address' },
  // c3 is answered with no contacts, addresses or notes.
  { name: 'office-customer-detail-empty', path: '/office/customers/c3', ready: '.office-profile-head' },
  { name: 'office-orders', path: '/office/orders', ready: '.office-list-footer' },
  {
    name: 'office-orders-empty',
    path: '/office/orders',
    ready: '.office-customer-empty',
    act: async (page) => {
      await page.locator('.office-list-footer').waitFor()
      await page.getByLabel('Source').selectOption('staff')
      await page.getByLabel('Search by order number, name or phone').fill('no-such-order-with-a-long-search')
    },
  },
  // o2: a new order with a very long name, a large total and a quotation line.
  { name: 'office-order-detail', path: '/office/orders/o2', ready: '.office-order-items' },
  {
    name: 'office-order-edit-items',
    path: '/office/orders/o2',
    ready: '.office-order-items.is-editing',
    act: async (page) => {
      await page.locator('.office-order-items').waitFor()
      await page.getByRole('button', { name: /Edit items/ }).click()
      await page.getByRole('button', { name: /^More / }).first().click()
    },
  },
  {
    // The cancel question with its reason field, after trying without a reason.
    name: 'office-order-cancel',
    path: '/office/orders/o2',
    ready: '.office-order-confirm .field-error',
    act: async (page) => {
      await page.locator('.office-order-items').waitFor()
      await page.getByRole('button', { name: 'Cancel order' }).click()
      await page.locator('.office-order-confirm').getByRole('button', { name: 'Cancel order' }).click()
    },
  },
  // o6: cancelled with a reason, linked to a customer, entered by staff.
  { name: 'office-order-cancelled', path: '/office/orders/o6', ready: '.office-order-steps' },
  { name: 'shop-home', path: '/', ready: '.shop-category-count' },
  { name: 'shop-products', path: '/products', ready: '.shop-card:not(.shop-card-skeleton)' },
  { name: 'shop-products-filtered', path: '/products?category=imaging&page=2', ready: '.shop-pager' },
  { name: 'shop-products-empty', path: '/products?q=no-such-thing', ready: '.shop-state' },
  { name: 'shop-product', path: '/products/shop-product-0', ready: '.shop-product-info h1' },
  { name: 'shop-product-out', path: '/products/shop-product-1', ready: '.shop-product-info h1' },
  { name: 'shop-product-missing', path: '/products/no-such-product', ready: '.shop-product-state' },
  // `cart` is put in localStorage before the page loads.
  {
    name: 'shop-cart',
    path: '/cart',
    ready: '.shop-cart-line .shop-cart-line-name',
    cart: [
      { productId: 's1', quantity: 2 }, // long name, out of stock
      { productId: 's0', quantity: 1 },
      { productId: 's2', quantity: 1 }, // price on request
      { productId: 's11', quantity: 99 }, // the biggest line total
      { productId: 'gone', quantity: 1 }, // no longer in the catalogue
    ],
  },
  {
    name: 'shop-cart-ready',
    path: '/cart',
    ready: '.shop-cart-line .shop-cart-line-name',
    cart: [
      { productId: 's8', quantity: 3 },
      { productId: 's4', quantity: 1 },
    ],
  },
  { name: 'shop-cart-empty', path: '/cart', ready: '.shop-state', cart: [] },
  // `act` runs after the page loads, before waiting for `ready`.
  {
    name: 'shop-checkout',
    path: '/checkout',
    ready: '.shop-checkout-form',
    cart: [
      { productId: 's0', quantity: 2 },
      { productId: 's4', quantity: 1 }, // no photo
      { productId: 's2', quantity: 1 }, // price on request
      { productId: 's11', quantity: 99 }, // the biggest line total
    ],
  },
  {
    name: 'shop-checkout-errors',
    path: '/checkout',
    ready: '.shop-field-message:not(:empty)',
    cart: [{ productId: 's8', quantity: 3 }],
    act: async (page) => {
      await page.locator('.shop-checkout-form').waitFor()
      const toggle = page.locator('.shop-checkout-toggle')
      if (await toggle.count()) await toggle.click() // the summary, opened on smaller screens
      await page.getByLabel('Phone number').fill('12345')
      await page.getByRole('button', { name: /Place order/ }).click()
      await page.evaluate(() => window.scrollTo(0, 0)) // the full-page shot starts at the top
    },
  },
  {
    name: 'shop-order-confirmed',
    path: '/checkout',
    ready: '.shop-confirm-number-value',
    print: true, // also saved as printed (at 768px), in both themes
    cart: [
      { productId: 's8', quantity: 3 },
      { productId: 's2', quantity: 1 },
    ],
    act: async (page) => {
      await page.locator('.shop-checkout-form').waitFor()
      await page.getByLabel('Full name').fill('Test Person')
      await page.getByLabel('Phone number').fill('0712 345 678')
      await page.getByLabel('Area or city').fill('Mikocheni, Dar es Salaam')
      await page.getByLabel('Street, plot or landmark').fill('Plot 12')
      await page.getByRole('button', { name: /Place order/ }).click()
    },
  },
  { name: 'shop-not-found', path: '/no-such-page', ready: '.shop-not-found h1' },
]
const WIDTHS = [
  { name: '360', width: 360, height: 800 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
]
const THEMES = ['light', 'dark']

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

// ---------- fixtures ----------

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const categories = [
  { id: 1, name: 'Patient Monitoring' },
  { id: 2, name: 'Diagnostic Imaging' },
  { id: 3, name: 'Laboratory Equipment' },
]

function product(n, patch = {}) {
  const quantityInStock = patch.quantityInStock ?? 8
  const lowStockAt = 3
  return {
    id: `p${n}`,
    name: `Patient Monitor 12.1" Model ${n}`,
    slug: `patient-monitor-${n}`,
    sku: `PSP-PM-00${n}`,
    categoryId: 1,
    categoryName: 'Patient Monitoring',
    brand: 'Mindray',
    countryOfOrigin: 'China',
    description: 'A multi-parameter bedside monitor for wards and theatres.',
    specs: [
      { label: 'Display', value: '12.1" colour TFT' },
      { label: 'Warranty', value: '12 months' },
    ],
    priceTzs: 4250000,
    costPriceTzs: 3100000,
    requestQuotation: false,
    quantityInStock,
    lowStockAt,
    stockStatus: quantityInStock <= 0 ? 'out_of_stock' : quantityInStock <= lowStockAt ? 'low_stock' : 'in_stock',
    status: 'published',
    isPublished: true,
    isFeatured: false,
    isArchived: false,
    images: [
      { id: `i${n}a`, url: `/uploads/products/${n}a.png`, sortOrder: 0, isMain: true },
      { id: `i${n}b`, url: `/uploads/products/${n}b.png`, sortOrder: 1, isMain: false },
    ],
    ...patch,
  }
}

const products = [
  product(1),
  product(2, { quantityInStock: 2, name: 'Digital X-ray Detector Panel with a Very Long Descriptive Product Name' }),
  product(3, { quantityInStock: 0, status: 'draft', isPublished: false, requestQuotation: true, priceTzs: null }),
  product(4, { status: 'archived', isArchived: true, isPublished: false, images: [] }),
]

// A staff profile with a long name and email, waiting for a password change.
const staffMember = {
  id: 'st1',
  fullName: 'Rehema Mwanaisha Kisanga-Lyimo',
  email: 'rehema.mwanaisha.kisanga-lyimo@pspengineering.example',
  phone: '+255 712 345 678',
  role: 'staff',
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: '2026-10-13T07:45:00.000Z',
  createdAt: '2026-10-01T08:00:00.000Z',
}

// The staff list: the signed-in admin, the long-named person, an inactive one and one
// who never signed in. The total spans two pages so the pager shows.
const staffList = [
  staffMember,
  {
    id: 's1',
    fullName: 'Amina Mushi',
    email: 'amina@psp.example',
    phone: '+255 754 100 200',
    role: 'admin',
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: '2026-10-14T06:10:00.000Z',
    createdAt: '2026-09-01T08:00:00.000Z',
  },
  {
    id: 'st2',
    fullName: 'Juma Said',
    email: 'juma.said@psp.example',
    phone: '+255 713 222 333',
    role: 'staff',
    isActive: false,
    mustChangePassword: false,
    lastLoginAt: '2026-09-20T14:30:00.000Z',
    createdAt: '2026-09-02T08:00:00.000Z',
  },
  {
    id: 'st3',
    fullName: 'Grace Mollel',
    email: 'grace.mollel@psp.example',
    phone: null,
    role: 'staff',
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-10-10T08:00:00.000Z',
  },
]

// Customers: an individual, a long-named company with TIN and contact person, one with
// no contact details and one with a foreign phone. The total spans two pages.
const customer = (id, patch) => ({
  id,
  type: 'individual',
  fullName: null,
  companyName: null,
  tin: null,
  contactPerson: null,
  phone: null,
  email: null,
  createdAt: '2026-10-12T08:00:00.000Z',
  updatedAt: '2026-10-12T08:00:00.000Z',
  ...patch,
})

const customers = [
  customer('c1', { fullName: 'Asha Mushi', phone: '+255712345678', email: 'asha.mushi@example.com' }),
  customer('c2', {
    type: 'company',
    companyName: 'Bugando Medical Centre and University Teaching Hospital Procurement Unit',
    tin: '123-456-789',
    contactPerson: 'Dr. Neema Kweka-Lyimo',
    phone: '+255282500000',
    email: 'procurement.department@bugandomedicalcentre.example',
    createdAt: '2026-10-11T08:00:00.000Z',
  }),
  customer('c3', { fullName: 'Juma Said', createdAt: '2026-10-09T08:00:00.000Z' }),
  customer('c4', { type: 'company', companyName: 'Kilimanjaro Clinic', phone: '+254711000111', createdAt: '2026-10-02T08:00:00.000Z' }),
]

// The orders queue: every status, both payment states and sources, a long name, a
// quotation-only order and one with priced and quotation lines. The total spans two pages.
const orderRow = (n, patch) => ({
  id: `o${n}`,
  orderNumber: `PSP-000${130 - n}`,
  status: 'new',
  paymentStatus: 'unpaid',
  source: 'shop',
  customerId: null,
  guestName: 'Asha Mushi',
  guestPhone: '+255712345678',
  deliveryArea: 'Mikocheni, Dar es Salaam',
  totalTzs: 4250000,
  hasQuotationLines: false,
  itemCount: 2,
  createdAt: `2026-10-${String(14 - n).padStart(2, '0')}T08:30:00.000Z`,
  ...patch,
})

const orders = [
  orderRow(1, { hasQuotationLines: true, itemCount: 4 }),
  orderRow(2, {
    guestName: 'Bugando Medical Centre Procurement Unit, attention Dr. Neema Kweka-Lyimo',
    guestPhone: '+255282500000',
    deliveryArea: 'Bugando Hill, Mwanza',
    totalTzs: 1250000000,
    itemCount: 99,
  }),
  orderRow(3, { status: 'confirmed', paymentStatus: 'paid', source: 'staff', guestName: 'Juma Said', guestPhone: '+254711000111', deliveryArea: 'Arusha' }),
  orderRow(4, { status: 'delivered', totalTzs: 0, hasQuotationLines: true, itemCount: 1, guestName: 'Grace Mollel' }),
  orderRow(5, { status: 'closed', paymentStatus: 'paid', guestName: 'Kilimanjaro Clinic', totalTzs: 85000, itemCount: 1 }),
  orderRow(6, { status: 'cancelled', guestName: 'Rehema Kisanga', totalTzs: 21000000 }),
]

// One order's detail page, built from its queue row.
function orderDetail(id) {
  const row = orders.find((item) => item.id === id) ?? orders[1]
  const next = { new: ['confirmed', 'cancelled'], confirmed: ['delivered', 'cancelled'], delivered: ['closed'], closed: [], cancelled: [] }
  const placed = row.createdAt
  const cancelled = row.status === 'cancelled'
  return ok({
    order: {
      ...row,
      customer: cancelled ? { id: 'c2', type: 'company', name: customers[1].companyName } : null,
      createdBy: cancelled ? { id: 's1', fullName: 'Amina Mushi' } : null,
      source: cancelled ? 'staff' : row.source,
      guestEmail: cancelled ? null : 'procurement.office@bugando-medical-centre.example',
      deliveryAddress: 'Wurzburg Road, Plot 1, opposite the main gate, Block C medical stores',
      notes: cancelled ? '' : 'Please call the procurement office before delivery. Deliveries only on weekdays, 08:00 to 15:00.',
      totalTzs: 1250000000,
      hasQuotationLines: true,
      cancelReason: cancelled ? 'The customer ordered the same items twice. Kept PSP-000127 instead.' : null,
      updatedAt: placed,
      confirmedAt: cancelled ? placed : null,
      deliveredAt: null,
      closedAt: null,
      cancelledAt: cancelled ? placed : null,
      paidAt: null,
      nextStatuses: next[row.status],
      itemsEditable: row.status === 'new',
      items: [
        { id: 'i1', productId: 's1', productName: SHOP_NAMES[1][0], productSku: 'PM-12-6P-EXT-WALL', unitPriceTzs: 4850000, quantity: 10, lineTotalTzs: 48500000 },
        { id: 'i2', productId: 's11', productName: 'Dental Chair Unit', productSku: 'DCU-1', unitPriceTzs: 1201500000, quantity: 1, lineTotalTzs: 1201500000 },
        { id: 'i3', productId: 's2', productName: 'CT Scanner, 64-Slice', productSku: 'CT-64', unitPriceTzs: null, quantity: 1, lineTotalTzs: null },
      ],
    },
  })
}

const shopCategories = [
  { name: 'Imaging', slug: 'imaging', productCount: 14 },
  { name: 'Patient monitoring', slug: 'patient-monitoring', productCount: 6 },
  { name: 'Laboratory', slug: 'laboratory', productCount: 4 },
  { name: 'Hospital furniture', slug: 'hospital-furniture', productCount: 3 },
  { name: 'Respiratory', slug: 'respiratory', productCount: 2 },
  { name: 'Sterilization', slug: 'sterilization', productCount: 1 },
]

const SHOP_NAMES = [
  ['Colour Doppler Ultrasound Scanner', 'Imaging', 38500000],
  ['Patient Monitor 12.1" 6-Parameter with Extended Battery and Wall Mount', 'Patient monitoring', 4850000],
  ['CT Scanner, 64-Slice', 'Imaging', null],
  ['Laboratory Optical Microscope', 'Laboratory', 1650000],
  ['Hematology Analyzer, 3-Part', 'Laboratory', 21000000],
  ['Electric Hospital Bed, 3-Function', 'Hospital furniture', 5400000],
  ['Portable Oxygen Concentrator', 'Respiratory', 3950000],
  ['Steam Autoclave 23 L', 'Sterilization', 7900000],
  ['Fingertip Pulse Oximeter', 'Patient monitoring', 85000],
  ['Digital X-Ray System (DR)', 'Imaging', null],
  ['Volumetric Infusion Pump', 'Patient monitoring', 2750000],
  ['Dental Chair Unit', 'Hospital furniture', 1250000000],
]

const shopProducts = SHOP_NAMES.map(([name, categoryName, price], index) => ({
  id: `s${index}`,
  name,
  slug: `shop-product-${index}`,
  brand: index % 3 === 0 ? '' : 'Mindray',
  category: { name: categoryName, slug: shopCategories.find((c) => c.name === categoryName)?.slug ?? 'imaging' },
  priceTzs: price,
  requestQuotation: price === null,
  inStock: index % 4 !== 1,
  imageUrl: index % 5 === 4 ? null : `/uploads/products/s${index}.png`,
}))

const ok = (data) => ({ success: true, data })
const notFound = { success: false, error: { message: 'Product not found' } }

// The product page: one product with photos, specs and up to 4 related.
function shopDetail(slug) {
  const item = shopProducts.find((p) => p.slug === slug)
  if (!item) return notFound
  const n = shopProducts.indexOf(item)
  return ok({
    product: {
      ...item,
      sku: `PSP-${String(n).padStart(4, '0')}-LONG-SKU`,
      description:
        'Bedside monitor for wards, ICU and theatre. Monitors ECG, SpO2, blood pressure, respiration and temperature on one clear touchscreen.\n\nA built-in battery keeps it running during patient transport.',
      specs: [
        { label: 'Display', value: '12.1" colour TFT touchscreen' },
        { label: 'Parameters', value: 'ECG, SpO2, NIBP, respiration, 2× temperature' },
        { label: 'Power', value: '100–240 V AC, 50/60 Hz' },
        { label: 'Battery', value: 'Built-in Li-ion, up to 4 hours' },
        { label: 'Weight', value: '' },
      ],
      images: item.imageUrl ? [item.imageUrl, `/uploads/products/${n}b.png`, `/uploads/products/${n}c.png`] : [],
    },
    related: shopProducts.filter((p) => p !== item).slice(0, 4),
  })
}

// The cart: the fixture products among the posted lines; unknown ids are dropped like drafts.
function cartPrices(lines) {
  const items = (Array.isArray(lines) ? lines : []).flatMap((line) => {
    const found = shopProducts.find((p) => p.id === line?.productId)
    return found ? [{ product: found, quantity: line.quantity }] : []
  })
  return ok({ items })
}

function answer(url, request) {
  const { pathname, searchParams } = new URL(url)
  if (pathname === '/api/shop/cart/prices') return cartPrices(request.postDataJSON())
  if (pathname === '/api/shop/orders') return ok({ orderNumber: 'PSP-000123', totalTzs: 255000 })
  if (pathname === '/api/shop/categories') return ok({ categories: shopCategories })
  const detail = pathname.match(/^\/api\/shop\/products\/([^/]+)$/)
  if (detail) return shopDetail(decodeURIComponent(detail[1]))
  if (pathname === '/api/shop/products') {
    if (searchParams.get('q')) return ok({ products: [], total: 0, page: 1, pageSize: 12 })
    const page = Number(searchParams.get('page') || 1)
    return ok({ products: page === 1 ? shopProducts : shopProducts.slice(0, 2), total: 14, page, pageSize: 12 })
  }
  if (pathname === '/api/auth/me') {
    return ok({
      staff: { id: 's1', fullName: 'Amina Mushi', email: 'amina@psp.example', role: 'admin', mustChangePassword: false },
    })
  }
  if (pathname === '/api/office/products/categories') return ok({ categories })
  if (pathname === '/api/office/products') {
    return ok({
      products,
      total: products.length,
      page: 1,
      pageSize: 20,
      counts: { all: 4, in_stock: 2, low_stock: 1, out_of_stock: 1 },
    })
  }
  const one = pathname.match(/^\/api\/office\/products\/(p\d+)$/)
  if (one) return ok({ product: products.find((item) => item.id === one[1]) ?? products[0] })
  if (pathname === '/api/office/reset-requests') return ok({ requests: [], total: 0 })
  if (pathname === '/api/office/roles') {
    return ok({
      roles: [
        { name: 'admin', description: 'Full access to the office' },
        { name: 'staff', description: 'Normal office employee' },
      ],
    })
  }
  if (pathname === '/api/office/staff') return ok({ staff: staffList, total: 31, page: 1, pageSize: 25 })
  if (pathname === '/api/office/customers') {
    const counts = { all: 27, individual: 15, company: 12 }
    if (searchParams.get('q')) return ok({ customers: [], total: 0, page: 1, pageSize: 25, counts: { all: 0, individual: 0, company: 0 } })
    return ok({ customers, total: 27, page: 1, pageSize: 25, counts })
  }
  // A typed phone matches the long-named company; the customer being edited is left out.
  if (pathname === '/api/office/customers/duplicates') {
    const match = searchParams.get('phone') && !searchParams.get('exclude')
    return ok({ matches: match ? [{ ...customers[1], matchedOn: ['phone', 'email'] }] : [] })
  }
  const customerOne = pathname.match(/^\/api\/office\/customers\/([^/]+)$/)
  if (customerOne) {
    const found = customers.find((item) => item.id === customerOne[1]) ?? customers[1]
    if (found.id === 'c3') return ok({ customer: { ...found, notes: '', addresses: [] } })
    return ok({
      customer: {
        ...found,
        notes: 'Orders through the procurement unit. Invoices go to the finance office; pays by bank transfer within 30 days.',
        addresses: [
          { id: 'a1', label: 'Main hospital', area: 'Bugando Hill, Mwanza', address: 'Wurzburg Road, Plot 1, opposite the main gate', isDefault: true },
          { id: 'a2', label: '', area: 'Nyamagana, Mwanza', address: 'Medical stores, Block C', isDefault: false },
        ],
      },
    })
  }
  if (pathname === '/api/office/orders') {
    // The sidebar asks for new orders only, to show its badge.
    if (searchParams.get('status') === 'new' && !searchParams.get('page')) return ok({ orders: [], total: 4, page: 1, pageSize: 25 })
    const none = { all: 0, new: 0, confirmed: 0, delivered: 0, closed: 0, cancelled: 0 }
    if (searchParams.get('q')) return ok({ orders: [], total: 0, page: 1, pageSize: 25, counts: none })
    const counts = { all: 38, new: 4, confirmed: 9, delivered: 6, closed: 17, cancelled: 2 }
    return ok({ orders, total: 38, page: 1, pageSize: 25, counts })
  }
  const orderOne = pathname.match(/^\/api\/office\/orders\/([^/]+)$/)
  if (orderOne) return orderDetail(orderOne[1])
  const staffProfile = pathname.match(/^\/api\/office\/staff\/([^/]+)$/)
  if (staffProfile) {
    const inactive = staffProfile[1] === 'st2' ? { isActive: false, mustChangePassword: false } : {}
    return ok({ staff: { ...staffMember, id: staffProfile[1], ...inactive } })
  }
  return ok({})
}

// ---------- helpers ----------

function findBrowser() {
  if (process.env.BROWSER_PATH && existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH
  return BROWSERS.find((candidate) => existsSync(candidate))
}

async function waitForServer(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const response = await fetch(ORIGIN)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('vite preview did not start')
}

function run(label, args) {
  console.log(`> ${label}`)
  // An empty API base makes the build call same-origin /api/..., which the check answers itself.
  const env = { ...process.env, VITE_API_BASE_URL: '' }
  const result = spawnSync(process.execPath, args, { cwd: webDir, stdio: 'inherit', env })
  if (result.status !== 0) throw new Error(`${label} failed`)
}

// ---------- main ----------

const executablePath = findBrowser()
if (!executablePath) {
  console.error('No Edge or Chrome found. Set BROWSER_PATH to a browser executable and run again.')
  process.exit(2)
}

mkdirSync(shotsDir, { recursive: true })
if (!process.env.SKIP_BUILD) {
  run('tsc', [path.join(webDir, 'node_modules', 'typescript', 'bin', 'tsc')])
  run('vite build', [path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'])
}

const server = spawn(
  process.execPath,
  [path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: webDir, stdio: 'ignore' },
)

const failures = []
let browser
try {
  await waitForServer()
  browser = await chromium.launch({ executablePath, headless: true })

  for (const theme of THEMES) {
    for (const size of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        colorScheme: theme,
        reducedMotion: 'reduce',
      })
      await context.addInitScript((value) => localStorage.setItem('psp-theme', value), theme)
      await context.route(`${ORIGIN}/api/**`, (route) => {
        const body = answer(route.request().url(), route.request())
        return route.fulfill({
          status: body.success === false ? 404 : 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
      })
      await context.route(`${ORIGIN}/uploads/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))

      for (const route of ROUTES) {
        const page = await context.newPage()
        if (route.cart) {
          await page.addInitScript((lines) => localStorage.setItem('psp-cart', JSON.stringify(lines)), route.cart)
        }
        await page.goto(`${ORIGIN}${route.path}`, { waitUntil: 'networkidle' })
        page.on('pageerror', (error) => console.error(`page error on ${route.path}: ${error.message}`))
        try {
          await route.act?.(page)
          await page.locator(route.ready).first().waitFor({ timeout: 10000 })
        } catch {
          const text = (await page.locator('body').innerText()).slice(0, 200).replace(/\s+/g, ' ')
          throw new Error(`${route.path} did not show the page. URL ${page.url()}; page says: "${text}"`)
        }
        await page.waitForTimeout(250)

        const metrics = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          clientWidth: document.documentElement.clientWidth,
          signedIn: !location.pathname.includes('/auth/'),
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
          h1s: document.querySelectorAll('h1').length,
          missing: ['main#main', 'header', 'nav', 'footer', 'a.shop-skip[href="#main"]'].filter(
            (selector) => !document.querySelector(selector),
          ),
        }))
        const label = `${route.name} @ ${size.name}px ${theme}`
        const problems = []
        if (!metrics.signedIn) problems.push('was sent to the login page')
        if (metrics.theme !== theme) problems.push(`theme is ${metrics.theme}`)
        if (metrics.scrollWidth > metrics.clientWidth) {
          problems.push(`scrolls sideways (${metrics.scrollWidth}px content in ${metrics.clientWidth}px)`)
        }
        // Shop pages: their own title and description, one h1, the skip link and landmarks.
        if (route.name.startsWith('shop-')) {
          if (route.path !== '/' && !metrics.title.endsWith(' | PSP Engineering Group')) {
            problems.push(`title is "${metrics.title}"`)
          }
          if (!metrics.description) problems.push('no meta description')
          if (metrics.h1s !== 1) problems.push(`${metrics.h1s} h1 headings`)
          if (metrics.missing.length) problems.push(`missing ${metrics.missing.join(', ')}`)
        }
        await page.screenshot({
          path: path.join(shotsDir, `${route.name}-${size.name}-${theme}.png`),
          fullPage: true,
        })
        if (route.print && size.name === '768') {
          await page.emulateMedia({ media: 'print' })
          await page.screenshot({ path: path.join(shotsDir, `${route.name}-print-${theme}.png`), fullPage: true })
          await page.emulateMedia({ media: 'screen' })
        }
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${label}${problems.length ? ': ' + problems.join('; ') : ''}`)
        if (problems.length) failures.push(`${label}: ${problems.join('; ')}`)
        await page.close()
      }
      await context.close()
    }
  }
} catch (error) {
  failures.push(String(error?.stack ?? error))
} finally {
  await browser?.close()
  server.kill()
}

if (failures.length > 0) {
  console.error(`\nResponsive check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nResponsive check passed. Screenshots: ${shotsDir}`)

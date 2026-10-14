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
  { name: 'shop-home', path: '/', ready: '.shop-category-count' },
  { name: 'shop-products', path: '/products', ready: '.shop-card:not(.shop-card-skeleton)' },
  { name: 'shop-products-filtered', path: '/products?category=imaging&page=2', ready: '.shop-pager' },
  { name: 'shop-products-empty', path: '/products?q=no-such-thing', ready: '.shop-state' },
  { name: 'shop-product', path: '/products/shop-product-0', ready: '.shop-product-info h1' },
  { name: 'shop-product-out', path: '/products/shop-product-1', ready: '.shop-product-info h1' },
  { name: 'shop-product-missing', path: '/products/no-such-product', ready: '.shop-product-state' },
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

function answer(url) {
  const { pathname, searchParams } = new URL(url)
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
        const body = answer(route.request().url())
        return route.fulfill({
          status: body.success === false ? 404 : 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
      })
      await context.route(`${ORIGIN}/uploads/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))

      for (const route of ROUTES) {
        const page = await context.newPage()
        await page.goto(`${ORIGIN}${route.path}`, { waitUntil: 'networkidle' })
        page.on('pageerror', (error) => console.error(`page error on ${route.path}: ${error.message}`))
        try {
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
        }))
        const label = `${route.name} @ ${size.name}px ${theme}`
        const problems = []
        if (!metrics.signedIn) problems.push('was sent to the login page')
        if (metrics.theme !== theme) problems.push(`theme is ${metrics.theme}`)
        if (metrics.scrollWidth > metrics.clientWidth) {
          problems.push(`scrolls sideways (${metrics.scrollWidth}px content in ${metrics.clientWidth}px)`)
        }
        await page.screenshot({
          path: path.join(shotsDir, `${route.name}-${size.name}-${theme}.png`),
          fullPage: true,
        })
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

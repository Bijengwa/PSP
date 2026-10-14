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

const ROUTES = [
  { name: 'office-products', path: '/office/products' },
  { name: 'office-products-new', path: '/office/products/new' },
  { name: 'office-products-edit', path: '/office/products/p1' },
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

const ok = (data) => ({ success: true, data })

function answer(url) {
  const { pathname } = new URL(url)
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
      await context.route(`${ORIGIN}/api/**`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(answer(route.request().url())),
        }),
      )
      await context.route(`${ORIGIN}/uploads/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))

      for (const route of ROUTES) {
        const page = await context.newPage()
        await page.goto(`${ORIGIN}${route.path}`, { waitUntil: 'networkidle' })
        page.on('pageerror', (error) => console.error(`page error on ${route.path}: ${error.message}`))
        try {
          await page.locator('.office-product-head').first().waitFor({ timeout: 10000 })
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

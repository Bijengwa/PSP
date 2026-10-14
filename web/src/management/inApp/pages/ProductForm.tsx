import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { apiRequest, apiUrl, type ApiResult } from '../../../api/client'
import '../../auth/auth.css'

export type Category = { id: number; name: string }
export type Spec = { label: string; value: string }
export type ProductImage = { id: string; url: string; sortOrder: number; isMain: boolean }
export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock'

export type Product = {
  id: string
  name: string
  slug: string
  sku: string
  categoryId: number
  categoryName: string
  brand: string
  countryOfOrigin: string
  description: string
  specs: Spec[]
  priceTzs: number | null
  costPriceTzs: number | null
  requestQuotation: boolean
  quantityInStock: number
  lowStockAt: number
  stockStatus: StockStatus
  status: 'draft' | 'published' | 'archived'
  isPublished: boolean
  isFeatured: boolean
  isArchived: boolean
  images: ProductImage[]
}

type FieldName =
  | 'name'
  | 'sku'
  | 'categoryId'
  | 'brand'
  | 'countryOfOrigin'
  | 'description'
  | 'specs'
  | 'priceTzs'
  | 'costPriceTzs'
  | 'quantityInStock'
  | 'lowStockAt'
  | 'isPublished'
type FieldErrors = Partial<Record<FieldName, string>>

type Values = {
  name: string
  sku: string
  categoryId: string
  brand: string
  countryOfOrigin: string
  description: string
  priceTzs: string
  costPriceTzs: string
  requestQuotation: boolean
  quantityInStock: string
  lowStockAt: string
  isPublished: boolean
  isFeatured: boolean
}

// One photo in the editor: already stored on the server (id) or chosen but not yet uploaded (file).
type Photo = { key: string; id?: string; url: string; file?: File }

const FIELD_NAMES: FieldName[] = [
  'name',
  'sku',
  'categoryId',
  'brand',
  'countryOfOrigin',
  'description',
  'specs',
  'priceTzs',
  'costPriceTzs',
  'quantityInStock',
  'lowStockAt',
  'isPublished',
]

const MAX_PHOTOS = 8
const MIN_PHOTOS_TARGET = 4
const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const PHOTO_TYPES = ['image/jpeg', 'image/png']

// eslint-disable-next-line react-refresh/only-export-components
export const TZS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export const PRODUCTS_PATH = '/office/products'

// eslint-disable-next-line react-refresh/only-export-components
export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ categories: Category[] }>('/api/office/products/categories', { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setCategories(result.data.categories)
        else setFailed(true)
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [])

  return { categories, failed }
}

// Same rule as the server: derived from the quantity, never stored.
function stockStatusOf(quantity: number, lowAt: number): StockStatus {
  if (quantity <= 0) return 'out_of_stock'
  return quantity <= lowAt ? 'low_stock' : 'in_stock'
}

const STOCK_LABELS: Record<StockStatus, string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
}

const EMPTY: Values = {
  name: '',
  sku: '',
  categoryId: '',
  brand: '',
  countryOfOrigin: '',
  description: '',
  priceTzs: '',
  costPriceTzs: '',
  requestQuotation: false,
  quantityInStock: '0',
  lowStockAt: '3',
  isPublished: true,
  isFeatured: false,
}

function valuesOf(product: Product): Values {
  return {
    name: product.name,
    sku: product.sku,
    categoryId: String(product.categoryId),
    brand: product.brand,
    countryOfOrigin: product.countryOfOrigin,
    description: product.description,
    priceTzs: product.priceTzs === null ? '' : String(product.priceTzs),
    costPriceTzs: product.costPriceTzs === null ? '' : String(product.costPriceTzs),
    requestQuotation: product.requestQuotation,
    quantityInStock: String(product.quantityInStock),
    lowStockAt: String(product.lowStockAt),
    isPublished: product.isPublished,
    isFeatured: product.isFeatured,
  }
}

const toNumber = (text: string) => Number(text.replace(/[,\s]/g, ''))
const isWhole = (text: string) => text.trim() !== '' && Number.isInteger(toNumber(text))

// The form only catches what is cheap to see; the server stays the authority.
function validate(values: Values) {
  const errors: FieldErrors = {}
  if (!values.name.trim()) errors.name = 'Enter the product name.'
  if (!values.categoryId) errors.categoryId = 'Choose a category.'
  if (!values.requestQuotation && (!isWhole(values.priceTzs) || toNumber(values.priceTzs) < 1)) {
    errors.priceTzs = 'Enter a price in whole TZS, greater than 0.'
  } else if (values.priceTzs.trim() && (!isWhole(values.priceTzs) || toNumber(values.priceTzs) < 1)) {
    errors.priceTzs = 'Enter a price in whole TZS, greater than 0.'
  }
  if (values.costPriceTzs.trim() && (!isWhole(values.costPriceTzs) || toNumber(values.costPriceTzs) < 1)) {
    errors.costPriceTzs = 'Enter a cost in whole TZS, greater than 0.'
  }
  if (!isWhole(values.quantityInStock) || toNumber(values.quantityInStock) < 0) {
    errors.quantityInStock = 'Enter a quantity of 0 or more.'
  }
  if (!isWhole(values.lowStockAt) || toNumber(values.lowStockAt) < 0) {
    errors.lowStockAt = 'Enter an alert level of 0 or more.'
  }
  return errors
}

function errorMessage(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  return result.message
}

function fieldErrorsFrom(details: unknown): FieldErrors {
  const next: FieldErrors = {}
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    for (const name of FIELD_NAMES) {
      const message = (details as Record<string, unknown>)[name]
      if (typeof message === 'string') next[name] = message
    }
  }
  return next
}

// ---------- icons (line icons, currentColor) ----------

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const CheckIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
)
const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" />
  </Icon>
)
const UploadIcon = () => (
  <svg
    width="32"
    height="32"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
)
const ArrowLeftIcon = () => (
  <Icon>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
)
const ArrowRightIcon = () => (
  <Icon>
    <path d="M9 6l6 6-6 6" />
  </Icon>
)
const InfoIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
)
const AlertIcon = () => (
  <Icon>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
)
const CrossIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
)

const STOCK_ICONS: Record<StockStatus, React.ReactNode> = {
  in_stock: <CheckIcon />,
  low_stock: <AlertIcon />,
  out_of_stock: <CrossIcon />,
}

function StockBadge({ status, current }: { status: StockStatus; current?: boolean }) {
  return (
    <span
      className={`office-stock office-stock-${status}${current ? ' is-current' : ''}`}
      aria-current={current ? 'true' : undefined}
    >
      {STOCK_ICONS[status]}
      {STOCK_LABELS[status]}
    </span>
  )
}

// ---------- the editor (Add and Edit share it) ----------

let photoCounter = 0
const nextKey = () => `photo-${(photoCounter += 1)}`

type EditorProps = { product?: Product; notice?: string | null }

function ProductEditor({ product, notice: initialNotice = null }: EditorProps) {
  const navigate = useNavigate()
  const { categories, failed } = useCategories()
  const editing = Boolean(product)

  const [values, setValues] = useState<Values>(() => (product ? valuesOf(product) : EMPTY))
  const [specs, setSpecs] = useState<Spec[]>(() =>
    product && product.specs.length > 0 ? product.specs : [{ label: '', value: '' }],
  )
  const [photos, setPhotos] = useState<Photo[]>(() =>
    (product?.images ?? []).map((image) => ({ key: image.id, id: image.id, url: apiUrl(image.url) })),
  )
  const [removedIds, setRemovedIds] = useState<string[]>([])
  const [errors, setErrors] = useState<FieldErrors>({})
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(initialNotice)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const objectUrls = useRef<string[]>([])

  // "Changes saved." goes away on its own.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const urls = objectUrls.current
    return () => urls.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  const set = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }))
  const archived = product?.isArchived ?? false

  const quantity = isWhole(values.quantityInStock) ? toNumber(values.quantityInStock) : 0
  const lowAt = isWhole(values.lowStockAt) ? toNumber(values.lowStockAt) : 0
  const liveStatus = stockStatusOf(quantity, lowAt)

  // ----- photos -----

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list)
    const accepted: Photo[] = []
    let problem: string | null = null
    for (const file of incoming) {
      if (!PHOTO_TYPES.includes(file.type)) problem = `"${file.name}" is not a JPG or PNG photo.`
      else if (file.size > MAX_PHOTO_BYTES) problem = `"${file.name}" is larger than 10 MB.`
      else if (photos.length + accepted.length >= MAX_PHOTOS) problem = `A product can have up to ${MAX_PHOTOS} photos.`
      else {
        const url = URL.createObjectURL(file)
        objectUrls.current.push(url)
        accepted.push({ key: nextKey(), url, file })
      }
    }
    setPhotoError(problem)
    if (accepted.length > 0) setPhotos((current) => [...current, ...accepted])
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (!busy) addFiles(event.dataTransfer.files)
  }

  function movePhoto(index: number, by: -1 | 1) {
    setPhotos((current) => {
      const target = index + by
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function removePhoto(photo: Photo) {
    setPhotos((current) => current.filter((item) => item.key !== photo.key))
    if (photo.id) setRemovedIds((current) => [...current, photo.id as string])
    setPhotoError(null)
  }

  // ----- specifications -----

  const setSpec = (index: number, patch: Partial<Spec>) =>
    setSpecs((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const removeSpec = (index: number) =>
    setSpecs((current) => {
      const next = current.filter((_, i) => i !== index)
      return next.length > 0 ? next : [{ label: '', value: '' }]
    })

  // ----- saving -----

  async function save(publish: boolean | null) {
    if (busy) return
    const submitted: Values = publish === null ? values : { ...values, isPublished: publish }

    const found = validate(submitted)
    setErrors(found)
    setFormError(null)
    setNotice(null)
    if (Object.keys(found).length > 0) {
      setFormError('Check the highlighted fields.')
      return
    }

    const body = {
      name: submitted.name,
      sku: submitted.sku,
      categoryId: Number(submitted.categoryId),
      brand: submitted.brand,
      countryOfOrigin: submitted.countryOfOrigin,
      description: submitted.description,
      specs,
      priceTzs: submitted.priceTzs,
      costPriceTzs: submitted.costPriceTzs,
      requestQuotation: submitted.requestQuotation,
      quantityInStock: submitted.quantityInStock,
      lowStockAt: submitted.lowStockAt,
      isFeatured: submitted.isFeatured,
      // An archived product is restored first; it stays unpublished until then.
      ...(archived ? {} : { isPublished: submitted.isPublished }),
    }

    setBusy(true)
    const saved = editing
      ? await apiRequest<{ product: Product }>(`/api/office/products/${product?.id}`, { method: 'PATCH', body })
      : await apiRequest<{ product: Product }>('/api/office/products', { method: 'POST', body })
    if (!saved.ok) {
      setBusy(false)
      setFormError(errorMessage(saved))
      setErrors(fieldErrorsFrom(saved.details))
      return
    }

    // The product is saved. Photos come next: removals, uploads, then the final order.
    const productId = saved.data.product.id
    const photoProblem = await syncPhotos(productId)
    setBusy(false)

    const name = saved.data.product.name
    if (photoProblem) {
      // Do not lose the saved product: continue on its page and say what failed.
      navigate(`${PRODUCTS_PATH}/${productId}`, {
        replace: true,
        state: { notice: `${name} was saved, but the photos were not: ${photoProblem}` },
      })
      return
    }

    if (editing) {
      // The edit page loads the saved product again, so the form shows what is stored.
      navigate(`${PRODUCTS_PATH}/${productId}`, { replace: true, state: { notice: 'Changes saved.' } })
    } else {
      navigate(PRODUCTS_PATH, {
        state: {
          notice: saved.data.product.isPublished
            ? `${name} was added and is published.`
            : `${name} was saved as a draft.`,
        },
      })
    }
  }

  // Returns a problem message, or null when every photo change went through.
  async function syncPhotos(productId: string): Promise<string | null> {
    for (const id of removedIds) {
      const removed = await apiRequest(`/api/office/products/${productId}/images/${id}`, { method: 'DELETE' })
      if (!removed.ok) return errorMessage(removed)
    }

    const fresh = photos.filter((photo) => photo.file)
    let uploadedIds: string[] = []
    if (fresh.length > 0) {
      const form = new FormData()
      fresh.forEach((photo) => form.append('photos', photo.file as File))
      const uploaded = await apiRequest<{ product: Product }>(`/api/office/products/${productId}/images`, {
        method: 'POST',
        body: form,
      })
      if (!uploaded.ok) return errorMessage(uploaded)
      // The new photos are appended, in upload order, after the ones already there.
      uploadedIds = uploaded.data.product.images.slice(-fresh.length).map((image) => image.id)
    }

    let nextUploaded = 0
    const finalOrder = photos.map((photo) => photo.id ?? uploadedIds[nextUploaded++])
    const unchanged =
      removedIds.length === 0 &&
      fresh.length === 0 &&
      finalOrder.every((id, index) => id === product?.images[index]?.id)
    if (!unchanged && finalOrder.length > 0) {
      const ordered = await apiRequest(`/api/office/products/${productId}/images/order`, {
        method: 'PUT',
        body: { imageIds: finalOrder },
      })
      if (!ordered.ok) return errorMessage(ordered)
    }
    return null
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void save(null)
  }

  // ----- render helpers -----

  const err = (name: FieldName) =>
    errors[name] ? (
      <p id={`product-${name}-error`} className="field-error">
        {errors[name]}
      </p>
    ) : null
  const describedBy = (name: FieldName, ...extra: string[]) =>
    [...extra, ...(errors[name] ? [`product-${name}-error`] : [])].join(' ') || undefined
  const invalid = (name: FieldName) => (errors[name] ? true : undefined)

  const statusText = product ? { draft: 'Draft', published: 'Published', archived: 'Archived' }[product.status] : null

  return (
    <form className="office-product-page" onSubmit={handleSubmit} noValidate aria-busy={busy}>
      <div className="office-product-head">
        <div className="office-product-heading">
          <p className="office-lead">
            {editing ? (
              <>
                <span className={`office-status office-status-${product?.status}`}>{statusText}</span> · SKU{' '}
                {product?.sku}
              </>
            ) : (
              'New products appear on the store as soon as they are published'
            )}
          </p>
        </div>
        <div className="office-product-actions">
          <Link className="button button-secondary" to={PRODUCTS_PATH}>
            Cancel
          </Link>
          {!archived && (
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => void save(false)}>
              Save as draft
            </button>
          )}
          <button type="submit" className="button button-primary" disabled={busy || failed}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <CheckIcon />}
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Save product'}
          </button>
        </div>
      </div>

      <div className="office-status-line" role="status">
        {notice}
      </div>
      <div className="office-error" role="alert" hidden={!formError && !failed}>
        {formError ?? (failed ? 'Categories could not be loaded. Reload the page to try again.' : '')}
      </div>

      <div className="office-product-grid">
        <div className="office-product-main">
          {/* 1. Basic information */}
          <section className="office-card" aria-labelledby="card-basic">
            <h2 id="card-basic">Basic information</h2>
            <p className="office-card-sub">What customers see first</p>

            <div className="field">
              <label className="field-label" htmlFor="product-name">
                Product name
              </label>
              <input
                id="product-name"
                className="field-input"
                placeholder={'e.g. Patient Monitor 12.1"'}
                value={values.name}
                onChange={(event) => set({ name: event.target.value })}
                disabled={busy}
                aria-invalid={invalid('name')}
                aria-describedby={describedBy('name')}
                maxLength={160}
                required
              />
              {err('name')}
            </div>

            <div className="office-product-row">
              <div className="field">
                <label className="field-label" htmlFor="product-category">
                  Category
                </label>
                <select
                  id="product-category"
                  className="field-input"
                  value={values.categoryId}
                  onChange={(event) => set({ categoryId: event.target.value })}
                  disabled={busy}
                  aria-invalid={invalid('categoryId')}
                  aria-describedby={describedBy('categoryId')}
                  required
                >
                  <option value="">Choose a category</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                {err('categoryId')}
              </div>
              <div className="field">
                <label className="field-label" htmlFor="product-brand">
                  Brand / manufacturer
                </label>
                <input
                  id="product-brand"
                  className="field-input"
                  placeholder="e.g. Mindray"
                  value={values.brand}
                  onChange={(event) => set({ brand: event.target.value })}
                  disabled={busy}
                  aria-invalid={invalid('brand')}
                  aria-describedby={describedBy('brand')}
                  maxLength={120}
                />
                {err('brand')}
              </div>
            </div>

            <div className="office-product-row">
              <div className="field">
                <label className="field-label" htmlFor="product-sku">
                  SKU
                </label>
                <input
                  id="product-sku"
                  className="field-input"
                  placeholder="e.g. PSP-PM-0012"
                  value={values.sku}
                  onChange={(event) => set({ sku: event.target.value })}
                  disabled={busy}
                  aria-invalid={invalid('sku')}
                  aria-describedby={describedBy('sku', 'product-sku-hint')}
                  maxLength={64}
                  autoCapitalize="characters"
                />
                <p id="product-sku-hint" className="office-settings-hint">
                  Leave empty to create one automatically
                </p>
                {err('sku')}
              </div>
              <div className="field">
                <label className="field-label" htmlFor="product-origin">
                  Country of origin
                </label>
                <input
                  id="product-origin"
                  className="field-input"
                  placeholder="e.g. China"
                  value={values.countryOfOrigin}
                  onChange={(event) => set({ countryOfOrigin: event.target.value })}
                  disabled={busy}
                  aria-invalid={invalid('countryOfOrigin')}
                  aria-describedby={describedBy('countryOfOrigin')}
                  maxLength={80}
                />
                {err('countryOfOrigin')}
              </div>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="product-description">
                Description
              </label>
              <textarea
                id="product-description"
                className="field-input office-product-textarea"
                rows={6}
                placeholder="What it does, who it is for, what comes in the box"
                value={values.description}
                onChange={(event) => set({ description: event.target.value })}
                disabled={busy}
                aria-invalid={invalid('description')}
                aria-describedby={describedBy('description')}
              />
              {err('description')}
            </div>
          </section>

          {/* 5. Photos */}
          <section className="office-card" aria-labelledby="card-photos">
            <h2 id="card-photos">Photos</h2>
            <p className="office-card-sub">The first photo is the main image on the store</p>

            <div className="office-photos">
              <div
                className={`office-dropzone${dragging ? ' is-dragging' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <UploadIcon />
                <p className="office-dropzone-title">
                  Drag photos here or{' '}
                  <button
                    type="button"
                    className="office-link-button"
                    onClick={() => fileInput.current?.click()}
                    disabled={busy || photos.length >= MAX_PHOTOS}
                  >
                    browse
                  </button>
                </p>
                <p className="office-settings-hint">JPG or PNG, up to 10 MB each. Add up to {MAX_PHOTOS} photos.</p>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png"
                  multiple
                  className="visually-hidden"
                  tabIndex={-1}
                  aria-label="Choose photos"
                  onChange={(event) => {
                    if (event.target.files) addFiles(event.target.files)
                    event.target.value = ''
                  }}
                />
              </div>

              {photos.length > 0 && (
                <ul className="office-photo-grid">
                  {photos.map((photo, index) => (
                    <li key={photo.key} className="office-photo">
                      <img src={photo.url} alt={`Photo ${index + 1}${index === 0 ? ', main image' : ''}`} />
                      {index === 0 && <span className="office-photo-main">Main image</span>}
                      <div className="office-photo-tools">
                        <button
                          type="button"
                          className="office-photo-button"
                          aria-label={`Move photo ${index + 1} earlier`}
                          disabled={busy || index === 0}
                          onClick={() => movePhoto(index, -1)}
                        >
                          <ArrowLeftIcon />
                        </button>
                        <button
                          type="button"
                          className="office-photo-button"
                          aria-label={`Move photo ${index + 1} later`}
                          disabled={busy || index === photos.length - 1}
                          onClick={() => movePhoto(index, 1)}
                        >
                          <ArrowRightIcon />
                        </button>
                        <button
                          type="button"
                          className="office-photo-button"
                          aria-label={`Remove photo ${index + 1}`}
                          disabled={busy}
                          onClick={() => removePhoto(photo)}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="office-settings-hint" role="status">
              {photos.length} of {MAX_PHOTOS} photos.
              {photos.length < MIN_PHOTOS_TARGET &&
                ` Aim for at least ${MIN_PHOTOS_TARGET}: front, angle, detail and the screen or in use.`}
            </p>
            {photoError && (
              <p className="field-error" role="alert">
                {photoError}
              </p>
            )}
          </section>

          {/* 6. Specifications */}
          <section className="office-card" aria-labelledby="card-specs">
            <h2 id="card-specs">Specifications</h2>
            <p className="office-card-sub">Shown as a table on the product page</p>

            <ul className="office-spec-list">
              {specs.map((row, index) => (
                <li key={index} className="office-spec-row">
                  <input
                    className="field-input"
                    placeholder={['e.g. Display', 'e.g. Power', 'e.g. Warranty'][index] ?? 'e.g. Weight'}
                    aria-label={`Specification ${index + 1} name`}
                    value={row.label}
                    onChange={(event) => setSpec(index, { label: event.target.value })}
                    disabled={busy}
                    maxLength={120}
                  />
                  <input
                    className="field-input"
                    placeholder={['e.g. 12.1"', 'e.g. 100–240 V AC', 'e.g. 12 months'][index] ?? 'e.g. 4.5 kg'}
                    aria-label={`Specification ${index + 1} value`}
                    value={row.value}
                    onChange={(event) => setSpec(index, { value: event.target.value })}
                    disabled={busy}
                    maxLength={500}
                  />
                  <button
                    type="button"
                    className="office-photo-button office-spec-remove"
                    aria-label={`Remove specification ${index + 1}`}
                    disabled={busy}
                    onClick={() => removeSpec(index)}
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
            {err('specs')}
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || specs.length >= 40}
              onClick={() => setSpecs((current) => [...current, { label: '', value: '' }])}
            >
              <PlusIcon />
              Add specification
            </button>
          </section>
        </div>

        <div className="office-product-side">
          {/* 2. Price */}
          <section className="office-card" aria-labelledby="card-price">
            <h2 id="card-price">Price</h2>
            <p className="office-card-sub">In Tanzanian shillings</p>

            <div className="field">
              <label className="field-label" htmlFor="product-price">
                Selling price
              </label>
              <div className="office-money">
                <span aria-hidden="true">TSh</span>
                <input
                  id="product-price"
                  className="field-input"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="0"
                  value={values.priceTzs}
                  onChange={(event) => set({ priceTzs: event.target.value })}
                  disabled={busy}
                  aria-invalid={invalid('priceTzs')}
                  aria-describedby={describedBy('priceTzs')}
                />
              </div>
              {err('priceTzs')}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="product-cost">
                Cost price (private)
              </label>
              <div className="office-money">
                <span aria-hidden="true">TSh</span>
                <input
                  id="product-cost"
                  className="field-input"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="0"
                  value={values.costPriceTzs}
                  onChange={(event) => set({ costPriceTzs: event.target.value })}
                  disabled={busy}
                  aria-invalid={invalid('costPriceTzs')}
                  aria-describedby={describedBy('costPriceTzs', 'product-cost-hint')}
                />
              </div>
              <p id="product-cost-hint" className="office-settings-hint">
                Only staff see this. Used for profit reports.
              </p>
              {err('costPriceTzs')}
            </div>

            <label className="office-check">
              <input
                type="checkbox"
                checked={values.requestQuotation}
                onChange={(event) => set({ requestQuotation: event.target.checked })}
                disabled={busy}
              />
              <span>Show &quot;Request a quotation&quot; instead of a price</span>
            </label>
          </section>

          {/* 3. Inventory */}
          <section className="office-card" aria-labelledby="card-inventory">
            <h2 id="card-inventory">Inventory</h2>
            <p className="office-card-sub">Stock status is set from the quantity</p>

            <div className="field">
              <label className="field-label" htmlFor="product-quantity">
                Quantity in stock
              </label>
              <input
                id="product-quantity"
                className="field-input"
                inputMode="numeric"
                autoComplete="off"
                value={values.quantityInStock}
                onChange={(event) => set({ quantityInStock: event.target.value })}
                disabled={busy}
                aria-invalid={invalid('quantityInStock')}
                aria-describedby={describedBy('quantityInStock')}
              />
              {err('quantityInStock')}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="product-low">
                Low-stock alert at
              </label>
              <input
                id="product-low"
                className="field-input"
                inputMode="numeric"
                autoComplete="off"
                value={values.lowStockAt}
                onChange={(event) => set({ lowStockAt: event.target.value })}
                disabled={busy}
                aria-invalid={invalid('lowStockAt')}
                aria-describedby={describedBy('lowStockAt', 'product-low-hint')}
              />
              <p id="product-low-hint" className="office-settings-hint">
                You get an alert when stock reaches this number
              </p>
              {err('lowStockAt')}
            </div>

            <div className="office-info">
              <p className="office-info-title">
                <InfoIcon />
                How it shows on the store
              </p>
              <div className="office-info-badges">
                {(['in_stock', 'low_stock', 'out_of_stock'] as StockStatus[]).map((status) => (
                  <StockBadge key={status} status={status} current={status === liveStatus} />
                ))}
              </div>
              <p className="office-settings-hint">
                Sales lower the quantity and restocks raise it, so the status is always correct.
              </p>
            </div>
          </section>

          {/* 4. Visibility */}
          <section className="office-card" aria-labelledby="card-visibility">
            <h2 id="card-visibility">Visibility</h2>

            {archived ? (
              <p className="office-settings-hint">
                This product is archived, so it is hidden from the store. Restore it to publish it again.
              </p>
            ) : (
              <fieldset className="office-radio-group">
                <legend className="visually-hidden">Visibility</legend>
                <label className="office-check">
                  <input
                    type="radio"
                    name="visibility"
                    checked={values.isPublished}
                    onChange={() => set({ isPublished: true })}
                    disabled={busy}
                  />
                  <span>
                    <strong>Published</strong> · visible on the store
                  </span>
                </label>
                <label className="office-check">
                  <input
                    type="radio"
                    name="visibility"
                    checked={!values.isPublished}
                    onChange={() => set({ isPublished: false })}
                    disabled={busy}
                  />
                  <span>
                    <strong>Draft</strong> · only staff can see it
                  </span>
                </label>
              </fieldset>
            )}
            {err('isPublished')}

            <label className="office-check">
              <input
                type="checkbox"
                checked={values.isFeatured}
                onChange={(event) => set({ isFeatured: event.target.checked })}
                disabled={busy}
              />
              <span>Feature on the home page</span>
            </label>

            {editing && (
              <div className="office-reset-actions">
                <ArchiveButton product={product as Product} disabled={busy} />
              </div>
            )}
          </section>
        </div>
      </div>
    </form>
  )
}

// Archive and restore save straight away and never delete the product.
function ArchiveButton({ product, disabled }: { product: Product; disabled: boolean }) {
  const navigate = useNavigate()
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function toggle() {
    setWorking(true)
    setMessage(null)
    const result = await apiRequest<{ product: Product }>(`/api/office/products/${product.id}`, {
      method: 'PATCH',
      body: { isArchived: !product.isArchived },
    })
    setWorking(false)
    if (result.ok) {
      navigate(`${PRODUCTS_PATH}/${product.id}`, {
        replace: true,
        state: { notice: product.isArchived ? 'Product restored as a draft.' : 'Product archived.' },
      })
    } else {
      setMessage(errorMessage(result))
    }
  }

  return (
    <>
      <button type="button" className="button button-secondary" disabled={disabled || working} onClick={toggle}>
        {product.isArchived ? 'Restore product' : 'Archive product'}
      </button>
      {message && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}
    </>
  )
}

// /office/products/new
export default function AddProduct() {
  return <ProductEditor />
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; product: Product }

// /office/products/:id. Every visit (including after a save, which navigates here
// with a notice) loads the product again, so the form always shows what is stored.
export function EditProduct() {
  const { id } = useParams()
  const location = useLocation()
  const notice = (location.state as { notice?: string } | null)?.notice ?? null
  // A new key on every visit remounts the loader, so it fetches again from "loading".
  return <EditLoader key={`${id}-${location.key}`} id={id ?? ''} notice={notice} />
}

function EditLoader({ id, notice }: { id: string; notice: string | null }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ product: Product }>(`/api/office/products/${id}`, { signal: controller.signal }).then(
      (result) => {
        if (result.ok) setLoad({ status: 'ready', product: result.data.product })
        else {
          setLoad({
            status: 'error',
            message: result.status === 404 ? 'This product does not exist.' : errorMessage(result),
          })
        }
      },
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [id, attempt])

  if (load.status === 'loading') {
    return (
      <ul className="office-skeleton" aria-busy="true" aria-label="Loading product">
        {[0, 1, 2].map((n) => (
          <li key={n} className="office-skeleton-row" />
        ))}
      </ul>
    )
  }
  if (load.status === 'error') {
    return (
      <>
        <h1 className="office-title">Product</h1>
        <div className="office-error" role="alert">
          {load.message}
        </div>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setLoad({ status: 'loading' })
            setAttempt((value) => value + 1)
          }}
        >
          Try again
        </button>{' '}
        <Link className="button button-secondary" to={PRODUCTS_PATH}>
          Back to products
        </Link>
      </>
    )
  }

  return <ProductEditor product={load.product} notice={notice} />
}

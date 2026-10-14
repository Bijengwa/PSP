import { useEffect, useState } from 'react'
import { apiRequest, apiUrl, type ApiResult } from '../api/client'

// Public catalogue API (C2). Only live products, only shop-safe fields.
export type ShopCategory = { name: string; slug: string; productCount: number }

export type ShopProduct = {
  id: string
  name: string
  slug: string
  brand: string
  category: { name: string; slug: string }
  priceTzs: number | null
  requestQuotation: boolean
  inStock: boolean
  imageUrl: string | null
}

export type ShopProductsPage = { products: ShopProduct[]; total: number; page: number; pageSize: number }

export const SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'name', label: 'Name: A to Z' },
] as const

export type Sort = (typeof SORTS)[number]['value']

export function isSort(value: string | null): value is Sort {
  return SORTS.some((sort) => sort.value === value)
}

export type CatalogQuery = { q: string; category: string; sort: Sort; page: number }

export function getCategories(signal?: AbortSignal) {
  return apiRequest<{ categories: ShopCategory[] }>('/api/shop/categories', { signal })
}

// "?q=…&category=…&sort=…&page=…" for both the page URL and the API call.
// The default sort and page 1 are left out.
export function catalogSearch({ q, category, sort, page }: CatalogQuery) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (category) params.set('category', category)
  if (sort !== 'newest') params.set('sort', sort)
  if (page > 1) params.set('page', String(page))
  const search = params.toString()
  return search ? `?${search}` : ''
}

export function getProducts(query: CatalogQuery, signal?: AbortSignal) {
  return apiRequest<ShopProductsPage>(`/api/shop/products${catalogSearch(query)}`, { signal })
}

// The product page (C3): the card fields plus SKU, description, specs and every photo.
export type ShopProductDetail = ShopProduct & {
  sku: string
  description: string
  specs: { label: string; value: string }[]
  images: string[]
}

export type ShopProductAnswer = { product: ShopProductDetail; related: ShopProduct[] }

export function getProduct(slug: string, signal?: AbortSignal) {
  return apiRequest<ShopProductAnswer>(`/api/shop/products/${encodeURIComponent(slug)}`, { signal })
}

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

// "TZS 1,250,000"
export function formatTzs(value: number) {
  return `TZS ${NUMBER.format(value)}`
}

export function imageSrc(url: string) {
  return /^https?:\/\//.test(url) ? url : apiUrl(url)
}

export function errorText(result: Extract<ApiResult<unknown>, { ok: false }>) {
  return result.status === 0 ? result.message : 'We could not load the catalogue. Please try again.'
}

// Categories with live products. `loading` is true until the latest request answers.
export function useShopCategories() {
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<{ attempt: number; categories: ShopCategory[]; error: string | null } | null>(
    null,
  )

  useEffect(() => {
    const controller = new AbortController()
    getCategories(controller.signal).then(
      (result) =>
        setAnswer(
          result.ok
            ? { attempt, categories: result.data.categories, error: null }
            : { attempt, categories: [], error: errorText(result) },
        ),
      () => {}, // aborted
    )
    return () => controller.abort()
  }, [attempt])

  const current = answer?.attempt === attempt ? answer : null
  return {
    loading: current === null,
    categories: current?.categories ?? [],
    error: current?.error ?? null,
    retry: () => setAttempt((n) => n + 1),
  }
}

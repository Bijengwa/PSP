import { useSyncExternalStore } from 'react'

// The cart (C4). Stored in localStorage as product ids and quantities only: no
// names, prices or anything personal. This module owns every write; prices always
// come fresh from the server (POST /api/shop/cart/prices).
export const CART_KEY = 'psp-cart'
export const CART_EVENT = 'psp-cart-change'
export const MAX_QUANTITY = 99
export const MAX_LINES = 50 // the checkout takes at most 50 lines

export type CartLine = { productId: string; quantity: number }

const MAX_ID_LENGTH = 64

export function clampQuantity(value: number) {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_QUANTITY, Math.max(1, Math.floor(value)))
}

// Anything unreadable becomes an empty cart; bad lines are dropped, duplicates
// merged and quantities clamped, so a hand-edited or old value can't break the page.
function parse(raw: string | null): CartLine[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const lines: CartLine[] = []
  for (const entry of parsed) {
    const { productId, quantity } = (entry ?? {}) as { productId?: unknown; quantity?: unknown }
    if (typeof productId !== 'string' || !productId || productId.length > MAX_ID_LENGTH) continue
    if (typeof quantity !== 'number' || !Number.isFinite(quantity)) continue
    const same = lines.find((line) => line.productId === productId)
    if (same) same.quantity = clampQuantity(same.quantity + quantity)
    else if (lines.length < MAX_LINES) lines.push({ productId, quantity: clampQuantity(quantity) })
  }
  return lines
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(CART_KEY)
  } catch {
    // Storage blocked: show an empty cart.
    return null
  }
}

// Same array back while the stored value is unchanged (useSyncExternalStore needs that).
let cache: { raw: string | null; lines: CartLine[] } | null = null

export function readCart(): CartLine[] {
  const raw = readRaw()
  if (!cache || cache.raw !== raw) cache = { raw, lines: parse(raw) }
  return cache.lines
}

// False when the browser refuses to store it (private mode, storage full).
function write(lines: CartLine[]): boolean {
  try {
    if (lines.length === 0) localStorage.removeItem(CART_KEY)
    else localStorage.setItem(CART_KEY, JSON.stringify(lines.map(({ productId, quantity }) => ({ productId, quantity }))))
  } catch {
    return false
  }
  window.dispatchEvent(new Event(CART_EVENT))
  return true
}

export type AddResult = { ok: true; quantity: number; capped: boolean } | { ok: false; reason: 'full' | 'storage' }

// Adds to the line for this product, or starts one. `quantity` is the new total for the line.
export function addToCart(productId: string, quantity: number): AddResult {
  const lines = readCart()
  const same = lines.find((line) => line.productId === productId)
  if (!same && lines.length >= MAX_LINES) return { ok: false, reason: 'full' }

  const wanted = (same?.quantity ?? 0) + clampQuantity(quantity)
  const next = clampQuantity(wanted)
  const updated = same
    ? lines.map((line) => (line.productId === productId ? { productId, quantity: next } : line))
    : [...lines, { productId, quantity: next }]
  return write(updated) ? { ok: true, quantity: next, capped: next < wanted } : { ok: false, reason: 'storage' }
}

// Only changes a line that is already in the cart.
export function setQuantity(productId: string, quantity: number): boolean {
  const lines = readCart()
  if (!lines.some((line) => line.productId === productId)) return false
  return write(lines.map((line) => (line.productId === productId ? { productId, quantity: clampQuantity(quantity) } : line)))
}

export function removeFromCart(productId: string): boolean {
  return write(readCart().filter((line) => line.productId !== productId))
}

export function clearCart(): boolean {
  return write([])
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange) // other tabs
  window.addEventListener(CART_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CART_EVENT, onChange)
  }
}

const EMPTY: CartLine[] = []

export function useCart(): CartLine[] {
  return useSyncExternalStore(subscribe, readCart, () => EMPTY)
}

// Units in the cart, for the header badge.
export function useCartCount(): number {
  return useCart().reduce((sum, line) => sum + line.quantity, 0)
}

// The last price this tab showed for each product, so the cart can say when a
// price has changed since. Memory only: never stored.
const seenPrices = new Map<string, number | null>()

export function rememberPrice(productId: string, priceTzs: number | null) {
  seenPrices.set(productId, priceTzs)
}

// The earlier price when it differs from `priceTzs`, else undefined. Then remembers the new one.
export function priceChange(productId: string, priceTzs: number | null): number | null | undefined {
  const before = seenPrices.get(productId)
  seenPrices.set(productId, priceTzs)
  return before !== undefined && before !== priceTzs ? before : undefined
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CART_EVENT,
  CART_KEY,
  MAX_LINES,
  addToCart,
  clampQuantity,
  clearCart,
  priceChange,
  readCart,
  rememberPrice,
  removeFromCart,
  setQuantity,
} from './cart'

const stored = () => JSON.parse(localStorage.getItem(CART_KEY) ?? 'null')

afterEach(() => {
  localStorage.removeItem(CART_KEY)
  vi.restoreAllMocks()
})

describe('cart', () => {
  it('adds a line and stores only the product id and quantity', () => {
    expect(addToCart('p1', 2)).toEqual({ ok: true, quantity: 2, capped: false })
    expect(readCart()).toEqual([{ productId: 'p1', quantity: 2 }])
    expect(stored()).toEqual([{ productId: 'p1', quantity: 2 }])
    expect(Object.keys(localStorage)).toEqual([CART_KEY])
  })

  it('merges adds of the same product into one line, keeping the order', () => {
    addToCart('p1', 2)
    addToCart('p2', 1)
    addToCart('p1', 3)
    expect(readCart()).toEqual([
      { productId: 'p1', quantity: 5 },
      { productId: 'p2', quantity: 1 },
    ])
  })

  it('clamps quantities to 1–99, also when merging', () => {
    expect(clampQuantity(0)).toBe(1)
    expect(clampQuantity(-4)).toBe(1)
    expect(clampQuantity(2.7)).toBe(2)
    expect(clampQuantity(500)).toBe(99)
    expect(clampQuantity(Number.NaN)).toBe(1)

    expect(addToCart('p1', 0)).toMatchObject({ quantity: 1 })
    expect(addToCart('p1', 60)).toMatchObject({ quantity: 61, capped: false })
    expect(addToCart('p1', 60)).toEqual({ ok: true, quantity: 99, capped: true })
    expect(readCart()).toEqual([{ productId: 'p1', quantity: 99 }])
  })

  it('sets the quantity of a line already in the cart, clamped; ignores unknown products', () => {
    addToCart('p1', 1)
    expect(setQuantity('p1', 7)).toBe(true)
    expect(readCart()).toEqual([{ productId: 'p1', quantity: 7 }])
    setQuantity('p1', 0)
    expect(readCart()).toEqual([{ productId: 'p1', quantity: 1 }])
    setQuantity('p1', 1000)
    expect(readCart()).toEqual([{ productId: 'p1', quantity: 99 }])
    expect(setQuantity('nope', 3)).toBe(false)
    expect(readCart()).toEqual([{ productId: 'p1', quantity: 99 }])
  })

  it('removes one line; clearing (or removing the last line) empties the storage', () => {
    addToCart('p1', 1)
    addToCart('p2', 1)
    removeFromCart('p1')
    expect(readCart()).toEqual([{ productId: 'p2', quantity: 1 }])
    removeFromCart('p2')
    expect(localStorage.getItem(CART_KEY)).toBeNull()

    addToCart('p3', 1)
    clearCart()
    expect(readCart()).toEqual([])
    expect(localStorage.getItem(CART_KEY)).toBeNull()
  })

  it('treats corrupted storage as an empty cart and repairs it on the next write', () => {
    for (const raw of ['{not json', '"text"', '42', 'null', '{"productId":"p1","quantity":1}']) {
      localStorage.setItem(CART_KEY, raw)
      expect(readCart()).toEqual([])
    }

    localStorage.setItem(CART_KEY, '{not json')
    addToCart('p1', 1)
    expect(stored()).toEqual([{ productId: 'p1', quantity: 1 }])
  })

  it('drops bad lines, merges duplicates and clamps quantities found in storage', () => {
    localStorage.setItem(
      CART_KEY,
      JSON.stringify([
        { productId: 'p1', quantity: 2, priceTzs: 1, name: 'injected' },
        null,
        'p2',
        { productId: '', quantity: 1 },
        { productId: 42, quantity: 1 },
        { productId: 'x'.repeat(65), quantity: 1 },
        { productId: 'p3', quantity: 'many' },
        { productId: 'p4', quantity: 1e9 },
        { productId: 'p1', quantity: 3 },
        { productId: 'p5', quantity: 0 },
      ]),
    )
    expect(readCart()).toEqual([
      { productId: 'p1', quantity: 5 },
      { productId: 'p4', quantity: 99 },
      { productId: 'p5', quantity: 1 },
    ])

    // The next write keeps only ids and quantities.
    addToCart('p6', 1)
    expect(JSON.stringify(stored())).not.toMatch(/priceTzs|injected/)
  })

  it(`holds at most ${MAX_LINES} products`, () => {
    for (let n = 0; n < MAX_LINES; n += 1) addToCart(`p${n}`, 1)
    expect(addToCart('one-more', 1)).toEqual({ ok: false, reason: 'full' })
    expect(addToCart('p0', 1)).toMatchObject({ ok: true, quantity: 2 })
    expect(readCart()).toHaveLength(MAX_LINES)
  })

  it('reports blocked storage instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(addToCart('p1', 1)).toEqual({ ok: false, reason: 'storage' })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readCart()).toEqual([])
  })

  it('tells listeners (header badge, cart page) about every change', () => {
    const listener = vi.fn()
    window.addEventListener(CART_EVENT, listener)
    addToCart('p1', 1)
    setQuantity('p1', 2)
    removeFromCart('p1')
    window.removeEventListener(CART_EVENT, listener)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('remembers prices in memory only and reports a change once', () => {
    rememberPrice('p9', 1000)
    expect(priceChange('p9', 1000)).toBeUndefined()
    expect(priceChange('p9', 1200)).toBe(1000)
    expect(priceChange('p9', 1200)).toBeUndefined()
    expect(priceChange('never-seen', 5)).toBeUndefined()
    expect(localStorage.length).toBe(0)
  })
})

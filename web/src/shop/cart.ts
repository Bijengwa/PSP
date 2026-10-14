import { useEffect, useState } from 'react'

// The cart holds product ids and quantities only. C1 just reads it for the
// header badge; C4 owns writing it.
export const CART_KEY = 'psp-cart'
export const CART_EVENT = 'psp-cart-change'

function readCount(): number {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return 0
    return parsed.reduce((sum: number, line: unknown) => {
      const qty = (line as { quantity?: unknown } | null)?.quantity
      return sum + (typeof qty === 'number' && qty > 0 ? Math.floor(qty) : 0)
    }, 0)
  } catch {
    // Storage blocked or unreadable: show an empty cart.
    return 0
  }
}

export function useCartCount(): number {
  const [count, setCount] = useState(readCount)
  useEffect(() => {
    const update = () => setCount(readCount())
    window.addEventListener('storage', update)
    window.addEventListener(CART_EVENT, update)
    return () => {
      window.removeEventListener('storage', update)
      window.removeEventListener(CART_EVENT, update)
    }
  }, [])
  return count
}

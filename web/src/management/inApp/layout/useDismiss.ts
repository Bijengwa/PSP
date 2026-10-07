import { useEffect, type FocusEvent, type RefObject } from 'react'

// Closes an open popover on Escape (returning focus to its button) and on a
// pointer press outside `containerRef`.
export function useDismiss(open: boolean, containerRef: RefObject<HTMLElement | null>, close: (refocus: boolean) => void) {
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) close(false)
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, containerRef, close])
}

// True when keyboard focus moves from inside the popover to somewhere outside it.
export function focusLeft(event: FocusEvent<HTMLElement>) {
  const next = event.relatedTarget as Node | null
  return next !== null && !event.currentTarget.contains(next)
}

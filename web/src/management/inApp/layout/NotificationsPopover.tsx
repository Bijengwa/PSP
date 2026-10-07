import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { focusLeft, useDismiss } from './useDismiss'

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Notifications button with a non-modal popover. Real notifications arrive in M7+.
export default function NotificationsPopover() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])
  useDismiss(open, containerRef, close)

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  return (
    <div className="office-popover-anchor" ref={containerRef} onBlur={(event) => focusLeft(event) && close(false)}>
      <button
        ref={buttonRef}
        type="button"
        className="office-icon-button"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <BellIcon />
      </button>
      {open && (
        <div ref={panelRef} id={panelId} className="office-popover" role="dialog" aria-label="Notifications" tabIndex={-1}>
          <p className="office-popover-heading">Notifications</p>
          <p className="office-popover-empty">No notifications</p>
        </div>
      )}
    </div>
  )
}

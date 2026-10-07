import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import type { Staff } from '../../auth/AuthProvider'
import { focusLeft, useDismiss } from './useDismiss'

// Built in M2.1; until then this route shows a placeholder inside the shell.
export const CHANGE_PASSWORD_PATH = '/office/auth/change-password'

function initials(fullName: string) {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
}

// Profile button with a menu (WAI-ARIA menu button pattern): arrow keys, Home
// and End move between items; Escape, Tab and outside clicks close it.
export default function ProfileMenu({ staff }: { staff: Staff }) {
  const [open, setOpen] = useState(false)
  const [focusTarget, setFocusTarget] = useState<'first' | 'last'>('first')
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const buttonId = useId()
  const menuId = useId()

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])
  useDismiss(open, containerRef, close)

  function menuItems() {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  }

  useEffect(() => {
    if (!open) return
    const items = menuItems()
    items[focusTarget === 'first' ? 0 : items.length - 1]?.focus()
  }, [open, focusTarget])

  function openMenu(target: 'first' | 'last') {
    setFocusTarget(target)
    setOpen(true)
  }

  function onButtonKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(event.key === 'ArrowDown' ? 'first' : 'last')
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const items = menuItems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Tab') close(false)
    if (next !== null) {
      event.preventDefault()
      items[next]?.focus()
    }
  }

  return (
    <div className="office-popover-anchor" ref={containerRef} onBlur={(event) => focusLeft(event) && close(false)}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="office-profile-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu('first'))}
        onKeyDown={onButtonKeyDown}
      >
        <span className="office-avatar" aria-hidden="true">
          {initials(staff.fullName)}
        </span>
        <span className="office-user-text">
          <b>{staff.fullName}</b>
          <span>{staff.role}</span>
        </span>
      </button>
      {open && (
        <div className="office-popover office-popover-menu">
          <div className="office-menu-identity">
            <b>{staff.fullName}</b>
            <span>{staff.role}</span>
          </div>
          <ul ref={menuRef} id={menuId} className="office-menu" role="menu" aria-labelledby={buttonId} onKeyDown={onMenuKeyDown}>
            <li role="none">
              {/* The own-profile page is built in M4.3. */}
              <span role="menuitem" tabIndex={-1} aria-disabled="true" className="office-menu-item" title="Available later">
                Profile
              </span>
            </li>
            <li role="none">
              <Link role="menuitem" tabIndex={-1} className="office-menu-item" to={CHANGE_PASSWORD_PATH} onClick={() => close(false)}>
                Change password
              </Link>
            </li>
            <li role="none">
              <Link role="menuitem" tabIndex={-1} className="office-menu-item" to="/office/settings" onClick={() => close(false)}>
                Settings
              </Link>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}

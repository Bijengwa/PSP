import { useState } from 'react'
import { IconMoon, IconSun, IconSystem } from './Icons'

// Same key and values as the office setting; index.html applies it before
// first paint. Cycle: System -> Light -> Dark -> System.
const THEME_KEY = 'psp-theme'
type Pref = 'system' | 'light' | 'dark'
const NEXT: Record<Pref, Pref> = { system: 'light', light: 'dark', dark: 'system' }
const LABEL: Record<Pref, string> = { system: 'System', light: 'Light', dark: 'Dark' }

function read(): Pref {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

export default function ThemeToggle() {
  const [pref, setPref] = useState<Pref>(read)

  function change() {
    const next = NEXT[pref]
    setPref(next)
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, next)
    } catch {
      // Storage blocked: the theme stays as it was.
    }
    // index.html listens for this to re-apply in the same tab.
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }))
  }

  return (
    <button
      type="button"
      className="shop-theme"
      onClick={change}
      aria-label={`Theme: ${LABEL[pref]}. Switch to ${LABEL[NEXT[pref]]}`}
      title={`Theme: ${LABEL[pref]}`}
    >
      {pref === 'light' ? <IconSun /> : pref === 'dark' ? <IconMoon /> : <IconSystem />}
      <span className="shop-theme-label">{LABEL[pref]}</span>
    </button>
  )
}

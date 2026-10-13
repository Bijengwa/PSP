// Pure rules of the PSP guards: no engine calls here, so the tests can run
// them directly. The plan stays the authority (docs/management-plan.md); these
// only read it and docs/progress.md, and only ever warn.
import type { StepInfo } from '../types'

// Step IDs of the replanned roadmap (2026-10-07): M3.2 … M7.5, then C1 … C6
// (client side), then H1 … H8 (hardening).
export const STEP_ID = '(?:M\\d+\\.\\d+|[CH]\\d+)'

// Build order: M1–M7 are stages 1–7, C is 8, H is 9.
export const STAGE = { C: 8, H: 9 } as const

export const PLAN = 'docs/management-plan.md'
export const PROGRESS = 'docs/progress.md'

const escapeId = (id: string) => id.replace('.', '\\.')

export function stepNumber(id: string | null | undefined): [number, number] | null {
  const m = /^M(\d+)\.(\d+)$/.exec(id ?? '')
  if (m) return [Number(m[1]), Number(m[2])]
  const ch = /^([CH])(\d+)$/.exec(id ?? '')
  return ch ? [STAGE[ch[1] as 'C' | 'H'], Number(ch[2])] : null
}

// The "Current step: **M3.3**" line, else the first unticked box; with the counts.
export function parseProgress(text: string): StepInfo {
  const marked = text.match(new RegExp(`Current step:\\s*\\*{0,2}(${STEP_ID})`))
  const firstOpen = text.match(new RegExp(`- \\[ \\] (${STEP_ID})`))
  const done = [...text.matchAll(new RegExp(`- \\[[xX]\\] ${STEP_ID}`, 'g'))].length
  const total = done + [...text.matchAll(new RegExp(`- \\[ \\] ${STEP_ID}`, 'g'))].length
  const id = marked?.[1] ?? firstOpen?.[1] ?? null
  if (!id) return { id: null, title: 'all tracked steps are complete', done, total }
  const line = text.match(new RegExp(`- \\[[ xX]\\] ${escapeId(id)}\\s+(.+)`))
  return { id, title: line?.[1]?.trim() ?? '', done, total }
}

// The step's "#### M3.3 …" section of the plan, up to the next heading.
export function planSection(plan: string, id: string | null): string | null {
  if (!id) return null
  const lines = plan.split(/\r?\n/)
  const start = lines.findIndex(l => new RegExp(`^#### ${escapeId(id)}\\b`).test(l))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !/^#{1,4} /.test(lines[end] ?? '')) end++
  return lines.slice(start, end).join('\n').trim()
}

const slash = (p: string) => p.replace(/\\/g, '/')

// Repo-relative path with forward slashes, or null when outside the repo.
// Windows paths compare without case, as the file system does.
export function relPath(root: string, file: string): string | null {
  const r = slash(root).replace(/\/+$/, '')
  const f = slash(file)
  const isAbsolute = /^([A-Za-z]:)?\//.test(f)
  if (!isAbsolute) return f.replace(/^\.\//, '')
  const isWindows = /^[A-Za-z]:/.test(r)
  const same = isWindows ? f.toLowerCase().startsWith(r.toLowerCase() + '/') : f.startsWith(r + '/')
  return same ? f.slice(r.length + 1) : null
}

export type Edit = { old_string?: string; new_string?: string; replace_all?: boolean }

// What a Write/Edit/MultiEdit call is about to put into the file.
export type Change = {
  rel: string
  content?: string
  edits: Edit[]
}

export function addedText(change: Change): string {
  return [change.content, ...change.edits.map(e => e.new_string)].filter((s): s is string => typeof s === 'string').join('\n')
}

// The file's text after the change, from its text before.
export function applyChange(before: string, change: Change): string {
  if (typeof change.content === 'string') return change.content
  let after = before
  for (const e of change.edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue
    const replacement = e.new_string
    after = e.replace_all ? after.split(e.old_string).join(replacement) : after.replace(e.old_string, () => replacement)
  }
  return after
}

const MODULES = [
  { name: 'Products', file: 'products?', api: 'products', opensAt: 5, label: 'M5' },
  { name: 'Customers', file: 'customers?', api: 'customers', opensAt: 6, label: 'M6' },
  { name: 'Orders', file: 'orders?', api: 'orders', opensAt: 7, label: 'M7' },
  { name: 'Inventory', file: 'inventory', api: 'inventory', opensAt: Infinity, label: 'its own approved plan section after H8' },
  { name: 'Reports', file: 'reports?', api: 'reports', opensAt: Infinity, label: 'its own approved plan section after H8' },
  { name: 'Notifications', file: 'notifications?', api: 'notifications', opensAt: Infinity, label: 'its own approved plan section after H8' },
]

export type ScopeInput = {
  change: Change
  step: StepInfo | null
  /** progress.md before the change; only read when the change is to it. */
  progressBefore?: string
  /** Whether the folder the file goes into exists already. */
  folderExists: boolean
}

// The Scope Guard: warnings for a change that looks outside CLAUDE.md and the plan.
export function scopeWarnings({ change, step, progressBefore, folderExists }: ScopeInput): string[] {
  const { rel } = change
  if (rel.startsWith('.claude/')) return []
  const warnings: string[] = []
  const added = addedText(change)
  const stage = stepNumber(step?.id)?.[0] ?? 0
  const allDone = Boolean(step && !step.id)
  const isManagement = rel.startsWith('web/src/management/')

  // 1. Browser storage: the theme anywhere; the shop cart in the public shop from C1.
  if (/\.[jt]sx?$/.test(rel)) {
    const cartAllowed = !isManagement && (stage >= STAGE.C || allDone)
    const line = added
      .split('\n')
      .find(l => /\b(localStorage|sessionStorage|indexedDB)\b/.test(l) && !/theme/i.test(l) && !(cartAllowed && /cart/i.test(l)))
    if (line) {
      warnings.push(
        `browser storage used for something other than the theme${isManagement ? '' : ' or the shop cart'}: "${line.trim().slice(0, 120)}". Auth data must never be stored in the browser; who is logged in comes from GET /api/auth/me.`,
      )
    }
  }

  // 2. Business modules open stage by stage (plan §1 Scope).
  const hasLogic = /apiRequest|fetch\(|useState|useEffect|<form|<table|knex|db\(|router\.|createTable/.test(added)
  for (const m of MODULES) {
    if (stage >= m.opensAt) continue
    const isModuleFile = new RegExp(`^(web|node)/src/.*\\b${m.file}\\b`, 'i').test(rel)
    if (isModuleFile && (hasLogic || rel.startsWith('node/'))) {
      warnings.push(`this looks like real ${m.name} functionality, which opens at ${m.label}. Until then its page is a placeholder showing only its title.`)
    }
    if (new RegExp(`/api/(office/|shop/)?${m.api}\\b`).test(added)) {
      warnings.push(`adds an API route for ${m.name}, which opens at ${m.label}.`)
    }
  }
  if (stage < STAGE.C && !allDone && /\/api\/shop\b/.test(added)) {
    warnings.push('adds a public shop API route (/api/shop). The client side opens at C1, after M7.')
  }

  // 3. progress.md: tick only the step just finished, one at a time.
  if (rel === PROGRESS) {
    const before = progressBefore ?? ''
    const after = applyChange(before, change)
    const ticked = (text: string) => new Set([...text.matchAll(new RegExp(`- \\[[xX]\\] (${STEP_ID})`, 'g'))].map(m => m[1]))
    const was = ticked(before)
    const now = ticked(after)
    const newly = [...now].filter(id => !was.has(id))
    const unticked = [...was].filter(id => !now.has(id))
    if (newly.length > 1) warnings.push(`ticks ${newly.length} steps at once (${newly.join(', ')}). Tick only the step just finished.`)
    if (newly.length && step?.id && !newly.includes(step.id)) warnings.push(`ticks ${newly.join(', ')}, but the current step is ${step.id}. Tick the box first, then move "Current step".`)
    if (unticked.length) warnings.push(`unticks ${unticked.join(', ')}. Confirm this with the user.`)
    if (newly.length) warnings.push(`before ticking, confirm every "Done when" check for ${newly.join(', ')} actually passed.`)
  }

  // 4. Dependencies: only when necessary, and say why.
  if (/(^|\/)package\.json$/.test(rel)) {
    warnings.push('package.json is changing. CLAUDE.md: add dependencies only when necessary, and explain why to the user.')
  }

  // 5. File layout belongs to the user.
  if (!folderExists) {
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.'
    warnings.push(`creates a new folder (${folder}). The user decides the file layout: propose the path and ask first.`)
  }

  return warnings
}

// The Progress Guard's note when a prompt names a step other than the current one.
export function otherStepsMentioned(prompt: string, step: StepInfo | null): string[] {
  const mentioned = [...new Set(prompt.match(new RegExp(`\\b${STEP_ID}\\b`, 'g')) ?? [])]
  return mentioned.filter(id => id !== step?.id)
}

// Collision Guard state, shared with the shell hook (.claude/state/touched.json).
export type Touched = Record<string, { session: string; at: number }>
export const COLLISION_WINDOW_MS = 30 * 60 * 1000
export const COLLISION_KEEP_MS = 24 * 60 * 60 * 1000

export function collisionKey(rel: string, isWindows: boolean): string {
  return isWindows ? rel.toLowerCase() : rel
}

export function collisionWarning(state: Touched, key: string, session: string, now: number): string | null {
  const last = state[key]
  if (!last || last.session === session || now - last.at >= COLLISION_WINDOW_MS) return null
  const mins = Math.max(1, Math.round((now - last.at) / 60000))
  return `was edited ${mins} min ago by another Claude session (${last.session.slice(0, 8)}). Re-read the file before editing, and check with the user so the two sessions do not overwrite each other.`
}

export function recordTouch(state: Touched, key: string, session: string, now: number): Touched {
  const next: Touched = {}
  for (const [k, v] of Object.entries(state)) if (now - v.at <= COLLISION_KEEP_MS) next[k] = v
  next[key] = { session, at: now }
  return next
}

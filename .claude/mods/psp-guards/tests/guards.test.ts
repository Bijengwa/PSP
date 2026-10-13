import { describe, expect, test } from 'claude-code/testing'

import {
  collisionWarning,
  otherStepsMentioned,
  parseProgress,
  planSection,
  recordTouch,
  relPath,
  scopeWarnings,
  stepNumber,
} from '../hooks/guards'
import type { StepInfo } from '../types'

const progress = (current: string) =>
  [
    `Current step: **${current}**`,
    '- [x] M3.1 Rate limiting',
    '- [x] M3.2 Failed-login protection',
    '- [ ] M3.3 Session revocation',
    '- [ ] M5.2 Products list',
    '- [ ] C4 Cart',
    '- [ ] H2 Cookie/proxy/security review (old M3.5)',
  ].join('\n')

const at = (id: string): StepInfo => parseProgress(progress(id))
const edit = (rel: string, content: string) => ({ rel, content, edits: [] })

describe('progress', () => {
  test('reads the current step, its title and the counts', () => {
    expect(parseProgress(progress('M3.3'))).toEqual({ id: 'M3.3', title: 'Session revocation', done: 2, total: 6 })
    expect(parseProgress(progress('C4')).title).toBe('Cart')
  })

  test('orders M, C and H stages', () => {
    expect(stepNumber('M5.2')).toEqual([5, 2])
    expect(stepNumber('C3')).toEqual([8, 3])
    expect(stepNumber('H8')).toEqual([9, 8])
    expect(stepNumber('x')).toBe(null)
  })

  test('finds the step section in the plan', () => {
    const plan = '### M3\n#### M3.3 Session revocation\n- **Scope:** x\n#### M4.1 IT sidebar\n- y'
    expect(planSection(plan, 'M3.3')).toBe('#### M3.3 Session revocation\n- **Scope:** x')
  })

  test('notices other steps in a prompt', () => {
    expect(otherStepsMentioned('do M3.3 then H2 and C1', at('M3.3'))).toEqual(['H2', 'C1'])
  })
})

describe('paths', () => {
  test('Windows paths are made repo-relative without case', () => {
    expect(relPath('D:\\PROJECTS\\PROFF\\PSP', 'd:\\projects\\proff\\psp\\node\\src\\a.js')).toBe('node/src/a.js')
    expect(relPath('D:\\PROJECTS\\PROFF\\PSP', 'C:\\other\\a.js')).toBe(null)
    expect(relPath('/repo', '/repo/web/src/x.ts')).toBe('web/src/x.ts')
  })
})

describe('scope guard', () => {
  test('Products opens at M5, Orders at M7', () => {
    const products = edit('node/src/products.js', "router.get('/api/office/products')")
    expect(scopeWarnings({ change: products, step: at('M3.3'), folderExists: true })).toHaveLength(2)
    expect(scopeWarnings({ change: products, step: at('M5.2'), folderExists: true })).toEqual([])
    const orders = edit('node/src/orders.js', "router.get('/api/office/orders')")
    expect(scopeWarnings({ change: orders, step: at('M5.2'), folderExists: true })).toHaveLength(2)
  })

  test('Inventory stays locked, even in C and H', () => {
    expect(scopeWarnings({ change: edit('node/src/inventory.js', "db('x')"), step: at('H2'), folderExists: true })).toHaveLength(1)
  })

  test('the cart may use browser storage in the shop from C1, never in the office', () => {
    const shop = edit('web/src/shop/cart.ts', "localStorage.setItem('cart', x)")
    const office = edit('web/src/management/x.ts', "localStorage.setItem('cart', x)")
    expect(scopeWarnings({ change: shop, step: at('M5.2'), folderExists: true })).toHaveLength(1)
    expect(scopeWarnings({ change: shop, step: at('C4'), folderExists: true })).toEqual([])
    expect(scopeWarnings({ change: office, step: at('C4'), folderExists: true })).toHaveLength(1)
  })

  test('ticking two steps, or a step that is not current, is flagged', () => {
    const before = progress('M3.3')
    const after = before.replace('- [ ] M3.3', '- [x] M3.3').replace('- [ ] C4', '- [x] C4')
    const warnings = scopeWarnings({ change: edit('docs/progress.md', after), step: at('M3.3'), progressBefore: before, folderExists: true })
    expect(warnings.some(w => w.includes('2 steps at once'))).toBe(true)
  })

  test('new folders and package.json are flagged; .claude is left alone', () => {
    expect(scopeWarnings({ change: edit('web/src/new/x.ts', ''), step: at('M3.3'), folderExists: false })).toHaveLength(1)
    expect(scopeWarnings({ change: edit('web/package.json', '{}'), step: at('M3.3'), folderExists: true })).toHaveLength(1)
    expect(scopeWarnings({ change: edit('.claude/hooks/x.js', 'localStorage.x'), step: at('M3.3'), folderExists: false })).toEqual([])
  })
})

describe('collision guard', () => {
  test('warns about another session within 30 minutes, not its own', () => {
    const now = 10_000_000
    const state = recordTouch({}, 'node/src/a.js', 'session-a', now - 5 * 60_000)
    expect(collisionWarning(state, 'node/src/a.js', 'session-b', now)).toContain('5 min ago')
    expect(collisionWarning(state, 'node/src/a.js', 'session-a', now)).toBe(null)
    expect(collisionWarning(state, 'node/src/a.js', 'session-b', now + 60 * 60_000)).toBe(null)
  })
})

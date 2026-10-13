// PSP guards as a Claude Code mod. Same rules as the shell hooks in
// .claude/hooks (Progress, Scope and Collision Guard), plus what a mod can show:
// the current step in the status line, a band above the prompt, toasts on a
// warning, and /psp. Every guard only warns; none blocks a tool call.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardWarning, StepInfo } from '../types'
import {
  PLAN,
  PROGRESS,
  collisionKey,
  collisionWarning,
  otherStepsMentioned,
  parseProgress,
  planSection,
  recordTouch,
  relPath,
  scopeWarnings,
  type Change,
  type Edit,
  type Touched,
} from './guards'

const step = atom({ plugin: 'psp-guards', key: 'step' } as const, null)
const warnings = atom({ plugin: 'psp-guards', key: 'warnings' } as const, [])
const isBandHidden = atom({ plugin: 'psp-guards', key: 'isBandHidden' } as const, false)

const TOUCHED = '.claude/state/touched.json'
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

// Reads docs/progress.md and puts the current step in the status line.
async function refreshStep($: EngineInterface): Promise<StepInfo | null> {
  const root = await $.session.root()
  const text = await readText($, `${root}/${PROGRESS}`)
  const info = text === null ? null : parseProgress(text)
  await update($, step, () => info)
  $.ui.status(info ? (info.id ? `PSP ${info.id} · ${info.done}/${info.total} done` : 'PSP: all steps done') : undefined)
  return info
}

async function warn($: EngineInterface, guard: GuardWarning['guard'], file: string, texts: string[]) {
  if (!texts.length) return
  const at = await $.clock.now()
  await update($, warnings, list => [...list, ...texts.map(text => ({ guard, file, text, at }))].slice(-50))
  await update($, isBandHidden, () => false)
  $.ui.toast(`PSP ${guard} guard: ${texts.length} warning(s) on ${file}`)
}

export const register: Register = on => {
  let hasBriefed = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'psp', description: 'PSP: current roadmap step, its plan section, and recent guard warnings' })
    await refreshStep($)
    return next(e)
  })

  // Progress Guard: the model hears the current step with every prompt, and the
  // step's whole plan section with the first one.
  on('prompt.submit', async ($, e, next) => {
    const info = await refreshStep($)
    const root = await $.session.root()
    let note: string
    if (!info) {
      note = '[Progress Guard] docs/progress.md is missing, so the current step is unknown. Ask the user before starting roadmap work.'
    } else if (!info.id) {
      note = `[Progress Guard] docs/progress.md: ${info.title}. Inventory, Reports, real Notifications, online payment and customer accounts each need their own approved plan section before any work.`
    } else if (!hasBriefed) {
      const plan = (await readText($, `${root}/${PLAN}`)) ?? ''
      note =
        `[Progress Guard] Management roadmap: ${PLAN}. Current step: ${info.id} ${info.title}.\n` +
        'Work only on this step and stop when it is done; never continue to the next step automatically.\n\n' +
        (planSection(plan, info.id) ?? '(section not found in the plan)')
    } else {
      note = `[Progress Guard] Current step: ${info.id} ${info.title}.`
    }
    hasBriefed = true

    const others = otherStepsMentioned(e.text, info)
    if (others.length && info?.id) {
      note += ` The prompt mentions ${others.join(', ')}, which is not the current step. Confirm with the user before working on it, and never implement two steps at once.`
      await warn($, 'progress', PROGRESS, [`prompt mentions ${others.join(', ')}; current step is ${info.id}`])
    }
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e)) // warn-only: a failing guard never holds a prompt back

  // Scope Guard and Collision Guard on every file edit. They judge before the
  // edit runs and hand the model their warnings with the tool's result.
  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.has(e.tool)) return next(e)
    const input = e as unknown as { file_path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean; edits?: Edit[] }
    const root = await $.session.root()
    const rel = input.file_path ? relPath(root, input.file_path) : null
    if (!rel) return next(e)

    const notes: string[] = []
    const info = await read($, step)

    const change: Change = {
      rel,
      content: input.content,
      edits: input.edits ?? [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }],
    }
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.'
    const scope = scopeWarnings({
      change,
      step: info,
      progressBefore: rel === PROGRESS ? ((await readText($, `${root}/${PROGRESS}`)) ?? '') : undefined,
      folderExists: await $.fs.exists(`${root}/${folder}`),
    })
    if (scope.length) {
      notes.push(
        `[Scope Guard] ${rel}:\n- ${scope.join('\n- ')}\n` +
          'This is a warning, not a block. If the change is intended and inside the current step, continue and mention it in your report; otherwise stop and ask the user.',
      )
      await warn($, 'scope', rel, scope)
    }

    const session = await $.session.id()
    const isWindows = /^[A-Za-z]:/.test(root)
    const key = collisionKey(rel, isWindows)
    let touched: Touched = {}
    try {
      touched = JSON.parse((await readText($, `${root}/${TOUCHED}`)) ?? '{}') as Touched
    } catch {
      // no record yet
    }
    const now = await $.clock.now()
    const collision = rel.startsWith('.claude/state/') ? null : collisionWarning(touched, key, session, now)
    if (collision) {
      notes.push(`[Collision Guard] ${rel} ${collision}`)
      await warn($, 'collision', rel, [collision])
    }

    const ran = await next(e)

    if (ran.deny === undefined && !ran.isError && !rel.startsWith('.claude/state/')) {
      await $.fs.write(`${root}/${TOUCHED}`, JSON.stringify(recordTouch(touched, key, session, now), null, 2))
      if (!(await $.fs.exists(`${root}/.claude/state/.gitignore`))) await $.fs.write(`${root}/.claude/state/.gitignore`, '*\n')
    }
    if (rel === PROGRESS) await refreshStep($)

    if (!notes.length || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e)) // warn-only: a failing guard never blocks an edit

  on('command.run', { command: 'psp' }, async $ => {
    const info = await refreshStep($)
    const root = await $.session.root()
    const plan = (await readText($, `${root}/${PLAN}`)) ?? ''
    const recent = (await read($, warnings)).slice(-10)
    const lines = [
      info?.id ? `Current step: ${info.id} ${info.title} (${info.done}/${info.total} done)` : info ? info.title : 'docs/progress.md not found',
      '',
      (info?.id && planSection(plan, info.id)) || '',
      '',
      recent.length ? 'Recent guard warnings:' : 'No guard warnings this session.',
      ...recent.map(w => `- [${w.guard}] ${w.file}: ${w.text}`),
    ]
    await update($, isBandHidden, () => false)
    return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
  })

  // The band above the prompt: the current step, and the newest warning.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const info = await read($, step)
    if (e.props.hasSurvey || !info || (await read($, isBandHidden))) return next(e)
    const latest = (await read($, warnings)).at(-1)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>PSP </Text>
          <Text>{info.id ? `${info.id} ${info.title}` : info.title}</Text>
          <Text dimColor>{`  ${info.done}/${info.total} done  `}</Text>
          <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
        </Box>
        {latest && (
          <Text color="warning" wrap="truncate-end">
            {`${latest.guard} guard · ${latest.file}: ${latest.text}`}
          </Text>
        )}
      </Box>
    )
  })
}

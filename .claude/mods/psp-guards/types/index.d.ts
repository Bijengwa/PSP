export type StepInfo = {
  /** e.g. "M3.3", "C1", "H2"; null when every tracked step is ticked. */
  id: string | null
  title: string
  done: number
  total: number
}

export type GuardWarning = {
  /** Which guard raised it. */
  guard: 'scope' | 'progress' | 'collision'
  /** Repo-relative file the warning is about. */
  file: string
  text: string
  /** $.clock.now() milliseconds. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'psp-guards': {
      step: StepInfo | null
      warnings: GuardWarning[]
      isBandHidden: boolean
    }
  }
}

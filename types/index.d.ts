/** do: off-system or clickops, ticked off. ask: questions answered in the engine's own question dialog. */
export type AskKind = 'do' | 'ask'

/** One question of an ask, with up to four options; the dialog's Other takes free text. */
export type Question = { text: string; options: string[] }

/** `reply` is the person's answer, held until every ask has one; `isSent` once it went to Claude. */
export type Ask = {
  id: number
  kind: AskKind
  text: string
  questions: Question[]
  isDone: boolean
  reply: string | null
  isSent: boolean
}

/** What the last main-loop answer said: a list, an explicit "nothing", or no section at all. */
export type Verdict = 'asks' | 'nothing' | 'missing'

declare module 'claude-code' {
  interface PluginState {
    'needs-you': {
      asks: Shaped<Ask[]>
      verdict: Verdict | null
      isHidden: boolean
    }
  }
}

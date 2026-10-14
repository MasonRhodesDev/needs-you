/** do: off-system or clickops, marked done. ask: questions answered in the engine's own question dialog. */
export type AskKind = 'do' | 'ask'

/** One question of an ask, with up to four options; the dialog's Other takes free text. */
export type Question = { text: string; options: string[] }

/**
 * Where an item is in its motion: `flash` is the key-down beat, `done` the
 * green landing, `settled` after it; `dismissed` is a closed dialog's pause.
 */
export type AskStatus = 'open' | 'flash' | 'asking' | 'dismissed' | 'done' | 'settled'

/**
 * `reply` is the line sent for it, held until every item has one;
 * `summary` the read-back on its row ("done", "→ Merge now").
 */
export type Ask = {
  id: number
  kind: AskKind
  text: string
  questions: Question[]
  status: AskStatus
  reply: string | null
  summary: string | null
  isSent: boolean
}

/**
 * The band's own motion: `arrive` counts rows in, `folding` counts them out,
 * `sent` and `nothing` are the one-line states that dim, then go idle.
 */
export type BandPhase = 'idle' | 'arrive' | 'rest' | 'sending' | 'folding' | 'sent' | 'nothing'

export type Band = {
  phase: BandPhase
  /** Rows drawn: counts up while arriving, down while folding. */
  arrived: number
  /** The spinner's step, 0-3. */
  spin: number
  /** The open items are from an earlier reply: the last one had no list. */
  isStale: boolean
  /** A one-line state past its first beat. */
  isDim: boolean
  /** For `nothing`: the reply said the work is still going. */
  isGoing: boolean
  /** For `sent`: how many answers went. */
  sentCount: number
}

declare module 'claude-code' {
  interface PluginState {
    'needs-you': {
      asks: Shaped<Ask[]>
      band: Shaped<Band>
      isHidden: boolean
    }
  }
}

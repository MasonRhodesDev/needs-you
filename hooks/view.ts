import type { Color } from 'claude-code'

import type { Ask, Band } from '../types'

/** The motion's beats, in milliseconds (the keyframe board's timing table). */
export const BEAT = {
  arrive: 40,
  flash: 100,
  land: 600,
  dismissed: 2000,
  send: 500,
  fold: 30,
  sentDim: 1500,
  sentGone: 2500,
  nothingDim: 2000,
  nothingGone: 4000,
  spin: 120,
} as const

// Glyphs every common mono font has (JetBrains Mono lacks ▰▱◐↺): a pulsing dot, ■□ cells.
export const SPIN = ['·', '∙', '●', '∙'] as const

/** Below this many band columns (the terminal's less the border and marks) the detail column drops. */
export const WIDE = 80

export const IDLE: Band = {
  phase: 'idle',
  arrived: 0,
  spin: 0,
  isStale: false,
  isDim: false,
  isGoing: false,
  sentCount: 0,
}

/** One row as drawn: what each cell says and the theme key it is painted in. */
export type RowView = {
  id: number
  /** Its digit while it can be pressed; absent once answered or past 9. */
  hotkey?: string
  /** The number drawn where there is no hotkey to draw it. */
  number: string
  mark: string
  markColor: Color
  kind: string
  kindColor: Color
  text: string
  textColor: Color
  meta: string
  metaColor: Color
  isInverse: boolean
  isPressable: boolean
}

const detailOf = (ask: Ask) => {
  if (ask.kind === 'do') return ''
  const [first] = ask.questions
  if (ask.questions.length > 1) return `${ask.questions.length} questions`

  return first && first.options.length > 0 ? `${first.options.length} options` : 'your answer'
}

export const isAnswered = (ask: Ask) => ask.reply !== null

/** The rows the band draws now: arriving and folding show only the first `arrived`. */
export const rowsOf = (asks: Ask[], band: Band): RowView[] => {
  const shown = band.phase === 'arrive' || band.phase === 'folding' ? asks.slice(0, band.arrived) : asks

  return shown.map((ask, i) => {
    const isFresh = band.phase === 'arrive' && i === band.arrived - 1
    const row: RowView = {
      id: ask.id,
      number: ask.id < 9 ? `${ask.id + 1}: ` : `${ask.id + 1}. `,
      mark: ' ',
      markColor: 'text',
      kind: ask.kind === 'do' ? 'do ' : 'ask',
      kindColor: ask.kind === 'do' ? 'suggestion' : 'warning',
      text: ask.text,
      textColor: 'text',
      meta: detailOf(ask),
      metaColor: 'inactive',
      isInverse: false,
      isPressable: !isAnswered(ask) && ask.status !== 'asking',
    }
    if (ask.id < 9 && row.isPressable) row.hotkey = `${ask.id + 1}`

    switch (ask.status) {
      case 'flash':
        row.isInverse = true
        break
      case 'asking':
        Object.assign(row, { mark: SPIN[band.spin % 4], markColor: 'claude', meta: 'asking…', metaColor: 'claude' })
        break
      case 'dismissed':
        Object.assign(row, { mark: '○', markColor: 'inactive', meta: `press ${ask.id + 1} again`, metaColor: 'inactive' })
        break
      case 'done':
        Object.assign(row, { mark: '✓', markColor: 'success', meta: ask.summary ?? 'done', metaColor: 'success' })
        break
      case 'settled':
        Object.assign(row, {
          mark: '✓',
          markColor: 'success',
          kindColor: 'subtle',
          textColor: 'subtle',
          meta: ask.summary ?? 'done',
          metaColor: 'success',
        })
        break
    }
    // A row just arrived is drawn one step short of full.
    if (isFresh) Object.assign(row, { kindColor: 'inactive', textColor: 'inactive', metaColor: 'subtle' })

    return row
  })
}

export const meterOf = (asks: Ask[]) => {
  const answered = asks.filter(isAnswered).length

  return { on: '■'.repeat(answered), off: '□'.repeat(asks.length - answered) }
}

export const footOf = (asks: Ask[], band: Band): { text: string; color: Color } => {
  if (band.phase === 'sending' || band.phase === 'folding') {
    return { text: `${SPIN[band.spin % 4]} sending ${asks.length} ${asks.length === 1 ? 'answer' : 'answers'}…`, color: 'success' }
  }
  const answered = asks.filter(isAnswered).length
  if (answered > 0) {
    return { text: `${answered} ${answered === 1 ? 'answer' : 'answers'} held · sends to Claude when the last is in`, color: 'inactive' }
  }
  const keys = Math.min(asks.length, 9)

  return { text: `press ${keys === 1 ? '1' : `1–${keys}`} · answers send together`, color: 'inactive' }
}

/** What the sent and nothing-needed lines say, and their color at this beat. */
export const lineOf = (band: Band): { text: string; color: Color } | null => {
  if (band.phase === 'sent') {
    return {
      text: `✓ ${band.sentCount} ${band.sentCount === 1 ? 'answer' : 'answers'} sent to Claude`,
      color: band.isDim ? 'subtle' : 'success',
    }
  }
  if (band.phase === 'nothing') {
    return {
      text: `✓ nothing needed from you · ${band.isGoing ? 'still going' : 'finished'}`,
      color: band.isDim ? 'subtle' : 'inactive',
    }
  }

  return null
}

/** The one message the held replies go out as, in Claude's numbering. */
export const messageOf = (asks: Ask[]) =>
  asks
    .filter(a => a.reply !== null && !a.isSent)
    .map(a => a.reply)
    .join('\n')

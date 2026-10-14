import type { AskKind, Question } from '../types'

export type ParsedAsk = { kind: AskKind; text: string; questions: Question[] }
export type Parsed = { kind: 'asks'; asks: ParsedAsk[] } | { kind: 'nothing'; isGoing: boolean } | { kind: 'missing' }

const HEADING = /what i need from you/i
const NOTHING = /nothing needed from you/i
const GOING = /still (?:going|working|running)|in progress|not (?:yet )?finished/i
const ITEM = /^\s*(\d+)[.)]\s+(.*)$/
// decide and answer were this mod's first split of ask; still read as ask.
const TAG = /^\s*(?:\*\*)?\[(do|ask|decide|answer)\](?:\*\*)?\s*/i
const SUB = /^\s+(?:[-*+]|[a-z][.)])\s+(.*)$/

const tidy = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

/** `Which region? → us-east / us-west` is a question with its options. */
const question = (line: string): Question => {
  const [text = '', options = ''] = line.split(/\s*(?:→|->)\s*/, 2)
  return { text: tidy(text), options: options.split('/').map(tidy).filter(Boolean).slice(0, 4) }
}

/**
 * An ask's sub-bullets are either its questions (they end in `?`, each with
 * its options after an arrow) or the options of the one question its own
 * text asks; with none, its text is a question answered under Other.
 */
const questionsOf = (text: string, details: string[]): Question[] => {
  if (details.some(d => /\?\s*(?:(?:→|->).*)?$/.test(d))) return details.map(question)

  return [{ text, options: details.slice(0, 4) }]
}

/**
 * Reads the asks out of an answer: the numbered lines after the last
 * "What I need from you" heading (bold, `#`, or a plain line with a colon).
 * `[do]` or `[ask]` leads an item (untagged is `do`); an indented bullet
 * under it is a detail, another indented line continues it, and any other
 * line ends the list.
 */
export const parseAsks = (answer: string): Parsed => {
  const lines = answer.split('\n')
  let start = -1
  lines.forEach((line, i) => {
    if (HEADING.test(line)) start = i
  })

  if (start >= 0) {
    const items: { kind: AskKind; text: string; details: string[] }[] = []
    for (const line of lines.slice(start + 1)) {
      const item = ITEM.exec(line)
      const last = items[items.length - 1]
      if (item && !/^\s{2,}/.test(line)) {
        const body = item[2] ?? ''
        const tag = TAG.exec(body)
        const kind = tag?.[1]?.toLowerCase()
        items.push({ kind: kind && kind !== 'do' ? 'ask' : 'do', text: tag ? body.slice(tag[0].length) : body, details: [] })
      } else if (line.trim() === '') {
        continue
      } else if (last && SUB.test(line)) {
        last.details.push(SUB.exec(line)?.[1] ?? '')
      } else if (last && /^\s+\S/.test(line)) {
        if (last.details.length > 0) {
          last.details[last.details.length - 1] += ' ' + line
        } else {
          last.text += ' ' + line
        }
      } else if (last) {
        break
      }
    }
    const asks = items
      .map(a => {
        const text = tidy(a.text)
        const details = a.details.map(tidy).filter(Boolean)
        return { kind: a.kind, text, questions: a.kind === 'ask' ? questionsOf(text, details) : [] }
      })
      .filter(a => a.text)
    if (asks.length > 0) return { kind: 'asks', asks }
  }

  return NOTHING.test(answer) ? { kind: 'nothing', isGoing: GOING.test(answer) } : { kind: 'missing' }
}

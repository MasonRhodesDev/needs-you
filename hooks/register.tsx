import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Ask, Band } from '../types'
import { parseAsks } from './parse'
import { BEAT, IDLE, WIDE, footOf, isAnswered, lineOf, messageOf, meterOf, rowsOf } from './view'

// Bump a shape when its type changes: what an older version stored then reads as absent.
const asks = atom({ plugin: 'needs-you', key: 'asks' } as const, [] as Ask[], { shape: 'ask-v4' })
const band = atom({ plugin: 'needs-you', key: 'band' } as const, IDLE, { shape: 'band-v1' })
const isHidden = atom({ plugin: 'needs-you', key: 'isHidden' } as const, false)

// The rule from Convex's video, with its example swapped for one from this
// stack (a vague example makes the asks vague too) and each item typed so
// the band knows what pressing it should do.
export const RULE = `# What I need from you
- End every turn where you're blocked on me, or where the next step needs me, with a short "**What I need from you**" section. Numbered, one concrete action or decision per item: exactly what to do, where (which site, app, file or person), and what to send back.
- Start each item with its kind:
  - \`[do]\` something I do outside this chat (a site, an app, a command, clickops), e.g. "1. [do] Run \`! gh auth login\` in this prompt, pick GitHub.com → HTTPS, then reply 'done'", not "I need gh authenticated".
  - \`[ask]\` a decision or a question only I can answer. One question: the item is the question, its 2-4 options are indented "- " bullets under it, the one you recommend first and marked "(recommended)". Several questions: each is an indented "- " bullet ending in "?", followed by "→" and 2-4 options split by " / ". I can always type my own answer instead.
- Don't call AskUserQuestion for these: the list is where I answer them.
- If there are several, put the quickest or most blocking one first, and say what you'll get on with in the meantime.
- If you don't need anything from me, say "Nothing needed from you right now", and say whether the work is finished or still going.
- Never bury a request for me in the middle of a long update.

Example:
**What I need from you**
1. [do] Rotate the staging API key in the provider dashboard, then reply 'done'.
2. [ask] Merge #12 now, or wait for the full CI run?
   - Merge now (recommended)
   - Wait for CI
3. [ask] Two things about the deploy:
   - Which region? → us-east / us-west
   - Keep the old DNS record? → Yes, for a week / No, drop it`

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s)

// The band's running sequence (arrive, send, fold, the one-line states): a
// new reply cancels it. The spinner runs while a dialog is open or answers send.
let timers: Timer[] = []
let spinner: Timer | null = null

const later = ($: EngineInterface, ms: number, fn: () => unknown) => {
  timers.push($.clock.after(ms, () => void fn()))
}

const cancelSequence = () => {
  timers.forEach(t => t.cancel())
  timers = []
}

const setBand = ($: EngineInterface, patch: Partial<Band>) => update($, band, b => ({ ...b, ...patch }))

const setAsk = ($: EngineInterface, id: number, patch: Partial<Ask>) =>
  update($, asks, all => all.map(a => (a.id === id ? { ...a, ...patch } : a)))

/** Moves one item from `from` to `to` unless something else moved it first. */
const step = ($: EngineInterface, id: number, from: Ask['status'], to: Ask['status']) =>
  update($, asks, all => all.map(a => (a.id === id && a.status === from ? { ...a, status: to } : a)))

const startSpin = ($: EngineInterface) => {
  spinner ??= $.clock.every(BEAT.spin, () => void update($, band, b => ({ ...b, spin: (b.spin + 1) % 4 })))
}

const stopSpinIfStill = async ($: EngineInterface) => {
  const [list, b] = [await read($, asks), await read($, band)]
  if (list.some(a => a.status === 'asking') || b.phase === 'sending' || b.phase === 'folding') return
  spinner?.cancel()
  spinner = null
}

/** Rows drop in top to bottom, one a beat, then the band rests. */
const arrive = async ($: EngineInterface, count: number) => {
  cancelSequence()
  await setBand($, { ...IDLE, phase: 'arrive' })
  for (let i = 1; i <= count; i++) later($, BEAT.arrive * i, () => setBand($, { arrived: i }))
  later($, BEAT.arrive * (count + 1), () => setBand($, { phase: 'rest', arrived: count }))
}

/** A one-line state: drawn, dimmed, gone. */
const oneLine = ($: EngineInterface, patch: Partial<Band>, dimAt: number, goneAt: number) => {
  later($, dimAt, () => setBand($, { isDim: true }))
  later($, goneAt, () => setBand($, { ...IDLE }))

  return setBand($, { ...IDLE, ...patch })
}

/** Every item has its reply: send them as one message, then fold the band away. */
const send = async ($: EngineInterface) => {
  const list = await read($, asks)
  const text = messageOf(list)
  await update($, asks, all => all.map(a => (isAnswered(a) ? { ...a, isSent: true } : a)))
  cancelSequence()
  await setBand($, { phase: 'sending', arrived: list.length, sentCount: list.length })
  startSpin($)
  void $.prompt.submit({ text, asUser: true })

  for (let i = 1; i <= list.length; i++) {
    later($, BEAT.send + BEAT.fold * i, () => setBand($, { phase: 'folding', arrived: list.length - i }))
  }
  const folded = BEAT.send + BEAT.fold * (list.length + 1)
  later($, folded, async () => {
    await oneLine($, { phase: 'sent', sentCount: list.length }, BEAT.sentDim, BEAT.sentGone)
    await stopSpinIfStill($)
  })
}

/** An item got its reply: it lands green, settles, and the last one sends them all. */
const land = async ($: EngineInterface, id: number, reply: string, summary: string) => {
  const list = await setAsk($, id, { status: 'done', reply, summary })
  later($, BEAT.land, () => step($, id, 'done', 'settled'))
  await stopSpinIfStill($)
  if (list.every(isAnswered)) await send($)
}

/** After the key-down beat: a do is done; an ask runs the engine's question dialog. */
const act = async ($: EngineInterface, ask: Ask) => {
  if (ask.kind === 'do') return land($, ask.id, `${ask.id + 1}. ${short(ask.text)} → done`, 'done')

  await setAsk($, ask.id, { status: 'asking' })
  startSpin($)
  const answers: string[] = []
  for (const q of ask.questions) {
    try {
      answers.push(await $.ui.ask(q.text, { options: q.options, header: `Ask ${ask.id + 1}` }))
    } catch {
      // Dismissed: the item stays open, says so for a beat, and its partial answers go.
      await setAsk($, ask.id, { status: 'dismissed' })
      later($, BEAT.dismissed, () => step($, ask.id, 'dismissed', 'open'))
      return stopSpinIfStill($)
    }
  }
  const bare = answers.map(a => a.replace(/\s*\(recommended\)\s*$/i, ''))
  const only = ask.questions.length === 1 && ask.questions[0]?.text === ask.text
  const reply = only
    ? `${ask.id + 1}. ${short(ask.text)} → ${answers[0]}`
    : [`${ask.id + 1}. ${short(ask.text)}`, ...ask.questions.map((q, i) => `   - ${q.text} → ${answers[i]}`)].join('\n')

  return land($, ask.id, reply, `→ ${bare.join(', ')}`)
}

/** A digit or a click: the row flashes for a beat, then acts. */
const press = async ($: EngineInterface, ask: Ask) => {
  const now = (await read($, asks)).find(a => a.id === ask.id)
  if (!now || isAnswered(now) || now.status === 'asking' || now.status === 'flash') return

  await setAsk($, ask.id, { status: 'flash' })
  // Not part of the band's sequence: a reply that lands meanwhile replaces the list anyway.
  $.clock.after(BEAT.flash, () => void act($, { ...now, status: 'flash' }))
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    // A teammate answers its lead, and -p has nobody to ask.
    if (e.traits.includes('teammate') || e.traits.includes('print')) {
      return result
    }

    return {
      ...result,
      sections: [...result.sections, { id: 'needs-you:rule', text: RULE, scope: 'session' }],
    }
  })

  // The person wrote before answering everything: what they answered so far rides along.
  // Marked sent only once the message went, so a failure keeps them held; one
  // that throws first lets the person's own text through unchanged.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    const text = messageOf(await read($, asks))
    if (text === '') return next(e)
    const result = await next({ ...e, text: `${text}\n\n${e.text}` })
    await update($, asks, all => all.map(a => (isAnswered(a) ? { ...a, isSent: true } : a)))

    return result
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('turn.complete', async ($, e, next) => {
    // Subagents' turns and turns that died or were interrupted say nothing
    // about what the person owes; the list stands.
    if (e.agentId || e.reason !== 'answer' || e.answer === '') {
      return next(e)
    }

    const parsed = parseAsks(e.answer)
    if (parsed.kind === 'missing') {
      // No list: the open items stay, marked as from an earlier reply.
      const open = (await read($, asks)).some(a => !isAnswered(a))
      if (open) await setBand($, { isStale: true })

      return next(e)
    }

    if (parsed.kind === 'nothing') {
      cancelSequence()
      await update($, asks, () => [])
      await oneLine($, { phase: 'nothing', isGoing: parsed.isGoing }, BEAT.nothingDim, BEAT.nothingGone)

      return next(e)
    }

    await update($, asks, () =>
      parsed.asks.map((a, id) => ({ ...a, id, status: 'open' as const, reply: null, summary: null, isSent: false })),
    )
    await update($, isHidden, () => false)
    await arrive($, parsed.asks.length)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [list, b] = [await read($, asks), await read($, band)]
    if (e.props.hasSurvey || b.phase === 'idle' || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const line = lineOf(b)
    if (line) {
      return (
        <Box key="line" paddingX={1}>
          <Text color={line.color}>{line.text}</Text>
        </Box>
      )
    }
    if (list.length === 0) return next(e)

    const isWide = e.props.bodyColumns >= WIDE
    const isSending = b.phase === 'sending' || b.phase === 'folding'
    const open = list.filter(a => !isAnswered(a)).length
    const meter = meterOf(list)
    const foot = footOf(list, b)

    return (
      <Box key="band" flexDirection="column" borderStyle="round" borderColor={isSending ? 'success' : 'claude'} paddingX={1}>
        <Box key="title" justifyContent="space-between">
          <Text>
            <Text bold color={isSending ? 'success' : 'claude'}>
              needs you
            </Text>
            {b.phase !== 'arrive' && open > 0 && <Text color="inactive"> {open} open</Text>}
            {b.isStale && <Text color="warning"> · from an earlier reply</Text>}
          </Text>
          <Button key="hide" hotkey="h" label="hide" plain dimColor onPress={() => update($, isHidden, () => true)} />
        </Box>
        {rowsOf(list, b).map(r => {
          const ask = list.find(a => a.id === r.id)
          const body = [
            <Text key="kind" color={r.kindColor} inverse={r.isInverse}>
              {r.kind}{' '}
            </Text>,
            <Text key="text" color={r.textColor} inverse={r.isInverse} wrap="truncate-end">
              {r.text}
            </Text>,
          ]

          return (
            <Box key={`ask-${r.id}`}>
              <Text color={r.markColor}>{r.mark} </Text>
              {r.isPressable && ask ? (
                // A Button is a leaf: its label is its only text. A hotkey row
                // draws its own `1: `; past 9 the number rides in the label.
                <Button
                  key={`act-${r.id}`}
                  label={`${r.hotkey ? '' : r.number}${r.kind} ${r.text}`}
                  plain
                  onPress={() => press($, ask)}
                  {...(r.hotkey ? { hotkey: r.hotkey } : {})}
                />
              ) : (
                <Text>
                  <Text color="subtle">{r.number}</Text>
                  {body}
                </Text>
              )}
              {isWide && r.meta !== '' && (
                <Box flexGrow={1} justifyContent="flex-end" paddingLeft={2}>
                  <Text color={r.metaColor}>{r.meta}</Text>
                </Box>
              )}
            </Box>
          )
        })}
        <Box key="foot" paddingLeft={4}>
          <Text>
            <Text color="success">{meter.on}</Text>
            <Text color="subtle">{meter.off}</Text>
            <Text color={foot.color}>  {foot.text}</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}

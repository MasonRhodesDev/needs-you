import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ask, AskKind, Verdict } from '../types'
import { parseAsks } from './parse'

// Bump the shape when Ask changes: what an older version stored then reads as absent.
const asks = atom({ plugin: 'needs-you', key: 'asks' } as const, [] as Ask[], { shape: 'ask-v3' })
const verdict = atom({ plugin: 'needs-you', key: 'verdict' } as const, null as Verdict | null)
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
1. [do] Open the Proxmox UI → CT 104 → Options and turn on nesting, then reply 'done'.
2. [ask] Merge #12 now, or wait for the full CI run?
   - Merge now (recommended)
   - Wait for CI
3. [ask] Two things about the deploy:
   - Which region? → us-east / us-west
   - Keep the old DNS record? → Yes, for a week / No, drop it`

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s)

/** The held replies, one message's worth, in Claude's numbering. */
const held = (list: Ask[]) =>
  list
    .filter(a => a.reply !== null && !a.isSent)
    .map(a => a.reply)
    .join('\n')

const markSent = ($: EngineInterface) =>
  update($, asks, all => all.map(a => (a.reply !== null ? { ...a, isSent: true } : a)))

/**
 * Holds the person's reply to one ask; once every ask has one, sends them
 * all to Claude as one message of the person's own.
 */
const answer = async ($: EngineInterface, id: number, reply: string) => {
  const list = await update($, asks, all => all.map(a => (a.id === id ? { ...a, isDone: true, reply } : a)))
  if (list.some(a => !a.isDone)) return

  const text = held(list)
  await markSent($)
  await $.prompt.submit({ text, asUser: true })
}

/**
 * What pressing an ask does: a do is done; an ask puts each of its
 * questions in the engine's own question dialog. Dismissing the dialog
 * leaves the ask open.
 */
const start = async ($: EngineInterface, ask: Ask) => {
  if (ask.kind === 'do') return answer($, ask.id, `${ask.id + 1}. ${short(ask.text)} → done`)

  const answers: string[] = []
  for (const q of ask.questions) {
    try {
      answers.push(await $.ui.ask(q.text, { options: q.options, header: `Ask ${ask.id + 1}` }))
    } catch {
      return
    }
  }
  const only = ask.questions.length === 1 && ask.questions[0]?.text === ask.text
  const lines = only
    ? [`${ask.id + 1}. ${short(ask.text)} → ${answers[0]}`]
    : [`${ask.id + 1}. ${short(ask.text)}`, ...ask.questions.map((q, i) => `   - ${q.text} → ${answers[i]}`)]
  await answer($, ask.id, lines.join('\n'))
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
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    const text = held(await read($, asks))
    if (text === '') return next(e)
    await markSent($)

    return next({ ...e, text: `${text}\n\n${e.text}` })
  })

  on('turn.complete', async ($, e, next) => {
    // Subagents' turns and turns that died or were interrupted say nothing
    // about what the person owes; the list stands.
    if (e.agentId || e.reason !== 'answer' || e.answer === '') {
      return next(e)
    }

    const parsed = parseAsks(e.answer)
    await update($, verdict, () => parsed.kind)

    if (parsed.kind === 'missing') {
      // No section at all: keep the open asks, and say the rule was skipped.
      $.ui.status('needs-you: last answer had no "What I need from you"')

      return next(e)
    }

    const fresh = parsed.kind === 'asks' ? parsed.asks : []
    await update($, asks, () => fresh.map((a, id) => ({ ...a, id, isDone: false, reply: null, isSent: false })))
    if (fresh.length > 0) await update($, isHidden, () => false)
    $.ui.status(undefined)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, asks)
    const open = list.filter(a => !a.isDone)
    if (e.props.hasSurvey || open.length === 0 || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const VERB: Record<AskKind, string> = { do: 'do ', ask: 'ask' }

    return (
      <Box flexDirection="column">
        <Box key="title">
          <Text bold color="yellow">
            Needs you ({open.length}){' '}
          </Text>
          {list.some(a => a.reply !== null && !a.isSent) && (
            <Text dimColor>· answers send when the last is in </Text>
          )}
          <Button key="hide" hotkey="h" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {list.map(a => (
          <Box key={`ask-${a.id}`}>
            {a.isDone ? (
              <Text dimColor>✓ {a.id + 1}. </Text>
            ) : (
              // Claude's own numbering is the hotkey: 1-9 act on an ask from an
              // empty prompt or the focused band; plain draws `1: ask`.
              <Button
                key={`act-${a.id}`}
                label={a.id < 9 ? VERB[a.kind] : `${a.id + 1}. ${a.kind}`}
                plain
                onPress={() => start($, a)}
                {...(a.id < 9 ? { hotkey: `${a.id + 1}` } : {})}
              />
            )}
            <Text dimColor={a.isDone} wrap="wrap">
              {' '}
              {a.text}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}

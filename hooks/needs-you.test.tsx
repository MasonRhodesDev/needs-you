import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseAsks } from './parse'

const BAND = {
  plugin: 'needs-you',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const NARROW = { ...BAND, props: { ...BAND.props, bodyColumns: 70 } } as const

const turn = (answer: string, extra: { agentId?: string } = {}) => ({
  answer,
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...extra,
})

const ASKING = `Deployed the branch.

**What I need from you**
1. [do] Run \`! gh auth login\` in this prompt, then reply 'done'.
2. [ask] Merge #12 now, or wait for CI?
   - Merge now (recommended)
   - Wait for CI
3. **[ask]** Two things about the deploy:
   - Which region? → us-east / us-west
   - Keep the old DNS
     record? → Yes / No

I'll keep going on the docs meanwhile.`

/**
 * The engine beneath the plugin: its own band, the question dialog answering
 * from `picks` (null: dismissed), and the prompts the plugin submits.
 */
const engine = (on: On, picks: (string | null)[]) => {
  const sent: { text: string; origin: string }[] = []
  const asked: string[] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    sent.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    asked.push(q.question)
    const pick = picks.shift()
    if (pick == null) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: pick } } } as never
  })
  return { sent, asked, clock: mock.clock(on) }
}

const textOf = async (ui: { findAll: (q: object) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Box' }))[0]?.text ?? ''

describe('parseAsks', () => {
  test('reads kinds, options and questions', async () => {
    expect(parseAsks(ASKING)).toEqual({
      kind: 'asks',
      asks: [
        { kind: 'do', text: "Run `! gh auth login` in this prompt, then reply 'done'.", questions: [] },
        {
          kind: 'ask',
          text: 'Merge #12 now, or wait for CI?',
          questions: [{ text: 'Merge #12 now, or wait for CI?', options: ['Merge now (recommended)', 'Wait for CI'] }],
        },
        {
          kind: 'ask',
          text: 'Two things about the deploy:',
          questions: [
            { text: 'Which region?', options: ['us-east', 'us-west'] },
            { text: 'Keep the old DNS record?', options: ['Yes', 'No'] },
          ],
        },
      ],
    })
  })

  test('old tags read as ask; nothing says finished or still going; missing', async () => {
    const old = parseAsks('**What I need from you**\n1. [decide] What port?\n2. [answer] Who owns it?')
    expect(old.kind === 'asks' && old.asks.map(a => a.kind)).toEqual(['ask', 'ask'])
    expect(parseAsks('Nothing needed from you right now. Finished.')).toEqual({ kind: 'nothing', isGoing: false })
    expect(parseAsks('Nothing needed from you right now; still going on the tests.')).toEqual({ kind: 'nothing', isGoing: true })
    expect(parseAsks('Here is a long update with no section.')).toEqual({ kind: 'missing' })
  })
})

test("the rule rides the system prompt, not a teammate's", async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' }] }))
  const args = {
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'] as const,
    tools: [],
    outputStyle: null,
  }
  expect((await $.prompt.compose({ ...args, traits: [] })).sections.map(s => s.id)).toEqual(['intro', 'needs-you:rule'])
  expect((await $.prompt.compose({ ...args, traits: ['teammate'] })).sections.map(s => s.id)).toEqual(['intro'])
})

test('arrive: rows drop in 40 ms apart, then rest with counts and the meter', async ($, on) => {
  const { clock } = engine(on, [])
  await $.turn.complete(turn(ASKING))
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'ask-0' })).toBeUndefined()
  await clock.advance(40)
  expect(await ui.find({ key: 'ask-0' })).toBeDefined()
  expect(await ui.find({ key: 'ask-1' })).toBeUndefined()
  await clock.advance(80)
  expect(await ui.find({ key: 'ask-2' })).toBeDefined()
  await clock.advance(40)
  const band = await textOf(ui)
  expect(band).toContain('needs you 3 open')
  expect(band).toContain('2 options')
  expect(band).toContain('2 questions')
  expect(band).toContain('□□□  press 1–3 · answers send together')
  const hotkeys = (await ui.findAll({ type: 'Button' })).map(b => (b.props as { hotkey?: string }).hotkey)
  expect(hotkeys).toEqual(['h', '1', '2', '3'])
  await ui.unmount()
})

test('press: flash, land green, settle; ask reads back; the last answer sends and folds', async ($, on) => {
  const { sent, asked, clock } = engine(on, ['Merge now (recommended)', null, 'us-east', 'Yes'])
  await $.turn.complete(turn(ASKING))
  await clock.advance(200)
  const ui = await $.ui.mount(BAND)

  await ui.press({ key: 'act-0' })
  expect((await ui.findAll({ type: 'Text' })).some(t => (t.props as { inverse?: boolean }).inverse === true)).toBe(true)
  await clock.advance(100)
  expect(await textOf(ui)).toContain('✓ 1: do  Run')
  expect(await textOf(ui)).toContain('■□□  1 answer held · sends to Claude when the last is in')
  await clock.advance(600)

  await ui.press({ key: 'act-1' })
  await clock.advance(100)
  expect(asked).toEqual(['Merge #12 now, or wait for CI?'])
  expect(await textOf(ui)).toContain('→ Merge now')

  // Dismissed: ↺ and a hint for 2 s, then open again.
  await ui.press({ key: 'act-2' })
  await clock.advance(100)
  expect(await textOf(ui)).toContain('press 3 again')
  await clock.advance(2000)
  expect(await textOf(ui)).toContain('2 questions')

  await ui.press({ key: 'act-2' })
  await clock.advance(100)
  expect(await textOf(ui)).toContain('sending 3 answers')
  expect(sent).toEqual([
    {
      origin: 'plugin',
      text: [
        "1. Run `! gh auth login` in this prompt, then reply 'done'. → done",
        '2. Merge #12 now, or wait for CI? → Merge now (recommended)',
        '3. Two things about the deploy:',
        '   - Which region? → us-east',
        '   - Keep the old DNS record? → Yes',
      ].join('\n'),
    },
  ])

  await clock.advance(500 + 30 * 4)
  expect(await textOf(ui)).toContain('✓ 3 answers sent to Claude')
  await clock.advance(2500)
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
})

test('edges: nothing needed, a reply with no list, a narrow terminal', async ($, on) => {
  const { clock } = engine(on, [])
  await $.turn.complete(turn('Finished. Nothing needed from you right now.'))
  const ui = await $.ui.mount(BAND)
  expect(await textOf(ui)).toBe('✓ nothing needed from you · finished')
  await clock.advance(4000)
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()

  await $.turn.complete(turn(ASKING))
  await clock.advance(200)
  await $.turn.complete(turn('Still working, here is progress.'))
  await $.turn.complete(turn('**What I need from you**\n1. Ignore me', { agentId: 'sub' }))
  expect(await textOf(ui)).toContain('needs you 3 open · from an earlier reply')
  await ui.unmount()

  const narrow = await $.ui.mount(NARROW)
  expect(await textOf(narrow)).not.toContain('2 options')
  await narrow.unmount()
})

test('a message of your own carries the answers held so far, once', async ($, on) => {
  const { sent, clock } = engine(on, [])
  await $.turn.complete(turn('**What I need from you**\n1. [do] Flip the switch\n2. [do] Restart it'))
  await clock.advance(200)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'act-0' })
  await clock.advance(100)
  await $.prompt.submit({ text: 'also, rename it', origin: { kind: 'composer' } } as never)
  expect(sent.at(-1)?.text).toBe('1. Flip the switch → done\n\nalso, rename it')
  await $.prompt.submit({ text: 'and again', origin: { kind: 'composer' } } as never)
  expect(sent.at(-1)?.text).toBe('and again')
  await ui.unmount()
})

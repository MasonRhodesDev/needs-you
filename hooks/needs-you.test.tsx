import { describe, expect, test } from 'claude-code/testing'
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
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

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
4. Untagged, so a do.

I'll keep going on the docs meanwhile.`

/**
 * The engine beneath the plugin: a prompt box, the status line, and the
 * question dialog answering from `picks` (null: the person dismissed it).
 */
const engine = (on: On, picks: (string | null)[]) => {
  const sent: { text: string; origin: string }[] = []
  const asked: { question: string; options: string[] }[] = []
  const statuses: (string | undefined)[] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    sent.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    asked.push({ question: q.question, options: q.options?.map(o => o.label) ?? [] })
    const pick = picks.shift()
    if (pick == null) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: pick } } } as never
  })
  return { sent, asked, statuses }
}

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
        { kind: 'do', text: 'Untagged, so a do.', questions: [] },
      ],
    })
  })

  test('old decide/answer tags read as ask; nothing and missing', async () => {
    const old = parseAsks('**What I need from you**\n1. [decide] What port?\n2. [answer] Who owns it?')
    expect(old.kind === 'asks' && old.asks.map(a => a.kind)).toEqual(['ask', 'ask'])
    expect(parseAsks('All done. Nothing needed from you right now — finished.')).toEqual({ kind: 'nothing' })
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

test('answers are held, then sent as one message once the last is in', async ($, on) => {
  const { sent, asked, statuses } = engine(on, ['Merge now (recommended)', null, 'us-east', 'Yes'])
  await $.turn.complete(turn(ASKING))
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'title' }))?.text).toContain('Needs you (4)')
  const hotkeys = (await ui.findAll({ type: 'Button' })).map(b => (b.props as { hotkey?: string }).hotkey)
  expect(hotkeys).toEqual(['h', '1', '2', '3', '4'])

  await ui.press({ key: 'act-0' })
  expect((await ui.find({ key: 'title' }))?.text).toContain('Needs you (3) · answers send when the last is in')

  await ui.press({ key: 'act-1' })
  expect(asked[0]).toEqual({ question: 'Merge #12 now, or wait for CI?', options: ['Merge now (recommended)', 'Wait for CI'] })

  // Dismissed on its first question: the ask stays open.
  await ui.press({ key: 'act-2' })
  expect((await ui.find({ key: 'title' }))?.text).toContain('Needs you (2)')
  await ui.press({ key: 'act-2' })
  await ui.press({ key: 'act-3' })

  expect(asked.map(a => a.question)).toEqual(['Merge #12 now, or wait for CI?', 'Which region?', 'Which region?', 'Keep the old DNS record?'])
  expect(sent).toEqual([
    {
      origin: 'plugin',
      text: [
        "1. Run `! gh auth login` in this prompt, then reply 'done'. → done",
        '2. Merge #12 now, or wait for CI? → Merge now (recommended)',
        '3. Two things about the deploy:',
        '   - Which region? → us-east',
        '   - Keep the old DNS record? → Yes',
        '4. Untagged, so a do. → done',
      ].join('\n'),
    },
  ])
  expect(await ui.find({ key: 'title' })).toBeUndefined()

  // A turn that skips the rule keeps the list; one with nothing needed clears it.
  await $.turn.complete(turn('**What I need from you**\n1. [do] Again'))
  await $.turn.complete(turn('Still working, here is progress.'))
  await $.turn.complete(turn('**What I need from you**\n1. Ignore me', { agentId: 'sub' }))
  expect(statuses.at(-1)).toContain('no "What I need from you"')
  expect((await ui.find({ key: 'title' }))?.text).toContain('Needs you (1)')
  await $.turn.complete(turn('Finished. Nothing needed from you right now.'))
  expect(await ui.find({ key: 'title' })).toBeUndefined()
  await ui.unmount()
})

test('a message of your own carries the answers held so far', async ($, on) => {
  const { sent } = engine(on, [])
  await $.turn.complete(turn('**What I need from you**\n1. [do] Flip the switch\n2. [do] Restart it'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'act-0' })
  await $.prompt.submit({ text: 'also, rename it', origin: { kind: 'composer' } } as never)
  expect(sent.at(-1)?.text).toBe('1. Flip the switch → done\n\nalso, rename it')
  await $.prompt.submit({ text: 'and again', origin: { kind: 'composer' } } as never)
  expect(sent.at(-1)?.text).toBe('and again')
  await ui.unmount()
})

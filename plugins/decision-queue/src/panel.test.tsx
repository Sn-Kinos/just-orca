// The sidebar, against a stand-in worker. Project names here are invented.
import { assert, mockHost, mount, test } from 'orca/testing'
import type { AnswerInput, Card, QueueView } from './protocol'
import * as panel from './panel'
import { POLL_MS } from './panel'

const at = '2026-11-11T10:00:00+09:00'
const cards: Card[] = [
  { item: { id: 'DQ-1', createdAt: at, project: 'Sample Shop', kind: 'approve', title: 'Deploy staging', body: 'Tests pass.', proposal: 'Deploy now', evidence: [{ label: 'recording', path: '/tmp/run.mp4' }] }, status: 'open' },
  { item: { id: 'DQ-2', createdAt: at, project: 'Demo Clinic', kind: 'decide', title: 'Login method', options: ['Email', 'Phone'] }, status: 'open', stale: true },
  { item: { id: 'DQ-3', createdAt: at, project: 'Demo Clinic', kind: 'send-ready', title: 'Reply about the schedule', draft: 'We will send the build on Friday.', sender: 'Owner' }, status: 'open' },
  { item: { id: 'DQ-4', createdAt: at, project: 'Sample Shop', kind: 'review', title: 'Signup form' }, status: 'answered', answer: { itemHash: 'h', verdict: 'accept', at, relayed: false } },
  { item: { id: 'DQ-5', createdAt: at, project: 'Sample Shop', kind: 'approve', title: 'Merge PR 12' }, status: 'taken', answer: { itemHash: 'h', verdict: 'approve', at, relayed: true } }
]

function setup(view: QueueView) {
  const answers: AnswerInput[] = []
  const opened: unknown[] = []
  const host = mockHost({
    requests: {
      'queue.list': () => view,
      'config.setup': () => ({ ...view, configured: true }),
      'queue.answer': (input: AnswerInput) => {
        answers.push(input)
        return view
      },
      'evidence.open': (input: unknown) => {
        opened.push(input)
        return { mode: 'open' as const }
      }
    }
  })
  return { host, answers, opened }
}

test('before setup it offers one button and reads nothing else', async () => {
  const { host } = setup({ configured: false, cards: [], invalid: [] })
  const view = await mount(panel, { host })
  await view.press({ text: '이 Mac에서 쓰기 시작' })
  assert.deepEqual(host.calls.filter((c) => c.method === 'plugin.request').map((c) => (c.params as { name: string }).name), ['queue.list', 'config.setup'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('each kind gets its own answers, and a note is required where README says', async () => {
  const { host, answers, opened } = setup({ configured: true, cards, invalid: [] })
  const view = await mount(panel, { host })

  await view.press({ testId: 'approve-DQ-1' })
  assert.deepEqual(answers.at(-1), { id: 'DQ-1', verdict: 'approve' })

  await view.press({ testId: 'reject-DQ-1' })
  assert.equal(answers.length, 1, 'reject without a note is not sent')
  assert.ok(view.find({ testId: 'error-DQ-1' })?.text.includes('지시'))
  await view.type({ testId: 'note-DQ-1' }, 'Wait for QA')
  await view.press({ testId: 'reject-DQ-1' })
  assert.deepEqual(answers.at(-1), { id: 'DQ-1', verdict: 'reject', note: 'Wait for QA' })

  await view.press({ testId: 'choose-DQ-2-1' })
  assert.deepEqual(answers.at(-1), { id: 'DQ-2', verdict: 'choose', choice: 'Phone' })
  assert.ok(view.find({ testId: 'card-DQ-2' })?.text.includes('바뀌어'))

  assert.ok(view.find({ testId: 'draft-DQ-3' }))
  await view.press({ testId: 'sent-DQ-3' })
  assert.deepEqual(answers.at(-1), { id: 'DQ-3', verdict: 'sent' })

  await view.press({ testId: 'evidence-DQ-1-0' })
  assert.deepEqual(opened, [{ id: 'DQ-1', index: 0 }])

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('answered cards say whether the agent was told; taken cards are read-only', async () => {
  const { host } = setup({ configured: true, cards, invalid: [{ id: 'DQ-9', reason: 'title is missing' }] })
  const view = await mount(panel, { host })
  assert.ok(view.find({ testId: 'card-DQ-4' })?.text.includes('알리지 못함'))
  assert.ok(view.find({ testId: 'accept-DQ-4' }), 'an answer can change until the agent takes it')
  assert.equal(view.find({ testId: 'approve-DQ-5' }), null)
  assert.ok(view.find({ testId: 'card-DQ-5' })?.text.includes('처리 중'))
  assert.ok(view.find({ testId: 'invalid-DQ-9' })?.text.includes('title is missing'))
  await view.unmount()
})

test('the current answer cannot be pressed again, and a card is locked while its answer is sent', async () => {
  let release: () => void = () => {}
  const answers: AnswerInput[] = []
  const host = mockHost({
    requests: {
      'queue.list': () => ({ configured: true, cards, invalid: [] }),
      'queue.answer': (input: AnswerInput) => {
        answers.push(input)
        return new Promise<QueueView>((resolve) => (release = () => resolve({ configured: true, cards, invalid: [] })))
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ testId: 'accept-DQ-4' })?.disabled, true, 'DQ-4 is already accepted')
  assert.equal(view.find({ testId: 'revise-DQ-4' })?.disabled, false)

  // press resolves only once the panel settles, which waits for the held request; check before.
  const pending = view.press({ testId: 'approve-DQ-1' })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(view.find({ testId: 'approve-DQ-1' })?.disabled, true)
  assert.equal(view.find({ testId: 'reject-DQ-1' })?.disabled, true)
  release()
  await pending
  assert.equal(answers.length, 1)
  await view.unmount()
})

test('an answer still being relayed reads as sending, an old one as failed', async () => {
  const now = new Date().toISOString()
  const sending: Card = { item: { ...cards[0].item, id: 'DQ-7' }, status: 'answered', answer: { itemHash: 'h', verdict: 'approve', at: now, relayed: null } }
  const stuck: Card = { item: { ...cards[0].item, id: 'DQ-8' }, status: 'answered', answer: { itemHash: 'h', verdict: 'approve', at: '2026-11-11T00:00:00Z', relayed: null } }
  const { host } = setup({ configured: true, cards: [sending, stuck], invalid: [] })
  const view = await mount(panel, { host })
  assert.ok(view.find({ testId: 'card-DQ-7' })?.text.includes('알리는 중'))
  assert.ok(!view.find({ testId: 'card-DQ-7' })?.text.includes('알리지 못함'))
  assert.ok(view.find({ testId: 'card-DQ-8' })?.text.includes('알리지 못함'))
  await view.unmount()
})

test('without any worker post the panel still catches up by reading the queue again', async () => {
  let view: QueueView = { configured: true, cards: [cards[3]], invalid: [] }
  const host = mockHost({ requests: { 'queue.list': () => view } })
  const panelView = await mount(panel, { host })
  assert.ok(panelView.find({ testId: 'card-DQ-4' })?.text.includes('답'))
  // The agent finishes the item; no queue.changed reaches this panel.
  view = { configured: true, cards: [{ ...cards[3], status: 'done', stateNote: 'merged' }], invalid: [] }
  await new Promise((r) => setTimeout(r, POLL_MS + 500))
  await panelView.settled()
  assert.equal(panelView.find({ testId: 'accept-DQ-4' }), null, 'no longer answerable')
  assert.ok(panelView.find({ text: /끝난 항목 1개/ }))
  await panelView.unmount()
})

test('a worker post replaces what the panel shows', async () => {
  const { host } = setup({ configured: true, cards: [], invalid: [] })
  const view = await mount(panel, { host })
  await view.post('queue.changed', { configured: true, cards: [cards[0]], invalid: [] })
  assert.ok(view.find({ testId: 'card-DQ-1' }))
  await view.unmount()
})

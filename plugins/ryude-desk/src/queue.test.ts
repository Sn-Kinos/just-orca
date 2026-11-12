// The folder rules in README.md, against real files in a temporary folder.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceTarget, hashOf, loadQueue, markRelayed, writeAnswer } from './queue'

function queueDir(): string {
  return mkdtempSync(join(tmpdir(), 'dq-test-'))
}

function putItem(dir: string, item: Record<string, unknown>, folder = String(item.id)): string {
  const id = folder
  mkdirSync(join(dir, id), { recursive: true })
  const raw = JSON.stringify(item, null, 2)
  writeFileSync(join(dir, id, 'item.json'), raw)
  return raw
}

const approve = (id: string, createdAt = '2026-11-11T10:00:00+09:00') => ({
  id,
  createdAt,
  project: 'Sample Shop',
  kind: 'approve',
  title: 'Merge the login fix',
  evidence: [
    { label: 'recording', path: '/tmp/dq-evidence/run.mp4' },
    { label: 'bundle', path: '/tmp/dq-evidence/Thing.app' },
    { label: 'relative', path: 'notes.md' }
  ]
})

test('an item with no answer waits, newest first', () => {
  const dir = queueDir()
  putItem(dir, approve('DQ-20261111-100000-aaaa'))
  putItem(dir, approve('DQ-20261111-110000-bbbb', '2026-11-11T11:00:00+09:00'))
  const view = loadQueue(dir)
  assert.deepEqual(
    view.cards.map((c) => [c.item.id, c.status]),
    [
      ['DQ-20261111-110000-bbbb', 'open'],
      ['DQ-20261111-100000-aaaa', 'open']
    ]
  )
  assert.deepEqual(view.invalid, [])
})

test('a folder name that is not an id is ignored, a broken item is reported', () => {
  const dir = queueDir()
  mkdirSync(join(dir, 'not an id'))
  putItem(dir, { id: 'DQ-20261111-100000-cccc', createdAt: 'x', project: 'P', kind: 'approve' })
  putItem(dir, { ...approve('DQ-20261111-100000-dddd'), kind: 'launch' })
  putItem(dir, { ...approve('DQ-20261111-100000-eeee'), id: 'DQ-OTHER' }, 'DQ-20261111-100000-eeee')
  const view = loadQueue(dir)
  assert.deepEqual(view.cards, [])
  assert.deepEqual(
    view.invalid.map((i) => i.id).sort(),
    ['DQ-20261111-100000-cccc', 'DQ-20261111-100000-dddd', 'DQ-20261111-100000-eeee']
  )
})

test('an answer counts only while the item is unchanged', () => {
  const dir = queueDir()
  const id = 'DQ-20261111-100000-ffff'
  putItem(dir, approve(id))
  writeAnswer(dir, { id, verdict: 'approve' })
  assert.equal(loadQueue(dir).cards[0].status, 'answered')

  putItem(dir, { ...approve(id), title: 'Merge the login fix and the signup fix' })
  const card = loadQueue(dir).cards[0]
  assert.equal(card.status, 'open')
  assert.equal(card.stale, true)
})

test('the answer records the item hash and starts as being relayed', () => {
  const dir = queueDir()
  const id = 'DQ-20261111-100000-gggg'
  const raw = putItem(dir, approve(id))
  const { answer, changed } = writeAnswer(dir, { id, verdict: 'reject', note: 'wait for the review' }, new Date('2026-11-11T12:00:00Z'))
  assert.equal(changed, true)
  assert.equal(answer.itemHash, hashOf(Buffer.from(raw)))
  assert.equal(answer.relayed, null)
  const onDisk = JSON.parse(readFileSync(join(dir, id, 'answer.json'), 'utf8'))
  assert.deepEqual(onDisk, answer)

  markRelayed(dir, id, true)
  assert.equal(loadQueue(dir).cards[0].answer?.relayed, true)
})

test('pressing the same answer again changes nothing', () => {
  const dir = queueDir()
  const id = 'DQ-20261111-100000-llll'
  putItem(dir, approve(id))
  writeAnswer(dir, { id, verdict: 'approve' }, new Date('2026-11-11T12:00:00Z'))
  markRelayed(dir, id, true)
  const before = readFileSync(join(dir, id, 'answer.json'), 'utf8')
  const again = writeAnswer(dir, { id, verdict: 'approve' }, new Date('2026-11-11T12:05:00Z'))
  assert.equal(again.changed, false)
  assert.equal(readFileSync(join(dir, id, 'answer.json'), 'utf8'), before)

  const other = writeAnswer(dir, { id, verdict: 'reject', note: 'not yet' }, new Date('2026-11-11T12:06:00Z'))
  assert.equal(other.changed, true)
  assert.equal(other.answer.verdict, 'reject')
})

test('verdicts are checked against the kind', () => {
  const dir = queueDir()
  const id = 'DQ-20261111-100000-hhhh'
  putItem(dir, approve(id))
  assert.throws(() => writeAnswer(dir, { id, verdict: 'reject' }), /note/)
  assert.throws(() => writeAnswer(dir, { id, verdict: 'sent' }), /verdict/)

  const pick = 'DQ-20261111-100000-iiii'
  putItem(dir, { ...approve(pick), kind: 'decide', options: ['Plan A', 'Plan B'] })
  assert.throws(() => writeAnswer(dir, { id: pick, verdict: 'choose', choice: 'Plan C' }), /choice/)
  assert.equal(writeAnswer(dir, { id: pick, verdict: 'choose', choice: 'Plan B' }).answer.choice, 'Plan B')

  assert.throws(() => writeAnswer(dir, { id: 'DQ-NOPE', verdict: 'approve' }), /item/)
  assert.throws(() => writeAnswer(dir, { id: '../escape', verdict: 'approve' }), /id/)
})

test('every kind can be dismissed without a note', () => {
  const dir = queueDir()
  for (const [i, kind] of (['approve', 'decide', 'review', 'send-ready'] as const).entries()) {
    const id = `DQ-20261111-100000-dm${i}0`
    putItem(dir, { ...approve(id), kind, options: ['A', 'B'], draft: 'x', sender: 'y' })
    assert.equal(writeAnswer(dir, { id, verdict: 'dismiss' }).answer.verdict, 'dismiss')
  }
})

test('once the agent takes an item the answer is locked', () => {
  const dir = queueDir()
  const id = 'DQ-20261111-100000-jjjj'
  putItem(dir, approve(id))
  writeAnswer(dir, { id, verdict: 'approve' })
  writeFileSync(join(dir, id, 'state.json'), JSON.stringify({ status: 'taken', at: 'now' }))
  assert.equal(loadQueue(dir).cards[0].status, 'taken')
  assert.throws(() => writeAnswer(dir, { id, verdict: 'instruct', note: 'stop' }), /taken/)

  writeFileSync(join(dir, id, 'state.json'), JSON.stringify({ status: 'done', at: 'now', note: 'merged' }))
  const card = loadQueue(dir).cards[0]
  assert.equal(card.status, 'done')
  assert.equal(card.stateNote, 'merged')
})

test('evidence opens only listed media and documents; anything else is revealed', () => {
  const dir = queueDir()
  const id = 'DQ-20261111-100000-kkkk'
  putItem(dir, approve(id))
  assert.deepEqual(evidenceTarget(dir, id, 0), { path: '/tmp/dq-evidence/run.mp4', mode: 'open' })
  assert.deepEqual(evidenceTarget(dir, id, 1), { path: '/tmp/dq-evidence/Thing.app', mode: 'reveal' })
  assert.throws(() => evidenceTarget(dir, id, 2), /absolute/)
  assert.throws(() => evidenceTarget(dir, id, 3), /evidence/)
})

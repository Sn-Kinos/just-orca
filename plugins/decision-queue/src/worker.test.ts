// Runs src/worker.ts's activate(orca) over a mock host and a temporary queue folder.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'

const RESULTS = {
  'terminal.sendText': { accepted: true },
  'notifications.show': { delivered: true },
  'statusBar.update': { ok: true }
}

function setupQueue(): { dir: string; handleFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'dq-worker-'))
  const dir = join(root, 'decisions')
  mkdirSync(dir)
  const handleFile = join(root, 'handle')
  writeFileSync(handleFile, 'term_test-agent\n')
  return { dir, handleFile }
}

function putItem(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, id), { recursive: true })
  const item = { id, createdAt: '2026-11-11T10:00:00+09:00', project: 'Sample Shop', kind: 'approve', title: 'Deploy the staging build', ...extra }
  writeFileSync(join(dir, id, 'item.json'), JSON.stringify(item))
}

test('before setup it reads no folder and types into no terminal', async () => {
  const host = mockHost({ results: RESULTS })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('queue.list'), { configured: false, cards: [], invalid: [] })
  assert.deepEqual(host.callsOf('terminal.sendText'), [])
  assert.deepEqual(host.callsOf('notifications.show'), [])
  await worker.deactivate()
})

test('setup stores the default folder and handle file under HOME', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dq-home-'))
  const before = process.env.HOME
  process.env.HOME = home
  try {
    const host = mockHost({ results: RESULTS })
    const worker = await mountWorker(main, { host })
    const view = await worker.request('config.setup')
    assert.equal(view.configured, true)
    assert.deepEqual(host.data().storage.config, {
      dir: join(home, '.local/state/ryude/decisions'),
      handleFile: join(home, '.config/ryude/handle'),
      open: 'system'
    })
    assert.ok(existsSync(join(home, '.local/state/ryude/decisions')))
    await worker.deactivate()
  } finally {
    process.env.HOME = before
  }
})

test('an answer is written, the agent terminal gets only the id, and panels hear it', async () => {
  const { dir, handleFile } = setupQueue()
  const id = 'DQ-20261111-100000-aaaa'
  putItem(dir, id)
  const host = mockHost({ results: RESULTS, storage: { config: { dir, handleFile, open: 'none' } } })
  const worker = await mountWorker(main, { host })

  const view = await worker.request('queue.answer', { id, verdict: 'approve' })
  assert.equal(view.cards[0].status, 'answered')
  assert.equal(view.cards[0].answer?.relayed, true)

  const sent = host.callsOf('terminal.sendText') as { terminalId: string; text: string; enter: boolean }[]
  assert.equal(sent.length, 1)
  assert.equal(sent[0].terminalId, 'term_test-agent')
  assert.equal(sent[0].enter, true)
  assert.ok(sent[0].text.includes(id))
  assert.ok(!sent[0].text.includes('approve'), 'the verdict stays in the file')

  const onDisk = JSON.parse(readFileSync(join(dir, id, 'answer.json'), 'utf8'))
  assert.equal(onDisk.relayed, true)
  assert.ok(worker.posts.some((p) => p.event === 'queue.changed'))
  await worker.deactivate()
})

test('a missing handle file leaves the answer marked unrelayed', async () => {
  const { dir } = setupQueue()
  const id = 'DQ-20261111-100000-bbbb'
  putItem(dir, id)
  const host = mockHost({ results: RESULTS, storage: { config: { dir, handleFile: join(dir, 'missing'), open: 'none' } } })
  const worker = await mountWorker(main, { host })
  const view = await worker.request('queue.answer', { id, verdict: 'approve' })
  assert.equal(view.cards[0].answer?.relayed, false)
  assert.deepEqual(host.callsOf('terminal.sendText'), [])
  await worker.deactivate()
})

test('a new waiting item is announced once and counted in the status bar', async () => {
  const { dir, handleFile } = setupQueue()
  putItem(dir, 'DQ-20261111-100000-cccc')
  const host = mockHost({ results: RESULTS, storage: { config: { dir, handleFile, open: 'none' } } })
  const worker = await mountWorker(main, { host })
  await worker.request('queue.list')
  await worker.request('queue.list')

  const shown = host.callsOf('notifications.show') as { title: string; body?: string }[]
  assert.equal(shown.length, 1)
  assert.ok(shown[0].title.includes('Sample Shop'))
  const bars = host.callsOf('statusBar.update') as { id: string; text?: string }[]
  assert.equal(bars.at(-1)?.text, '결정 1')
  await worker.deactivate()

  // A restarted worker remembers what it already announced.
  const again = await mountWorker(main, { host: mockHost({ results: RESULTS, storage: host.data().storage as never }) })
  await again.request('queue.list')
  await again.deactivate()
  assert.equal(host.callsOf('notifications.show').length, 1)
})

test('evidence is opened through the configured opener only', async () => {
  const { dir, handleFile } = setupQueue()
  const id = 'DQ-20261111-100000-dddd'
  putItem(dir, id, { evidence: [{ label: 'deck', path: '/tmp/dq-evidence/deck.pdf' }] })
  const host = mockHost({ results: RESULTS, storage: { config: { dir, handleFile, open: 'none' } } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('evidence.open', { id, index: 0 }), { mode: 'open' })
  await assert.rejects(worker.request('evidence.open', { id, index: 5 }))
  await worker.deactivate()
})

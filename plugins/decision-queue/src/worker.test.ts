// Runs src/worker.ts's activate(orca) over a mock host and a temporary queue folder.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'

const RESULTS = {
  'notifications.show': { delivered: true },
  'statusBar.update': { ok: true }
}
const WORKSPACE = '/w/orca'

type Queue = { dir: string; handleFile: string; log: string; config: Record<string, string> }

/** A temporary queue, a handle file, and a stand-in `orca` that lists `terminals` and logs each send. */
function setupQueue(terminals: { handle: string; title: string }[] = [{ handle: 'term_test-agent', title: '◐ 류드' }]): Queue {
  const root = mkdtempSync(join(tmpdir(), 'dq-worker-'))
  const dir = join(root, 'decisions')
  mkdirSync(dir)
  const handleFile = join(root, 'handle')
  writeFileSync(handleFile, 'term_test-agent\n')
  const list = join(root, 'list.json')
  const rows = terminals.map((t) => ({ ...t, worktreePath: WORKSPACE, connected: true, writable: true, agentIdentity: 'claude' }))
  writeFileSync(list, JSON.stringify({ ok: true, result: { terminals: rows } }))
  const log = join(root, 'sent.log')
  const orcaBin = join(root, 'orca')
  writeFileSync(
    orcaBin,
    `#!/bin/sh\nif [ "$1 $2" = "terminal list" ]; then cat '${list}'; exit 0; fi\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n` +
      `echo '{"ok":true,"result":{"send":{"accepted":true}}}'\n`,
    { mode: 0o755 }
  )
  return { dir, handleFile, log, config: { dir, handleFile, open: 'none', orcaBin, workspace: WORKSPACE, agentTitle: '류드' } }
}

const sentArgs = (q: Queue): string[] => (existsSync(q.log) ? readFileSync(q.log, 'utf8').trim().split('\n') : [])

function putItem(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, id), { recursive: true })
  const item = { id, createdAt: '2026-11-11T10:00:00+09:00', project: 'Sample Shop', kind: 'approve', title: 'Deploy the staging build', ...extra }
  writeFileSync(join(dir, id, 'item.json'), JSON.stringify(item))
}

test('before setup it reads no folder and types into no terminal', async () => {
  const host = mockHost({ results: RESULTS })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('queue.list'), { configured: false, cards: [], invalid: [] })
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
      open: 'system',
      orcaBin: '/Applications/Orca.app/Contents/Resources/bin/orca',
      workspace: join(home, 'orca'),
      agentTitle: '류드'
    })
    assert.ok(existsSync(join(home, '.local/state/ryude/decisions')))
    await worker.deactivate()
  } finally {
    process.env.HOME = before
  }
})

test('an answer is written, the agent terminal gets only the id, and panels hear it', async () => {
  const q = setupQueue()
  const id = 'DQ-20261111-100000-aaaa'
  putItem(q.dir, id)
  const host = mockHost({ results: RESULTS, storage: { config: q.config } })
  const worker = await mountWorker(main, { host })

  const view = await worker.request('queue.answer', { id, verdict: 'approve' })
  assert.equal(view.cards[0].status, 'answered')
  assert.equal(view.cards[0].answer?.relayed, true)

  const args = sentArgs(q)
  assert.deepEqual(args.slice(0, 4), ['terminal', 'send', '--terminal', 'term_test-agent'])
  assert.ok(args.includes('--enter'))
  const text = args[args.indexOf('--text') + 1]
  assert.ok(text.includes(id))
  assert.ok(!text.includes('approve'), 'the verdict stays in the file')

  const onDisk = JSON.parse(readFileSync(join(q.dir, id, 'answer.json'), 'utf8'))
  assert.equal(onDisk.relayed, true)
  assert.ok(worker.posts.some((p) => p.event === 'queue.changed'))
  await worker.deactivate()
})

test('a changed terminal id is found by the agent name in its workspace', async () => {
  const q = setupQueue([{ handle: 'term_after-restart', title: '✳ 류드' }])
  const id = 'DQ-20261111-100000-eeee'
  putItem(q.dir, id)
  const host = mockHost({ results: RESULTS, storage: { config: q.config } })
  const worker = await mountWorker(main, { host })
  const view = await worker.request('queue.answer', { id, verdict: 'approve' })
  assert.equal(view.cards[0].answer?.relayed, true)
  assert.equal(sentArgs(q)[3], 'term_after-restart')
  await worker.deactivate()
})

test('no single agent terminal leaves the answer marked unrelayed', async () => {
  const q = setupQueue([
    { handle: 'term_1', title: '◐ 류드' },
    { handle: 'term_2', title: '✳ 류드' }
  ])
  writeFileSync(q.handleFile, 'term_gone\n')
  const id = 'DQ-20261111-100000-bbbb'
  putItem(q.dir, id)
  const host = mockHost({ results: RESULTS, storage: { config: q.config } })
  const worker = await mountWorker(main, { host })
  const view = await worker.request('queue.answer', { id, verdict: 'approve' })
  assert.equal(view.cards[0].answer?.relayed, false)
  assert.deepEqual(sentArgs(q), [])
  await worker.deactivate()
})

test('a new waiting item is announced once and counted in the status bar', async () => {
  const q = setupQueue()
  putItem(q.dir, 'DQ-20261111-100000-cccc')
  const host = mockHost({ results: RESULTS, storage: { config: q.config } })
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
  const q = setupQueue()
  const id = 'DQ-20261111-100000-dddd'
  putItem(q.dir, id, { evidence: [{ label: 'deck', path: '/tmp/dq-evidence/deck.pdf' }] })
  const host = mockHost({ results: RESULTS, storage: { config: q.config } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('evidence.open', { id, index: 0 }), { mode: 'open' })
  await assert.rejects(worker.request('evidence.open', { id, index: 5 }))
  await worker.deactivate()
})

// The plugin's worker. With a status bar item it runs for as long as the plugin is enabled, so it
// can watch the queue folder and announce new items even while the panel is closed.
// Nothing is read, typed or opened until the person presses setup in the panel (README.md).
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { AnswerInput, QueueView } from './protocol'
import { evidenceTarget, loadQueue, markRelayed, writeAnswer } from './queue'
import { relayAnswer, type RelayConfig } from './relay'

type Config = RelayConfig & { dir: string; open: 'system' | 'none' }
const CONFIG = 'config'
const NOTIFIED = 'notified'
const BAR = 'waiting'

let watcher: FSWatcher | undefined
let timer: ReturnType<typeof setTimeout> | undefined

/** This Mac's defaults; setup stores them, and a config saved before a field existed gets it here. */
function defaults(): Config {
  const home = process.env.HOME ?? ''
  return {
    dir: join(home, '.local/state/ryude/decisions'),
    handleFile: join(home, '.config/ryude/handle'),
    open: 'system',
    orcaBin: '/Applications/Orca.app/Contents/Resources/bin/orca',
    workspace: join(home, 'orca'),
    agentTitle: '류드'
  }
}

async function config(orca: OrcaWorkerApi): Promise<Config | null> {
  const value = (await orca.storage.get(CONFIG)) as Partial<Config> | null
  return value && typeof value.dir === 'string' ? { ...defaults(), ...value } : null
}

/** Reads the queue, then updates the status bar and announces items not announced before. */
async function scan(orca: OrcaWorkerApi): Promise<QueueView> {
  const cfg = await config(orca)
  if (!cfg) return { configured: false, cards: [], invalid: [] }
  const { cards, invalid } = loadQueue(cfg.dir)
  const waiting = cards.filter((c) => c.status === 'open')
  await orca.host.call('statusBar.update', {
    id: BAR,
    text: `결정 ${waiting.length}`,
    tone: waiting.length ? 'warning' : 'neutral',
    visible: true
  })
  const seen = new Set(((await orca.storage.get(NOTIFIED)) as string[] | null) ?? [])
  const fresh = waiting.filter((c) => !seen.has(c.item.id))
  for (const card of fresh) {
    await orca.host.call('notifications.show', { title: `결정 대기 · ${card.item.project}`, body: card.item.title })
    seen.add(card.item.id)
  }
  if (fresh.length) {
    const live = new Set(cards.map((c) => c.item.id))
    await orca.storage.set(NOTIFIED, [...seen].filter((id) => live.has(id)))
  }
  return { configured: true, cards, invalid }
}

async function broadcast(orca: OrcaWorkerApi): Promise<QueueView> {
  const view = await scan(orca)
  orca.panels.post('queue.changed', view)
  return view
}

async function startWatching(orca: OrcaWorkerApi): Promise<void> {
  const cfg = await config(orca)
  if (!cfg || watcher) return
  mkdirSync(cfg.dir, { recursive: true })
  // unref: Orca's own channel keeps the worker alive; the watch alone must not (tests end cleanly).
  watcher = watch(cfg.dir, { recursive: true }, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void broadcast(orca).catch((e) => orca.log(`scan failed: ${e}`)), 300)
    timer.unref()
  })
  watcher.unref()
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  orca.panels.handle('queue.list', () => scan(orca))

  orca.panels.handle('config.setup', async () => {
    const cfg = defaults()
    mkdirSync(cfg.dir, { recursive: true })
    await orca.storage.set(CONFIG, cfg)
    await startWatching(orca)
    return broadcast(orca)
  })

  orca.panels.handle('queue.answer', async (input: AnswerInput) => {
    const cfg = await config(orca)
    if (!cfg) throw Object.assign(new Error('set up the queue first'), { code: 'conflict' })
    writeAnswer(cfg.dir, input)
    markRelayed(cfg.dir, input.id, await relayAnswer(cfg, input.id, (m) => orca.log(m)))
    return broadcast(orca)
  })

  orca.panels.handle('evidence.open', async ({ id, index }) => {
    const cfg = await config(orca)
    if (!cfg) throw Object.assign(new Error('set up the queue first'), { code: 'conflict' })
    const target = evidenceTarget(cfg.dir, id, index)
    if (cfg.open === 'system') {
      const args = target.mode === 'open' ? [target.path] : ['-R', target.path]
      execFile('/usr/bin/open', args, (err) => err && orca.log(`open failed: ${err.message}`))
    }
    return { mode: target.mode }
  })

  await startWatching(orca)
  await scan(orca).catch((e) => orca.log(`first scan failed: ${e}`))
}

export function deactivate(): void {
  if (timer) clearTimeout(timer)
  watcher?.close()
  watcher = undefined
}

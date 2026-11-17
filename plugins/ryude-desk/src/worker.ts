// The plugin's worker. With a status bar item it runs for as long as the plugin is enabled, so it
// can watch the queue folder and announce new items even while the panel is closed.
// Nothing is read, typed or copied until the person presses setup in the panel (README.md).
import type { OrcaWorkerApi } from 'orca/worker'
import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { AnswerInput, QueueView } from './protocol'
import { copyFile } from './launch'
import { evidenceFile, loadQueue, markRelayed, writeAnswer } from './queue'
import { relayAnswer, type RelayConfig } from './relay'

/** open: 'none' runs no macOS tool, so copying leaves the clipboard alone (tests and check). */
type Config = RelayConfig & { dir: string; open: 'system' | 'none'; osascript: string }
const CONFIG = 'config'
const NOTIFIED = 'notified'
const BAR = 'waiting'

let watcher: FSWatcher | undefined
let timer: ReturnType<typeof setTimeout> | undefined
/** One answer at a time per item, so two presses cannot both write and both relay. */
const busy = new Map<string, Promise<unknown>>()

function oneAtATime<T>(id: string, work: () => Promise<T>): Promise<T> {
  const next = (busy.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
  busy.set(id, next)
  return next.finally(() => {
    if (busy.get(id) === next) busy.delete(id)
  })
}

/** This Mac's defaults; setup stores them, and a config saved before a field existed gets it here. */
function defaults(): Config {
  const home = process.env.HOME ?? ''
  return {
    dir: join(home, '.local/state/ryude/decisions'),
    handleFile: join(home, '.config/ryude/handle'),
    open: 'system',
    orcaBin: '/Applications/Orca.app/Contents/Resources/bin/orca',
    workspace: join(home, 'orca'),
    agentTitle: '류드',
    osascript: '/usr/bin/osascript'
  }
}

async function config(orca: OrcaWorkerApi): Promise<Config | null> {
  const value = (await orca.storage.get(CONFIG)) as Partial<Config> | null
  return value && typeof value.dir === 'string' ? { ...defaults(), ...value } : null
}

async function configured(orca: OrcaWorkerApi): Promise<Config> {
  const cfg = await config(orca)
  if (!cfg) throw Object.assign(new Error('set up the queue first'), { code: 'conflict' })
  return cfg
}

/** Reads the queue, then updates the status bar and announces items not announced before. */
async function scan(orca: OrcaWorkerApi): Promise<QueueView> {
  const cfg = await config(orca)
  if (!cfg) return { configured: false, cards: [], invalid: [] }
  const { cards, invalid } = loadQueue(cfg.dir)
  const waiting = cards.filter((c) => c.status === 'open')
  await orca.host.call('statusBar.update', {
    id: BAR,
    text: `결재 ${waiting.length}`,
    tone: waiting.length ? 'warning' : 'neutral',
    visible: true
  })
  const seen = new Set(((await orca.storage.get(NOTIFIED)) as string[] | null) ?? [])
  const fresh = waiting.filter((c) => !seen.has(c.item.id))
  for (const card of fresh) {
    await orca.host.call('notifications.show', { title: card.item.project, body: card.item.title })
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
    const cfg = await configured(orca)
    return oneAtATime(input.id, async () => {
      const { changed } = writeAnswer(cfg.dir, input)
      if (changed) markRelayed(cfg.dir, input.id, await relayAnswer(cfg, input.id, (m) => orca.log(m)))
      return broadcast(orca)
    })
  })

  // copied is false when the worker is set to launch nothing (open: 'none').
  orca.panels.handle('evidence.copy', async ({ id, index }) => {
    const cfg = await configured(orca)
    const path = evidenceFile(cfg.dir, id, index)
    if (cfg.open !== 'system') return { copied: false }
    await copyFile(cfg.osascript, path)
    return { copied: true }
  })

  await startWatching(orca)
  await scan(orca).catch((e) => orca.log(`first scan failed: ${e}`))
}

export function deactivate(): void {
  if (timer) clearTimeout(timer)
  watcher?.close()
  watcher = undefined
}

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { DEFAULT_STATE_FILE } from './serve.mjs'

const run = promisify(execFile)

export function resolveOrcaCli() {
  // ponytail: macOS layout only; add Linux/Windows resolution when someone runs it there
  const packaged = join(dirname(process.execPath), '..', 'Resources', 'bin', 'orca')
  return existsSync(packaged) ? packaged : 'orca'
}

async function cli(args) {
  const { stdout } = await run(resolveOrcaCli(), args, { timeout: 15000 })
  const response = JSON.parse(stdout)
  if (response.ok === false) {
    throw new Error(response.error?.message ?? JSON.stringify(response.error ?? response))
  }
  if (response.result?.ok === false) {
    throw new Error(response.result.error?.message ?? JSON.stringify(response.result.error ?? response.result))
  }
  return response.result
}

export async function resolveWorktree(ctx, log = console.log) {
  if (!ctx) throw new Error('no focused worktree')
  const { terminals } = await cli(['terminal', 'list', '--json'])
  const ids = new Set(ctx.terminals.map(({ id }) => id))
  for (const terminal of terminals) {
    const field = ['handle', 'ptyId'].find((key) => ids.has(terminal[key]))
    if (field) {
      log(`[Git Log Graph] terminal ${field} matched context id: ${terminal[field]}`)
      if (!terminal.worktreeId || !terminal.worktreePath) {
        throw new Error('matched terminal has no worktree id or path')
      }
      return { worktreeId: terminal.worktreeId, worktreePath: terminal.worktreePath }
    }
  }
  if (ids.size) throw new Error('no terminal matches the focused worktree context')

  const { worktrees } = await cli(['worktree', 'list', '--json'])
  const candidates = worktrees.filter((worktree) =>
    worktree.displayName === ctx.displayName && worktree.branch.endsWith(ctx.branch))
  if (candidates.length !== 1) {
    throw new Error(`expected one worktree for ${ctx.displayName} (${ctx.branch}); candidates: ${JSON.stringify(candidates.map(({ id, path, branch }) => ({ id, path, branch })))}`)
  }
  const [{ id, path }] = candidates
  if (!id || !path) throw new Error('matched worktree has no id or path')
  return { worktreeId: id, worktreePath: path }
}

const pluginRoot = fileURLToPath(new URL('.', import.meta.url))

export async function ensureServer() {
  const healthyPort = async (timeout = 1000) => {
    try {
      const { port, pid } = JSON.parse(await readFile(DEFAULT_STATE_FILE, 'utf8'))
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid)) return
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeout) })
      const health = await response.json()
      if (!response.ok || health.ok !== true || health.pid !== pid) return
      // A server left over from a previous plugin version serves that version's files; replace it.
      if (health.root !== pluginRoot) {
        try { process.kill(pid) } catch {}
        return
      }
      return port
    } catch {}
  }
  const port = await healthyPort()
  if (port) return port
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const port = await healthyPort(Math.max(1, Math.min(1000, deadline - Date.now())))
    if (port) return port
    await delay(Math.max(0, Math.min(100, deadline - Date.now())))
  }
  throw new Error('Git Log Graph server did not become healthy within 5 seconds')
}

async function registerGraph(worktreePath) {
  const port = await ensureServer()
  const base = `http://127.0.0.1:${port}`
  const registered = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: worktreePath })
  })
  const registration = await registered.json()
  if (!registered.ok) throw new Error(registration.error)
  const url = `${base}/?repo=${registration.id}`
  const response = await fetch(`${base}/data?repo=${registration.id}`)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error)
  return { url, repos: data.repos.length }
}

export async function openInOrca(url, worktreeId) {
  const worktree = `id:${worktreeId}`
  // `tab list --worktree id:<x>` blocks ~8s when that worktree has no browser tab; `all` returns in ~0.15s.
  const { tabs } = await cli(['tab', 'list', '--worktree', 'all', '--json'])
  const existing = tabs.find((tab) => tab.url === url && tab.worktreeId === worktreeId)
  if (existing) {
    if (!existing.browserPageId) throw new Error('existing graph tab has no browser page id')
    return cli(['goto', '--url', url, '--page', existing.browserPageId, '--json'])
  }
  return cli(['tab', 'create', '--url', url, '--worktree', worktree, '--json'])
}

export default function activate(orca) {
  orca.commands.register('open-graph', async () => {
    try {
      const ctx = await orca.host.call('workspace.readContext')
      const { worktreeId, worktreePath } = await resolveWorktree(ctx, (message) => orca.log(message))
      const { url, repos } = await registerGraph(worktreePath)
      await openInOrca(url, worktreeId)
      return { ok: true, url, worktreePath, repos }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      try {
        await orca.host.call('notifications.show', { title: 'Git Log Graph', body: error.slice(0, 1000) })
      } catch (notificationError) {
        console.error('[Git Log Graph] notification failed:', notificationError)
      }
      return { ok: false, error }
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.deepEqual(process.argv.slice(2), ['--dry-run'], 'usage: node main.mjs --dry-run')
    console.log(`Orca CLI: ${resolveOrcaCli()}`)
    const { terminals } = await cli(['terminal', 'list', '--json'])
    const first = terminals[0]
    assert.ok(first?.handle, 'Orca must have at least one terminal')
    const ctx = {
      displayName: first.displayName ?? basename(first.worktreePath),
      branch: first.branch,
      terminals: [{ id: first.handle }]
    }
    const resolved = await resolveWorktree(ctx)
    assert.equal(resolved.worktreeId, first.worktreeId)
    assert.equal(resolved.worktreePath, first.worktreePath)
    console.log(resolved.worktreePath)
    const { url, repos } = await registerGraph(resolved.worktreePath)
    console.log(`${url}\n${repos} repos`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

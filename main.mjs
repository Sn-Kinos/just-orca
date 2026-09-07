import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

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

export async function openInOrca(file, worktreeId) {
  const url = pathToFileURL(file).href
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
      // Load on invocation so discovery and --dry-run work before the renderer is installed.
      const { buildGitLogHtml } = await import('./viz.mjs')
      const html = await buildGitLogHtml(worktreePath, { limit: 500 })
      const directory = join(tmpdir(), 'orca-git-log-graph')
      const file = join(directory, `${createHash('sha1').update(worktreePath).digest('hex')}.html`)
      await mkdir(directory, { recursive: true })
      await writeFile(file, html, 'utf8')
      await openInOrca(file, worktreeId)
      // The renderer emits one section per repository, including uninitialized submodules.
      return { ok: true, file, worktreePath, repos: (html.match(/<section\b/gi) ?? []).length }
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
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

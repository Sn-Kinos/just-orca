// Tells the agent's terminal that an item has an answer, through the Orca CLI.
// The plugin host's terminal.sendText only reaches the focused workspace, and the agent usually
// lives in another one, so the worker runs `orca terminal send`, which queues the line while the
// agent is busy. The terminal is found again every time: the handle file, else by name.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export type TerminalRow = {
  handle: string
  title?: string | null
  worktreePath?: string | null
  connected?: boolean
  writable?: boolean
  agentIdentity?: string | null
}
export type Pick = { handle: string; how: 'handle-file' | 'title' } | { error: string }
export type RelayConfig = { handleFile: string; orcaBin: string; workspace: string; agentTitle: string }

const live = (t: TerminalRow) => t.connected === true && t.writable === true && !!t.agentIdentity
/** "◐ 류드" -> "류드": the agent status glyph Orca puts before the title is not part of the name. */
const nameOf = (title: string | null | undefined) => (title ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim()

export function pickTerminal(rows: TerminalRow[], fromFile: string | null, want: { workspace: string; title: string }): Pick {
  if (fromFile) {
    const named = rows.find((t) => t.handle === fromFile)
    if (named && live(named)) return { handle: named.handle, how: 'handle-file' }
  }
  const candidates = rows.filter((t) => live(t) && t.worktreePath === want.workspace && nameOf(t.title) === want.title)
  if (candidates.length === 1) return { handle: candidates[0].handle, how: 'title' }
  return {
    error: candidates.length
      ? `${candidates.length} terminals named ${want.title} in ${want.workspace}`
      : `no live terminal named ${want.title} in ${want.workspace}`
  }
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  )
}

/** True when Orca accepted the line into the agent's terminal; `log` hears why when not. */
export async function relayAnswer(cfg: RelayConfig, id: string, log: (message: string) => void): Promise<boolean> {
  try {
    if (!existsSync(cfg.orcaBin)) throw new Error(`orca CLI not found at ${cfg.orcaBin}`)
    const listed = JSON.parse(await run(cfg.orcaBin, ['terminal', 'list', '--json']))
    const rows: TerminalRow[] = listed?.result?.terminals ?? []
    const fromFile = existsSync(cfg.handleFile) ? readFileSync(cfg.handleFile, 'utf8').trim() || null : null
    const pick = pickTerminal(rows, fromFile, { workspace: cfg.workspace, title: cfg.agentTitle })
    if ('error' in pick) throw new Error(pick.error)
    const text = `[결정 대기] ${id} 답 있음. 답 파일을 직접 읽고 처리해 줘.`
    const sent = JSON.parse(await run(cfg.orcaBin, ['terminal', 'send', '--terminal', pick.handle, '--text', text, '--enter', '--json']))
    const accepted = sent?.ok === true && sent?.result?.send?.accepted === true
    log(`relay ${id} -> ${pick.handle} (${pick.how}): ${accepted ? 'accepted' : 'refused'}`)
    return accepted
  } catch (e) {
    log(`relay failed for ${id}: ${(e as Error).message}`)
    return false
  }
}

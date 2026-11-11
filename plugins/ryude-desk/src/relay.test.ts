// Which terminal gets the "[류드 결재함] <id> 답 있음" line, from `orca terminal list --json` rows.
import { assert, test } from 'orca/testing'
import { pickTerminal, type TerminalRow } from './relay'

const row = (over: Partial<TerminalRow>): TerminalRow => ({
  handle: 'term_a',
  title: '◐ 류드',
  worktreePath: '/Users/me/orca',
  connected: true,
  writable: true,
  agentIdentity: 'claude',
  ...over
})
const want = { workspace: '/Users/me/orca', title: '류드' }

test('the handle file wins while that terminal is alive', () => {
  const rows = [row({ handle: 'term_a' }), row({ handle: 'term_b', title: '✳ 류드' })]
  assert.deepEqual(pickTerminal(rows, 'term_b', want), { handle: 'term_b', how: 'handle-file' })
})

test('a stale handle falls back to the one agent terminal named for the agent in its workspace', () => {
  const rows = [
    row({ handle: 'term_new', title: '✻ 류드' }),
    row({ handle: 'term_other', title: '류드 메모', agentIdentity: 'claude' }),
    row({ handle: 'term_elsewhere', worktreePath: '/Users/me/other' }),
    row({ handle: 'term_shell', agentIdentity: null }),
    row({ handle: 'term_gone', connected: false })
  ]
  assert.deepEqual(pickTerminal(rows, 'term_old', want), { handle: 'term_new', how: 'title' })
  assert.deepEqual(pickTerminal(rows, null, want), { handle: 'term_new', how: 'title' })
})

test('a dead or read-only handle-file terminal is not used', () => {
  const rows = [row({ handle: 'term_a', connected: false }), row({ handle: 'term_b' })]
  assert.deepEqual(pickTerminal(rows, 'term_a', want), { handle: 'term_b', how: 'title' })
  assert.deepEqual(pickTerminal([row({ handle: 'term_a', writable: false })], 'term_a', want), {
    error: 'no live terminal named 류드 in /Users/me/orca'
  })
})

test('two candidates are never guessed between', () => {
  const rows = [row({ handle: 'term_1' }), row({ handle: 'term_2', title: '✳ 류드' })]
  assert.deepEqual(pickTerminal(rows, null, want), { error: '2 terminals named 류드 in /Users/me/orca' })
})

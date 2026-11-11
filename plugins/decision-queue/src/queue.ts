// The queue folder, as README.md describes it: one folder per item, one writer per file.
// This module only reads item.json and state.json, and only writes answer.json.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import type { Answer, AnswerInput, Card, Invalid, Item, Kind, Status, Verdict } from './protocol'

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const KINDS: Record<Kind, Verdict[]> = {
  approve: ['approve', 'reject', 'instruct'],
  decide: ['choose', 'instruct'],
  review: ['accept', 'revise', 'instruct'],
  'send-ready': ['sent', 'revise', 'instruct']
}
const NEEDS_NOTE: Verdict[] = ['reject', 'revise', 'instruct']
const OPENABLE = new Set(
  'mp4 mov m4v png jpg jpeg gif webp heic pdf txt md csv html json docx xlsx pptx hwp hwpx'.split(' ')
)
const DONE_SHOWN = 10

export const hashOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, path)
}

function checkId(id: string): void {
  if (!ID.test(id)) throw Object.assign(new Error(`bad item id: ${id}`), { code: 'invalid_params' })
}

const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** The reason an item cannot be shown, or null. */
function problem(id: string, item: Record<string, unknown>): string | null {
  if (item.id !== id) return 'id does not match the folder name'
  for (const key of ['createdAt', 'project', 'title'] as const) if (!str(item[key])) return `${key} is missing`
  if (!(String(item.kind) in KINDS)) return `unknown kind: ${String(item.kind)}`
  if (item.kind === 'decide' && !(Array.isArray(item.options) && item.options.length >= 2 && item.options.every(str)))
    return 'decide needs at least two options'
  if (item.kind === 'send-ready' && !(str(item.draft) && str(item.sender))) return 'send-ready needs draft and sender'
  if (item.evidence !== undefined && !(Array.isArray(item.evidence) && item.evidence.every((e) => e && str(e.label) && str(e.path))))
    return 'evidence must be a list of { label, path }'
  return null
}

function readItem(dir: string, id: string): { item: Item; hash: string } {
  checkId(id)
  const path = join(dir, id, 'item.json')
  if (!existsSync(path)) throw Object.assign(new Error(`no item ${id}`), { code: 'not_found' })
  const bytes = readFileSync(path)
  const item = JSON.parse(bytes.toString('utf8'))
  const why = problem(id, item)
  if (why) throw Object.assign(new Error(`item ${id}: ${why}`), { code: 'invalid_params' })
  return { item, hash: hashOf(bytes) }
}

function readState(dir: string, id: string): { status?: string; note?: string } {
  return (readJson(join(dir, id, 'state.json')) as { status?: string; note?: string }) ?? {}
}

export function loadQueue(dir: string): { cards: Card[]; invalid: Invalid[] } {
  const cards: Card[] = []
  const invalid: Invalid[] = []
  const ids = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && ID.test(d.name)).map((d) => d.name) : []
  for (const id of ids) {
    try {
      const { item, hash } = readItem(dir, id)
      const state = readState(dir, id)
      const answer = readJson(join(dir, id, 'answer.json')) as Answer | undefined
      const current = answer && answer.itemHash === hash ? answer : undefined
      const status: Status =
        state.status === 'done' ? 'done' : state.status === 'taken' ? 'taken' : current ? 'answered' : 'open'
      const card: Card = { item, status }
      if (current) card.answer = current
      if (answer && !current) card.stale = true
      if (str(state.note)) card.stateNote = state.note
      cards.push(card)
    } catch (e) {
      invalid.push({ id, reason: (e as Error).message })
    }
  }
  cards.sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt))
  const done = cards.filter((c) => c.status === 'done').slice(DONE_SHOWN)
  return { cards: cards.filter((c) => !done.includes(c)), invalid }
}

export function writeAnswer(dir: string, input: AnswerInput, now = new Date()): Answer {
  const { item, hash } = readItem(dir, input.id)
  const state = readState(dir, input.id)
  if (state.status === 'taken' || state.status === 'done')
    throw Object.assign(new Error(`${input.id} is already ${state.status}; the answer can no longer change`), { code: 'conflict' })
  if (!KINDS[item.kind].includes(input.verdict))
    throw Object.assign(new Error(`verdict ${input.verdict} does not fit a ${item.kind} item`), { code: 'invalid_params' })
  const note = input.note?.trim() ?? ''
  if (NEEDS_NOTE.includes(input.verdict) && !note)
    throw Object.assign(new Error(`verdict ${input.verdict} needs a note`), { code: 'invalid_params' })
  if (input.verdict === 'choose' && !item.options?.includes(input.choice ?? ''))
    throw Object.assign(new Error(`choice must be one of the options`), { code: 'invalid_params' })
  const answer: Answer = { itemHash: hash, verdict: input.verdict, at: now.toISOString(), relayed: false }
  if (input.verdict === 'choose') answer.choice = input.choice
  if (note) answer.note = note
  writeJson(join(dir, input.id, 'answer.json'), answer)
  return answer
}

export function markRelayed(dir: string, id: string, relayed: boolean): void {
  checkId(id)
  const path = join(dir, id, 'answer.json')
  const answer = readJson(path) as Answer | undefined
  if (answer) writeJson(path, { ...answer, relayed })
}

export function evidenceTarget(dir: string, id: string, index: number): { path: string; mode: 'open' | 'reveal' } {
  const { item } = readItem(dir, id)
  const entry = item.evidence?.[index]
  if (!entry) throw Object.assign(new Error(`no evidence ${index} on ${id}`), { code: 'not_found' })
  if (!isAbsolute(entry.path)) throw Object.assign(new Error(`evidence path must be absolute: ${entry.path}`), { code: 'invalid_params' })
  const isDir = existsSync(entry.path) && statSync(entry.path).isDirectory()
  const ext = extname(entry.path).slice(1).toLowerCase()
  return { path: entry.path, mode: !isDir && OPENABLE.has(ext) ? 'open' : 'reveal' }
}

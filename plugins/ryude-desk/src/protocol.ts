// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// The file layout behind it is described in README.md.
export {}

export type Kind = 'approve' | 'decide' | 'review' | 'send-ready'
export type Verdict = 'approve' | 'reject' | 'choose' | 'accept' | 'revise' | 'sent' | 'instruct' | 'dismiss'
export type Status = 'open' | 'answered' | 'taken' | 'done'

export type Evidence = { label: string; path: string }
export type Item = {
  id: string
  createdAt: string
  project: string
  kind: Kind
  title: string
  body?: string
  proposal?: string
  options?: string[]
  evidence?: Evidence[]
  draft?: string
  sender?: string
}
export type Answer = {
  itemHash: string
  verdict: Verdict
  choice?: string
  note?: string
  at: string
  /** null while the worker is still telling the agent; then true or false. */
  relayed: boolean | null
}
export type Card = {
  item: Item
  status: Status
  /** Present when status is answered, taken or done. */
  answer?: Answer
  /** An answer was given to an earlier version of this item; it no longer counts. */
  stale?: boolean
  stateNote?: string
}
export type Invalid = { id: string; reason: string }
export type QueueView = { configured: boolean; cards: Card[]; invalid: Invalid[] }
/** One entry of an item's evidence list; the panel never sends a path. */
export type EvidenceRef = { id: string; index: number }
export type AnswerInput = { id: string; verdict: Verdict; choice?: string; note?: string }

declare module 'orca' {
  interface PluginRequests {
    /** Saves the default folder and terminal for this Mac; nothing is read before this. */
    'config.setup': { output: QueueView }
    /** Every card, newest first. */
    'queue.list': { output: QueueView }
    /** Writes the person's answer, then tells the agent's terminal the item id. */
    'queue.answer': { input: AnswerInput; output: QueueView }
    /** Puts the file itself on the clipboard (public.file-url), as Finder's Copy does. */
    'evidence.copy': { input: EvidenceRef; output: { copied: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after the folder changes or an answer is written. */
    'queue.changed': QueueView
  }
}

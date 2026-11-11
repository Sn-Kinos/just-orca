// The sidebar. It never touches files: every read and write goes through the worker.
import {
  atom,
  Badge,
  Button,
  Card,
  EmptyState,
  Heading,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import type { Card as QueueCard, Kind, QueueView, Verdict } from './protocol'

const queue = atom<QueueView | null>(null)
const notes = atom<Record<string, string>>({})
const errors = atom<Record<string, string>>({})
/** Cards whose answer is on its way to the worker; their buttons are off until it returns. */
const sending = atom<Record<string, boolean>>({})
const RELAY_GRACE_MS = 30_000
/** How often an open panel reads the queue itself, in case a worker post never arrived. */
export const POLL_MS = 5_000
const showDone = atom(false)

const KIND: Record<Kind, string> = { approve: '승인 요청', decide: '결정', review: '검토', 'send-ready': '발송 준비' }
const VERDICT: Record<Verdict, string> = {
  approve: '승인',
  reject: '반려',
  choose: '선택',
  accept: '받아들임',
  revise: '고쳐 줘',
  sent: '보냈음',
  instruct: '지시'
}
const BUTTONS: Record<Kind, Verdict[]> = {
  approve: ['approve', 'reject'],
  decide: [],
  review: ['accept', 'revise'],
  'send-ready': ['sent', 'revise']
}
const NEEDS_NOTE: Verdict[] = ['reject', 'revise', 'instruct']

/** Local month/day hour:minute; answers are stored in UTC, items usually with an offset. */
const when = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function setError(id: string, message: string): void {
  update(errors, (all) => ({ ...all, [id]: message }))
}

async function answer(id: string, verdict: Verdict, choice?: string): Promise<void> {
  const note = (read(notes)[id] ?? '').trim()
  if (NEEDS_NOTE.includes(verdict) && !note) {
    setError(id, `${VERDICT[verdict]}에는 한 줄 지시를 적어 주세요.`)
    return
  }
  if (read(sending)[id]) return
  setError(id, '')
  update(sending, (all) => ({ ...all, [id]: true }))
  try {
    const input = { id, verdict, ...(choice !== undefined ? { choice } : {}), ...(note ? { note } : {}) }
    set(queue, await plugin.request('queue.answer', input))
  } catch (e) {
    setError(id, String((e as Error).message ?? e))
  } finally {
    update(sending, (all) => ({ ...all, [id]: false }))
  }
}

/** What the card says about telling the agent; null right after an answer means it is on its way. */
function relayText(answer: { relayed: boolean | null; at: string }): { text: string; warn: boolean } | null {
  if (answer.relayed === true) return null
  if (answer.relayed === null && Date.now() - new Date(answer.at).getTime() < RELAY_GRACE_MS) return { text: '류드에게 알리는 중…', warn: false }
  return { text: '류드에게 알리지 못함', warn: true }
}

async function openEvidence(id: string, index: number): Promise<void> {
  try {
    await plugin.request('evidence.open', { id, index })
  } catch (e) {
    setError(id, String((e as Error).message ?? e))
  }
}

export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(plugin.on('queue.changed', (view) => set(queue, view)))
  const refresh = () => void plugin.request('queue.list').then((view) => set(queue, view)).catch(() => undefined)
  refresh()
  // Worker posts can stop reaching a panel that was open across a plugin reinstall; reading the
  // queue again while visible keeps the cards right whatever happened to the posts.
  const poll = setInterval(() => read(ctx.visible) && refresh(), POLL_MS)
  return () => clearInterval(poll)
}

function Answers({ card }: { card: QueueCard }) {
  const { id, kind, options } = card.item
  const locked = !!read(sending)[id]
  const current = card.answer
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        {[
          ...(kind === 'decide' ? options ?? [] : []).map((option, i) => (
            <Button key={`choose-${id}-${i}`} variant={current?.choice === option ? 'solid' : 'outline'} disabled={locked || current?.choice === option} onPress={() => answer(id, 'choose', option)}>
              {option}
            </Button>
          )),
          ...BUTTONS[kind].map((verdict) => (
            <Button
              key={`${verdict}-${id}`}
              variant={NEEDS_NOTE.includes(verdict) ? 'outline' : 'solid'}
              tone={verdict === 'reject' ? 'danger' : undefined}
              disabled={locked || (current?.verdict === verdict && !NEEDS_NOTE.includes(verdict))}
              onPress={() => answer(id, verdict)}
            >
              {VERDICT[verdict]}
            </Button>
          )),
          <Button key={`instruct-${id}`} variant="ghost" disabled={locked} onPress={() => answer(id, 'instruct')}>
            지시만 보내기
          </Button>
        ]}
      </Row>
      <Textarea
        key={`note-${id}`}
        label="한 줄 지시"
        labelHidden
        rows={2}
        placeholder="반려 · 고쳐 줘 · 지시에는 한 줄 지시가 필요합니다"
        defaultValue={read(notes)[id] ?? ''}
        onChange={(value) => update(notes, (all) => ({ ...all, [id]: value }))}
      />
    </Stack>
  )
}

function QueueItem({ card }: { card: QueueCard }) {
  const { item } = card
  const error = read(errors)[item.id]
  const answerable = card.status === 'open' || card.status === 'answered'
  return (
    <Card title={`${item.project} · ${item.title}`} description={`${KIND[item.kind]} · ${when(item.createdAt)}`}>
      <Stack gap="sm">
        {item.body && <Text>{item.body}</Text>}
        {item.proposal && <Text weight="medium">제안: {item.proposal}</Text>}
        {card.stale && <Text tone="warning">항목이 바뀌어 이전 답은 무효입니다. 다시 답해 주세요.</Text>}
        {item.kind === 'send-ready' && (
          <Stack gap="xs">
            <Text muted size="sm">보낼 사람: {item.sender} · 직접 복사해 보낸 뒤 「보냈음」을 누르세요.</Text>
            <Textarea key={`draft-${item.id}`} label="보낼 글" labelHidden rows={6} value={item.draft ?? ''} />
          </Stack>
        )}
        {(item.evidence ?? []).length > 0 && (
          <Row gap="xs" wrap>
            {(item.evidence ?? []).map((e, i) => (
              <Button key={`evidence-${item.id}-${i}`} size="sm" variant="ghost" icon="file" onPress={() => openEvidence(item.id, i)}>
                {e.label}
              </Button>
            ))}
          </Row>
        )}
        {card.answer && (
          <Row gap="xs" wrap>
            <Badge tone="accent">
              답: {VERDICT[card.answer.verdict]}
              {card.answer.choice ? ` · ${card.answer.choice}` : ''}
            </Badge>
            <Text muted size="xs">{when(card.answer.at)}</Text>
            {card.answer.note && <Text size="sm">{card.answer.note}</Text>}
            {(() => {
              const relay = relayText(card.answer)
              return relay && (relay.warn ? <Text tone="warning" size="sm">{relay.text}</Text> : <Text muted size="sm">{relay.text}</Text>)
            })()}
          </Row>
        )}
        {card.status === 'taken' && <Badge tone="warning">처리 중</Badge>}
        {card.status === 'done' && <Text muted size="sm">끝남{card.stateNote ? ` · ${card.stateNote}` : ''}</Text>}
        {answerable && <Answers card={card} />}
        {error && (
          <Text key={`error-${item.id}`} tone="danger" size="sm">
            {error}
          </Text>
        )}
      </Stack>
    </Card>
  )
}

function Section({ title, cards }: { title: string; cards: QueueCard[] }) {
  if (!cards.length) return null
  return (
    <Stack gap="sm">
      <Row gap="xs">
        <Heading level={3}>{title}</Heading>
        <Badge>{cards.length}</Badge>
      </Row>
      <Stack gap="sm">
        {cards.map((card) => (
          <Stack key={`card-${card.item.id}`} gap="none">
            <QueueItem card={card} />
          </Stack>
        ))}
      </Stack>
    </Stack>
  )
}

async function startHere(): Promise<void> {
  set(queue, await plugin.request('config.setup'))
}

export default function Panel() {
  const view = read(queue)
  if (!view) return <Text muted>불러오는 중…</Text>
  if (!view.configured)
    return (
      <Stack gap="md">
        <EmptyState
          icon="bell"
          title="아직 이 Mac에서 쓰지 않았어요"
          description="누르면 ~/.local/state/ryude/decisions 를 지켜보고, 답하면 류드 터미널에 항목 ID를 알립니다."
        />
        <Button onPress={startHere}>이 Mac에서 쓰기 시작</Button>
      </Stack>
    )
  const by = (status: string) => view.cards.filter((c) => c.status === status)
  const done = by('done')
  return (
    <Stack gap="lg">
      {view.cards.length === 0 && view.invalid.length === 0 && (
        <EmptyState icon="check" title="기다리는 결정이 없어요" description="류드가 항목을 올리면 여기와 알림에 나타납니다." />
      )}
      <Section title="답 기다림" cards={by('open')} />
      <Section title="답함" cards={by('answered')} />
      <Section title="처리 중" cards={by('taken')} />
      {done.length > 0 && (
        <Stack gap="sm">
          <Button variant="ghost" size="sm" onPress={() => update(showDone, (v) => !v)}>
            {read(showDone) ? '끝난 항목 접기' : `끝난 항목 ${done.length}개 보기`}
          </Button>
          {read(showDone) && <Section title="끝남" cards={done} />}
        </Stack>
      )}
      {view.invalid.length > 0 && (
        <Stack gap="xs">
          <Heading level={3}>읽지 못한 항목</Heading>
          <Stack gap="xs">
            {view.invalid.map((bad) => (
              <Text key={`invalid-${bad.id}`} tone="danger" size="sm">
                {bad.id}: {bad.reason}
              </Text>
            ))}
          </Stack>
        </Stack>
      )}
    </Stack>
  )
}

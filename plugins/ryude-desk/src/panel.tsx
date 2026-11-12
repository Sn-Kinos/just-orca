// The sidebar. It never touches files: every read and write goes through the worker.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Text,
  Textarea,
  update,
  type IconName,
  type PanelContext,
  type Tone
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
/** Cards whose one-line note field is open. */
const noteOpen = atom<Record<string, boolean>>({})

const KIND: Record<Kind, { label: string; tone: Tone }> = {
  approve: { label: '승인 요청', tone: 'neutral' },
  decide: { label: '결정', tone: 'neutral' },
  review: { label: '검토', tone: 'neutral' },
  // The only coloured kind: this one ends with something reaching a customer.
  'send-ready': { label: '발송 준비', tone: 'danger' }
}
/** The verdict that says yes; it gets the filled button. */
const PRIMARY: Verdict[] = ['approve', 'accept', 'sent']
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

function setError(id: string, message: string): void {
  update(errors, (all) => ({ ...all, [id]: message }))
}

async function answer(id: string, verdict: Verdict, choice?: string): Promise<void> {
  const note = (read(notes)[id] ?? '').trim()
  if (NEEDS_NOTE.includes(verdict) && !note) {
    update(noteOpen, (all) => ({ ...all, [id]: true }))
    setError(id, `${VERDICT[verdict]}에는 한 줄 지시를 적어 주세요`)
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

const ms = (iso: string) => {
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? Date.now() : t
}

function evidenceIcon(path: string): IconName {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['mp4', 'mov', 'm4v'].includes(ext)) return 'play'
  if (['pdf', 'txt', 'md', 'docx', 'hwp', 'hwpx', 'csv', 'xlsx', 'pptx'].includes(ext)) return 'file-text'
  return 'file'
}

/** Closes a card's note field and forgets what was typed in it. */
function closeNote(id: string): void {
  update(noteOpen, (all) => ({ ...all, [id]: false }))
  update(notes, (all) => ({ ...all, [id]: '' }))
  setError(id, '')
}

function Answers({ card }: { card: QueueCard }) {
  const { id, kind, options } = card.item
  const locked = !!read(sending)[id]
  const current = card.answer
  const open = !!read(noteOpen)[id]
  return (
    <Stack gap="sm">
      <Row gap="xs" wrap>
        {[
          ...(kind === 'decide' ? options ?? [] : []).map((option, i) => (
            <Button
              key={`choose-${id}-${i}`}
              variant="solid"
              tone={current?.choice === option ? 'accent' : 'neutral'}
              icon={current?.choice === option ? 'check' : undefined}
              disabled={locked || current?.choice === option}
              onPress={() => answer(id, 'choose', option)}
            >
              {option}
            </Button>
          )),
          ...BUTTONS[kind].map((verdict) => {
            const chosen = current?.verdict === verdict && !NEEDS_NOTE.includes(verdict)
            return (
              <Button
                key={`${verdict}-${id}`}
                variant="solid"
                tone={PRIMARY.includes(verdict) ? 'accent' : 'neutral'}
                icon={chosen ? 'check' : undefined}
                disabled={locked || chosen}
                onPress={() => answer(id, verdict)}
              >
                {VERDICT[verdict]}
              </Button>
            )
          }),
          <Button key={`instruct-${id}`} variant="ghost" icon="edit" disabled={locked} onPress={() => (open ? answer(id, 'instruct') : update(noteOpen, (all) => ({ ...all, [id]: true })))}>
            {open ? '지시 보내기' : '지시'}
          </Button>,
          ...(open
            ? [
                <Button key={`cancel-${id}`} variant="ghost" disabled={locked} onPress={() => closeNote(id)}>
                  취소
                </Button>
              ]
            : [])
        ]}
      </Row>
      {open && (
        <Textarea
          key={`note-${id}`}
          label="한 줄 지시"
          labelHidden
          rows={2}
          placeholder="류드에게 보낼 한 줄 지시 (반려 · 고쳐 줘에도 쓰입니다)"
          defaultValue={read(notes)[id] ?? ''}
          onChange={(value) => update(notes, (all) => ({ ...all, [id]: value }))}
        />
      )}
    </Stack>
  )
}

function AnswerState({ card }: { card: QueueCard }) {
  const a = card.answer
  if (card.status === 'taken')
    return (
      <Callout tone="neutral" icon="activity" title="류드가 처리 중">
        {a ? `답: ${VERDICT[a.verdict]}${a.choice ? ` · ${a.choice}` : ''}` : ''}
      </Callout>
    )
  if (!a) return null
  const relay = relayText(a)
  return (
    <Callout tone={relay?.warn ? 'warning' : 'success'} icon={relay?.warn ? 'warning' : 'check'} title={`답: ${VERDICT[a.verdict]}${a.choice ? ` · ${a.choice}` : ''}`}>
      <Stack gap="none">
        {a.note && <Text size="sm">{a.note}</Text>}
        <Text muted size="xs">{relay ? relay.text : '류드에게 알림 · 처리 기다리는 중'}</Text>
      </Stack>
    </Callout>
  )
}

function QueueItem({ card }: { card: QueueCard }) {
  const { item } = card
  const kind = KIND[item.kind]
  const error = read(errors)[item.id]
  const answerable = card.status === 'open' || card.status === 'answered'
  const evidence = item.evidence ?? []
  return (
    <Box radius="md" padding="md" gap="sm" background="card">
      <Row justify="between" align="center">
        <Badge tone={kind.tone}>{kind.label}</Badge>
        <Text muted size="xs">
          <RelativeTime at={ms(item.createdAt)} format="short" />
        </Text>
      </Row>
      <Text weight="semibold">{item.title}</Text>
      {item.body && (
        <Text muted size="sm">
          {item.body}
        </Text>
      )}
      {card.stale && (
        <Callout tone="warning" icon="warning">
          항목이 바뀌어 이전 답은 무효입니다. 다시 답해 주세요.
        </Callout>
      )}
      {item.proposal && (
        <Box background="muted" radius="sm" paddingX="md" paddingY="sm" direction="row" gap="xs" align="center">
          <Text size="xs" muted>
            류드 제안
          </Text>
          <Text size="sm" weight="medium">
            {item.proposal}
          </Text>
        </Box>
      )}
      {item.kind === 'send-ready' && (
        <Stack gap="xs">
          <Text muted size="xs">
            {item.sender} 이름으로 직접 복사해 보낸 뒤 「보냈음」을 눌러 주세요
          </Text>
          <Textarea key={`draft-${item.id}`} label="보낼 글" labelHidden rows={4} value={item.draft ?? ''} />
        </Stack>
      )}
      {evidence.length > 0 && (
        <Row gap="xs" wrap>
          {evidence.map((e, i) => (
            <Button key={`evidence-${item.id}-${i}`} size="sm" variant="solid" tone="neutral" icon={evidenceIcon(e.path)} onPress={() => openEvidence(item.id, i)}>
              {e.label}
            </Button>
          ))}
        </Row>
      )}
      <AnswerState card={card} />
      {answerable && <Answers card={card} />}
      {error && (
        <Text key={`error-${item.id}`} tone="danger" size="sm">
          {error}
        </Text>
      )}
    </Box>
  )
}

function DoneItem({ card }: { card: QueueCard }) {
  const a = card.answer
  return (
    <Box gap="none" paddingY="xs">
      <Row justify="between" align="center">
        <Text size="sm" weight="medium" truncate>
          {card.item.title}
        </Text>
        <Text muted size="xs">
          <RelativeTime at={ms(card.item.createdAt)} format="short" />
        </Text>
      </Row>
      <Text muted size="xs">
        {[a && `${VERDICT[a.verdict]}${a.choice ? ` · ${a.choice}` : ''}`, card.stateNote].filter(Boolean).join(' · ')}
      </Text>
    </Box>
  )
}

/** Projects in the order of their newest card, each with its cards newest first. */
function byProject(cards: QueueCard[]): [string, QueueCard[]][] {
  const groups = new Map<string, QueueCard[]>()
  for (const card of cards) groups.set(card.item.project, [...(groups.get(card.item.project) ?? []), card])
  return [...groups]
}

function Section({ id, title, cards }: { id: string; title: string; cards: QueueCard[] }) {
  if (!cards.length) return null
  return (
    <Stack gap="md">
      <Row gap="xs" align="center">
        <Text muted weight="medium" size="sm">
          {title}
        </Text>
        <Text muted size="sm">
          {cards.length}
        </Text>
      </Row>
      <Stack gap="lg">
        {byProject(cards).map(([project, group]) => (
          <Box key={`group-${id}-${project}`} background="muted" radius="lg" padding="md" gap="md">
            <Row gap="xs" align="center">
              <Text weight="semibold" truncate>
                {project}
              </Text>
              {group.length > 1 && (
                <Text muted size="sm">
                  {group.length}
                </Text>
              )}
            </Row>
            <Stack gap="md">
              {group.map((card) => (
                <Stack key={`card-${card.item.id}`} gap="none">
                  <QueueItem card={card} />
                </Stack>
              ))}
            </Stack>
          </Box>
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
          icon="layers"
          title="아직 이 Mac에서 쓰지 않았어요"
          description="누르면 ~/.local/state/ryude/decisions 를 지켜보고, 답하면 류드 터미널에 항목 ID를 알립니다"
        />
        <Button onPress={startHere}>이 Mac에서 쓰기 시작</Button>
      </Stack>
    )
  const by = (status: string) => view.cards.filter((c) => c.status === status)
  const done = by('done')
  const active = view.cards.length - done.length
  return (
    <Stack gap="lg">
      {active === 0 && view.invalid.length === 0 && (
        <EmptyState icon="check" title="기다리는 결정이 없어요" description="류드가 항목을 올리면 여기와 알림에 나타납니다" />
      )}
      <Section id="open" title="답 기다림" cards={by('open')} />
      <Section id="answered" title="답함" cards={by('answered')} />
      <Section id="taken" title="처리 중" cards={by('taken')} />
      {done.length > 0 && (
        <Collapsible title={`끝난 항목 ${done.length}개`}>
          <Stack gap="md">
            {byProject(done).map(([project, group]) => (
              <Stack key={`group-done-${project}`} gap="xs">
                <Text weight="semibold" size="sm" truncate>
                  {project}
                </Text>
                <Stack gap="none">
                  {group.map((card) => (
                    <Stack key={`card-${card.item.id}`} gap="none">
                      <DoneItem card={card} />
                    </Stack>
                  ))}
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Collapsible>
      )}
      {view.invalid.length > 0 && (
        <Callout tone="danger" icon="error" title="읽지 못한 항목">
          <Stack gap="xs">
            {view.invalid.map((bad) => (
              <Text key={`invalid-${bad.id}`} size="sm">
                {bad.id}: {bad.reason}
              </Text>
            ))}
          </Stack>
        </Callout>
      )}
    </Stack>
  )
}

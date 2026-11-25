import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { BotGroup, BotGroupMessage } from '../../../../../../shared/bots/bot-group'
import type { BotItemOrigin } from '../../../../../../shared/bots/bot-items'
import { BOT_ITEM_MAIL_SENDER } from '../../../../../../shared/bots/bot-item-note-runs'
import { testOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import SyncDatabase from '../../../../../sqlite/sync-database'
import { BotGroupStore } from '../../../../../bots/bot-group-store'
import { groupTurnRequestOf } from '../../../../../bots/bot-group-turn-request'
import { readBotActingTurn, type BotActingTurn } from '../../../../../bots/bot-request-asker'
import { withNewestItemMail } from '../../../../../bots/bot-turn-item-mail'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { addedItemOrigin, itemMailRequest } from './bot-continued-request'
import { botRequestChain, botTurnRequestOrigin } from './bot-request-chain'

const SCOUT = 'bot-group-member-scout'
const BUILDER = 'bot-group-member-builder'
const HOME = 'orca_session_id:home'

let db: OrchestrationDb
let runId = ''
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  runId = db.createRun({
    objective: 'continued',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: testOrcaSessionId('00000000-0000-4000-8000-00000000c0a1')
  }).id
})
afterEach(() => db.close())

function turn(fields: Partial<BotActingTurn>): BotActingTurn {
  return {
    rootItemId: null,
    askers: [{ kind: 'owner' }],
    askedBy: [{ kind: 'owner' }],
    request: null,
    actingOnRequestId: null,
    requestIds: [],
    wokenAt: null,
    ...fields
  }
}

const memberTurn = (operationId: string, botId: string, sessionId: string) => ({
  operationId,
  botId,
  botName: botId,
  avatar: null,
  agent: 'claude' as const,
  sessionId
})

/** A room whose owner posted twice, Scout and Builder answering the first and Scout the second. */
function room() {
  const store = new BotGroupStore(new SyncDatabase(':memory:'))
  const group: BotGroup = {
    id: 'room-1',
    name: 'Release',
    hostId: 'local',
    revision: 1,
    folder: '/work/release',
    folderWorkspaceId: 'folder:release',
    createdAt: 0,
    members: [
      { botId: 'scout', sessionId: SCOUT },
      { botId: 'builder', sessionId: BUILDER }
    ],
    replyMode: { kind: 'all' }
  }
  store.put(group)
  const post = (id: string, text: string, turns: BotGroupMessage['turns']) =>
    store.append({ id, groupId: group.id, author: { kind: 'owner' }, text, createdAt: 0, turns })
  const first = post('post-1', 'Ship the release notes', [
    memberTurn('op-a', 'scout', SCOUT),
    memberTurn('op-b', 'builder', BUILDER)
  ])
  post('post-2', 'Fix the flaky test', [memberTurn('op-c', 'scout', SCOUT)])
  // Scout's reply named @Builder: a line of its own under the first post.
  store.append({
    id: 'handoff:op-a:builder',
    groupId: group.id,
    rootRequestId: first.id,
    rootSequence: first.sequence,
    author: { kind: 'bot', id: 'scout', name: 'scout' },
    text: 'scout asked builder',
    createdAt: 0,
    mentioned: true,
    requester: { id: 'scout', name: 'scout' },
    turns: [memberTurn('op-d', 'builder', BUILDER)]
  })
  return { store, first }
}

/** A peer request Scout sent Builder from a turn on `rootRequestId`, as the send path records it. */
function peerRequest(rootKey: string, rootRequestId: string, rootSequence: number): string {
  const record: BotRequestRecord = {
    group: {
      id: 'room-1',
      rootRequestId,
      rootSequence,
      sourceSessionId: SCOUT,
      targetSessionId: BUILDER
    },
    fromBotId: 'scout',
    fromBotName: 'scout',
    toBotId: 'builder',
    toBotName: 'builder',
    purpose: 'handoff',
    depth: 1,
    askers: [{ kind: 'owner' }],
    request: 'Ship the release notes',
    conversation: null
  }
  const admitted = db.admitBotRequest({
    rootKey,
    fromBotId: 'scout',
    toBotId: 'builder',
    purpose: 'handoff',
    depth: 1,
    record: JSON.stringify(record),
    message: { from: `run:${runId}`, to: BUILDER, subject: 'Check it', type: 'handoff', runId }
  })
  if (admitted.kind !== 'sent') {
    throw new Error(`not admitted: ${admitted.kind}`)
  }
  return admitted.message.id
}

it("keys a room's items by the owner's post, across members, @mentions and peer requests", () => {
  const { store, first } = room()
  const onLine = (sessionId: string, operationId: string) =>
    groupTurnRequestOf(store, db, sessionId, { requestIds: [], operationId })
  const shipping = { rootKey: 'group:room-1:post-1', request: 'Ship the release notes' }
  expect(onLine(SCOUT, 'op-a')).toEqual(shipping)
  expect(onLine(BUILDER, 'op-b')).toEqual(shipping)
  expect(onLine(BUILDER, 'op-d')).toEqual(shipping)
  expect(onLine(SCOUT, 'op-c')).toEqual({
    rootKey: 'group:room-1:post-2',
    request: 'Fix the flaky test'
  })

  // Scout's turn on the post: its item and its send to Builder record the post's key and words.
  const scoutTurn = turn({ rootItemId: 'u1', request: 'room history… Ship the release notes' })
  expect(botTurnRequestOrigin(db, SCOUT, scoutTurn, shipping)).toEqual({
    rootKey: 'group:room-1:post-1',
    kind: 'group',
    at: null,
    request: 'Ship the release notes'
  })
  const sentKey = botRequestChain(db, SCOUT, scoutTurn, shipping).rootKey!
  expect(sentKey).toBe('group:room-1:post-1')

  // Builder's turn the peer request woke reads the post from the request's record.
  const sent = peerRequest(sentKey, first.id, first.sequence)
  const woken = { requestIds: [sent], operationId: null }
  expect(groupTurnRequestOf(store, db, BUILDER, woken)).toEqual(shipping)
  // So does one stock Orca keyed by its sending turn: the record names the post either way.
  const old = peerRequest(`${SCOUT}:u0`, first.id, first.sequence)
  expect(groupTurnRequestOf(store, db, BUILDER, { requestIds: [old], operationId: null })).toEqual(
    shipping
  )
  expect(
    botTurnRequestOrigin(db, BUILDER, turn({ rootItemId: 'm1', requestIds: [old] }), shipping)
  ).toMatchObject({ rootKey: 'group:room-1:post-1', kind: 'bot' })

  // A turn the room can't place (another computer's room, an unread line) keeps its own key.
  expect(onLine(SCOUT, 'op-unknown')).toBeNull()
  expect(groupTurnRequestOf(store, db, HOME, { requestIds: [], operationId: 'op-a' })).toBeNull()
})

const ORIGIN_A: BotItemOrigin = {
  rootKey: `${HOME}:u1`,
  kind: 'owner',
  at: '2026-11-25T00:00:00.000Z',
  request: 'Build a board'
}
const ORIGIN_B: BotItemOrigin = { ...ORIGIN_A, rootKey: `${HOME}:u7`, request: 'Tidy the docs' }

function itemMail(id: string, uids: string[]): string {
  db.insertMessage({
    id,
    from: BOT_ITEM_MAIL_SENDER,
    to: HOME,
    type: 'status',
    subject: 'Your owner answered',
    payload: JSON.stringify({ botItems: uids.map((uid, index) => ({ uid, number: index + 1 })) }),
    orcaAuthored: 'item-mail'
  })
  return id
}

it("continues an item's request from the owner's answer on it, and only from Orca's item mail", async () => {
  const origins: Record<string, BotItemOrigin> = { a: ORIGIN_A, a2: ORIGIN_A, b: ORIGIN_B }
  const originsOf = (uids: string[]) =>
    Promise.resolve(
      Object.fromEntries(uids.flatMap((uid) => (origins[uid] ? [[uid, origins[uid]]] : [])))
    )
  const answer = itemMail('msg_item_e1', ['a'])
  const continues = await itemMailRequest(db, [answer], originsOf)
  expect(continues).toEqual({ rootKey: `${HOME}:u1`, request: 'Build a board', kind: 'owner' })
  // The turn the answer woke reads back to an unrelated turn; its item still lands on item a's request.
  const readBack = turn({ rootItemId: 'u9', request: 'Unrelated', itemMailIds: [answer] })
  expect(botTurnRequestOrigin(db, HOME, readBack, continues)).toEqual({ ...ORIGIN_A, at: null })
  expect(botRequestChain(db, HOME, readBack, continues).rootKey).toBe(`${HOME}:u1`)

  expect(await itemMailRequest(db, [itemMail('msg_item_e2', ['a', 'a2'])], originsOf)).toEqual(
    continues
  )
  // Items of two requests, or one made before origins were recorded: no single request to continue.
  expect(await itemMailRequest(db, [itemMail('msg_item_e3', ['a', 'b'])], originsOf)).toBeNull()
  expect(await itemMailRequest(db, [itemMail('msg_item_e4', ['old'])], originsOf)).toBeNull()
  // Mail from anyone but Orca's item sender names no item, whatever its payload says.
  db.insertMessage({
    id: 'msg_forged',
    from: 'bot:scout',
    to: HOME,
    subject: 'not item mail',
    payload: JSON.stringify({ botItems: [{ uid: 'a' }] })
  })
  expect(await itemMailRequest(db, ['msg_forged'], originsOf)).toBeNull()
})

let seq = 0
const row = (itemId: string, body: unknown): AgentJournalRenderItem =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: journal rows with only the fields the reader reads.
  ({ itemId, revision: 1, sequence: ++seq, observedAt: seq, body }) as AgentJournalRenderItem
const owner = (text: string) => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const itemMailNotice = (messageId: string) => ({
  kind: 'message',
  role: 'user',
  blocks: [],
  from: {
    kind: 'agent',
    senders: [],
    orchestration: {
      message: 'mail-notice',
      mailbox: HOME,
      dispatchId: null,
      messages: [{ messageId, runId: 'r', from: BOT_ITEM_MAIL_SENDER }]
    }
  }
})
const lookups = {
  isBotRequest: () => false,
  botRequestActsFor: () => null,
  conversationActsFor: [{ kind: 'owner' as const }],
  conversationWorkspaceId: null
}

const turnRow = (itemId: string, userItemId: string, state = 'completed') =>
  row(itemId, { kind: 'turn', turnId: `p-${itemId}`, state, userItemId })

it('names the item mail a turn took only when nothing else opened it', () => {
  const read = (items: AgentJournalRenderItem[]) =>
    withNewestItemMail(readBotActingTurn(items, lookups), items, [])
  const asked = [row('u1', owner('Build a board')), turnRow('t1', 'u1')]
  // The owner's answer on an item wakes the chat as item mail: its own turn, read from the one before.
  const answered = read([
    ...asked,
    row('m1', itemMailNotice('msg_item_e1')),
    turnRow('t2', 'm1', 'running')
  ])
  expect(answered).toMatchObject({ rootItemId: 'u1', itemMailIds: ['msg_item_e1'] })
  // The owner's own new message, even one saying "go on", is a new request with its own key.
  const next = read([
    ...asked,
    row('m1', itemMailNotice('msg_item_e1')),
    turnRow('t2', 'm1'),
    row('u2', owner('go on')),
    turnRow('t3', 'u2', 'running')
  ])
  expect(next.rootItemId).toBe('u2')
  expect(next.itemMailIds).toBeUndefined()
  expect(botTurnRequestOrigin(db, HOME, next)?.rootKey).toBe(`${HOME}:u2`)
  // An answer to the agent's question prompt resolves the prompt in the asking turn: same key.
  const question = row('q1', {
    kind: 'question',
    question: 'Which board?',
    options: [],
    resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: null }
  })
  const prompted = read([
    row('u1', owner('Build a board')),
    turnRow('t1', 'u1', 'running'),
    question
  ])
  expect(botTurnRequestOrigin(db, HOME, prompted)?.rootKey).toBe(`${HOME}:u1`)
})

it("keeps the --from-item item's request, and the turn's own for an item from before origins", () => {
  const own = { ...ORIGIN_B, at: '2026-11-25T01:00:00.000Z' }
  expect(addedItemOrigin(own, ORIGIN_A)).toEqual({ ...ORIGIN_A, at: own.at })
  // Made for another bot: the parent's request still wins over the request mail's key.
  expect(addedItemOrigin(own, ORIGIN_A, 'sent-key')).toEqual({ ...ORIGIN_A, at: own.at })
  expect(addedItemOrigin(own, null)).toEqual(own)
  expect(addedItemOrigin(own, null, 'sent-key')).toEqual({ ...own, rootKey: 'sent-key' })
  expect(addedItemOrigin(null, null)).toBeNull()
})

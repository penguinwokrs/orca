// The room request a member's turn serves, keyed by the owner's post that started it, so every
// member's items and requests for one post share a key and the post's words (bot-continued-request.ts).
import { startsBotGroupRequest } from '../../shared/bots/bot-group-schema'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { requireStructuredHost } from './bot-chat-session'
import { groupScopeOfRecord, rootOf } from './bot-group-mail-root'
import type { BotGroupRuntime } from './bot-group-runtime'
import type { BotGroupStore } from './bot-group-store'

/** The operation of the send that opened a member's turn, from its chat's record of it. */
export async function turnOperation(
  groups: BotGroupRuntime,
  sessionId: string,
  rootItemId: string | null
): Promise<string | null> {
  const submission = await (
    await (await requireStructuredHost(groups.runtime)).journalReads(sessionId)
  ).acceptedSendOfRow(rootItemId)
  return submission?.queuedMessageId ?? submission?.clientMessageId ?? null
}

/** The room line a member's turn runs on, and the request that line serves. */
export function groupTurnLine(store: BotGroupStore, sessionId: string, operationId: string | null) {
  const message = operationId ? store.operationMessage(operationId) : null
  const turn = message?.turns.find(
    (entry) => entry.operationId === operationId && entry.sessionId === sessionId
  )
  return message && turn ? { turn, root: rootOf(message) } : null
}

/** The room request a member's turn serves, as an item made in it records it. */
export type GroupTurnRequest = { rootKey: string; request: string | null }

/** A room request's key: never a `<session>:<item>` turn key, whose session ids hold no `group:`. */
const groupRequestKey = (groupId: string, postId: string) => `group:${groupId}:${postId}`

/**
 * Keyed by the post that started the request, so every member's turn on it (its own turn on the
 * post, an @mention hand-off, a peer's request or answer, a worker's report) shares one key. A
 * turn a peer request woke reads the room request from that request's record, which every host
 * writes; any other reads its own room line. Null when neither names a post this room holds.
 */
export function groupTurnRequestOf(
  store: BotGroupStore,
  db: OrchestrationDb,
  sessionId: string,
  turn: { requestIds: readonly string[]; operationId: string | null }
): GroupTurnRequest | null {
  const found = store.memberOf(sessionId)
  if (!found) {
    return null
  }
  const recorded = turn.requestIds.flatMap((id) => {
    const row = db.getBotRequest(id)
    const scope = row ? groupScopeOfRecord(row.record) : null
    return scope?.id === found.group.id ? [scope.rootRequestId] : []
  })[0]
  const rootRequestId =
    recorded ?? groupTurnLine(store, sessionId, turn.operationId)?.root.rootRequestId
  const original = rootRequestId ? store.message(rootRequestId) : null
  if (!original || original.groupId !== found.group.id || !startsBotGroupRequest(original)) {
    return null
  }
  return {
    rootKey: groupRequestKey(original.groupId, original.id),
    // An item change or a worker's report starts a request, but its words are no person's.
    request: original.fromItems || original.fromReports ? null : original.text || null
  }
}

/** `groupTurnRequestOf` for a member's running turn, read from its chat's record of the turn. */
export async function groupTurnRequest(
  groups: BotGroupRuntime,
  sessionId: string,
  turn: { requestIds: readonly string[]; rootItemId: string | null }
): Promise<GroupTurnRequest | null> {
  if (!groups.store.memberOf(sessionId)) {
    return null
  }
  const db = groups.runtime.getOrchestrationDb()
  const operationId =
    turn.requestIds.length > 0 ? null : await turnOperation(groups, sessionId, turn.rootItemId)
  return groupTurnRequestOf(groups.store, db, sessionId, { ...turn, operationId })
}

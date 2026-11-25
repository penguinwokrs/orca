// Where a new bot request sits in its chain, kept on its record for tracing: a turn a request woke
// continues that request's chain.
import { createHash } from 'node:crypto'
import { MAX_REQUEST_TEXT, type BotActingTurn } from '../../../../../bots/bot-request-asker'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotItemOrigin } from '../../../../../../shared/bots/bot-items'
import { actsForOwner } from '../../../../../../shared/bots/bot-acts-for'
import { isBotGroupMemberSession } from '../../../../../../shared/bots/bot-group'
import { botRequestRecord } from './bot-request-record'
import { sliceAtGraphemeLimit } from '../../../../../../shared/text/surrogate-safe-text-slice'

export type BotRequestChain = {
  /** The new request's hop: 1 from a person's turn, one past the deepest request that woke the turn. */
  depth: number
  /** The chain's key, its first waking request's; null for a send no turn names, which starts its own. */
  rootKey: string | null
  /** The sending turn, which with a send's target and text names that send; null when no turn does. */
  turnKey: string | null
}

/** The request a turn continues instead of starting one: a room's post, or the one the items its
 *  item mail names were made for (bot-continued-request.ts). `kind` and `request` go with the key,
 *  so one key keeps one title; `kind` absent reads the turn's own. */
export type BotTurnContinues = {
  rootKey: string
  request: string | null
  kind?: BotItemOrigin['kind']
}

/** Read from Orca's records of the waking requests, never from the sender's text. A turn that
 *  continues a request keeps that request's key. */
export function botRequestChain(
  db: OrchestrationDb,
  sessionId: string | null,
  turn: Pick<BotActingTurn, 'rootItemId' | 'requestIds'>,
  continues?: Pick<BotTurnContinues, 'rootKey'> | null
): BotRequestChain {
  const turnKey = sessionId && turn.rootItemId ? `${sessionId}:${turn.rootItemId}` : null
  const parents = turn.requestIds.flatMap((id) => {
    const row = db.getBotRequest(id)
    return row ? [row] : []
  })
  if (parents.length === 0) {
    return { depth: 1, rootKey: continues?.rootKey ?? turnKey, turnKey }
  }
  return {
    depth: Math.max(...parents.map((row) => row.depth)) + 1,
    rootKey: continues?.rootKey ?? parents[0].root_key,
    turnKey
  }
}

/** The request a turn acts on, as an item made in it records it: the chain key a send from the same
 *  turn records, so a request's items and the requests it led to share it. Null when no turn names one. */
export function botTurnRequestOrigin(
  db: OrchestrationDb,
  sessionId: string,
  turn: BotActingTurn,
  continues?: BotTurnContinues | null
): BotItemOrigin | null {
  const { rootKey } = botRequestChain(db, sessionId, turn, continues)
  if (!rootKey) {
    return null
  }
  // Only a chain's first request carries the person's words; deeper hops record none.
  const request = continues
    ? continues.request
    : (turn.request ??
      turn.requestIds.map((id) => botRequestRecord(db, id)?.request).find((text) => text) ??
      null)
  return {
    rootKey,
    kind: continues?.kind ?? turnKind(sessionId, turn),
    at:
      turn.openedAt !== undefined && Number.isFinite(turn.openedAt)
        ? new Date(turn.openedAt).toISOString()
        : null,
    request: request === null ? null : sliceAtGraphemeLimit(request, MAX_REQUEST_TEXT)
  }
}

function turnKind(sessionId: string, turn: BotActingTurn): BotItemOrigin['kind'] {
  if (turn.requestIds.length > 0) {
    return 'bot'
  }
  if (turn.byAutomation) {
    return 'automation'
  }
  if (isBotGroupMemberSession(sessionId)) {
    return 'group'
  }
  return actsForOwner(turn.askedBy) ? 'owner' : 'person'
}

/** One send: from this turn, to this bot, of this kind, with this text. */
export function botRequestSendKey(
  turnKey: string,
  toBotId: string,
  purpose: string,
  text: { subject: string; body?: string | null }
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([text.subject, text.body ?? '']))
    .digest('hex')
  return JSON.stringify([turnKey, toBotId, purpose, digest])
}

// Which earlier request a bot's running turn continues, so its items and the requests it sends keep
// that request's key instead of starting one of their own. Read only from records Orca wrote, never
// from the words of a message ("go on" in a chat starts a new request):
//   1. A turn only item mail opened (the owner's comment or Needs you answer on an item, or another
//      chat's change to it) continues the request every item it names was made for.
//   2. A group member's turn continues the room post that started its request, whichever member
//      runs it and however it got there (its own turn on the post, an @mention, a peer's request).
//   3. Anything else starts its own (the turn's own message, or the request that woke it).
// `bot item add --from-item` is the item's own say and wins over all three (bots-items-add.ts).
// A prose question the bot asked, answered by the owner's next message, has no recorded link, so
// that answer starts a new request; an answer to the agent's question prompt resolves that prompt
// in the asking turn, with no new message, so it keeps the turn's key without a rule.
import type { BotItemOrigin } from '../../../../../../shared/bots/bot-items'
import { BOT_ITEM_MAIL_SENDER } from '../../../../../../shared/bots/bot-item-note-runs'
import { isBotGroupMemberSession } from '../../../../../../shared/bots/bot-group'
import type { BotActingTurn } from '../../../../../bots/bot-request-asker'
import { runtimeBotGroups } from '../../../../../bots/bot-group-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { BotTurnContinues } from './bot-request-chain'

/** The items an item mail names, from the payload Orca wrote for it (bots-items-mail.ts). */
function itemMailUids(payload: string | null | undefined): string[] {
  if (!payload) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    const items =
      typeof parsed === 'object' && parsed !== null && 'botItems' in parsed ? parsed.botItems : null
    return Array.isArray(items)
      ? items.flatMap((item: unknown) =>
          typeof item === 'object' && item !== null && 'uid' in item && typeof item.uid === 'string'
            ? [item.uid]
            : []
        )
      : []
  } catch {
    return []
  }
}

/** The request item mail continues: the one every item it names was made for. Null when it names
 *  none, an item has no origin (made before Orca recorded one), or they differ. */
export async function itemMailRequest(
  db: OrchestrationDb,
  mailIds: readonly string[],
  originsOf: (uids: string[]) => Promise<Record<string, BotItemOrigin>>
): Promise<BotTurnContinues | null> {
  const uids = [
    ...new Set(
      mailIds.flatMap((id) => {
        const mail = db.getMessageById(id)
        // Only Orca writes as this sender (message-orca-provenance.ts), so the payload is its own.
        return mail?.from_handle === BOT_ITEM_MAIL_SENDER ? itemMailUids(mail.payload) : []
      })
    )
  ]
  if (uids.length === 0) {
    return null
  }
  const origins = await originsOf(uids)
  const [first, ...rest] = uids.map((uid) => origins[uid])
  if (!first || rest.some((origin) => origin?.rootKey !== first.rootKey)) {
    return null
  }
  return { rootKey: first.rootKey, request: first.request, kind: first.kind }
}

/** The origin `bot item add` records: the `--from-item` item's request when it has one, its time
 *  this turn's; else the turn's own. `sentRootKey`: the key the request mail for an item made for
 *  another bot recorded, which that bot's later items carry on. */
export function addedItemOrigin(
  turn: BotItemOrigin | null,
  fromItem: BotItemOrigin | null,
  sentRootKey?: string
): BotItemOrigin | null {
  if (fromItem) {
    return { ...fromItem, at: turn?.at ?? null }
  }
  return turn && sentRootKey ? { ...turn, rootKey: sentRootKey } : turn
}

/** What the running turn continues, by the rules above; null when it starts its own. Never throws:
 *  a turn it can't read starts its own, as before Orca read this. */
export async function readContinuedRequest(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  sessionId: string,
  turn: Pick<BotActingTurn, 'rootItemId' | 'requestIds' | 'itemMailIds'>
): Promise<BotTurnContinues | null> {
  try {
    if (turn.itemMailIds && turn.itemMailIds.length > 0) {
      const store = runtime.botItems.store()
      const fromItems = await itemMailRequest(
        db,
        turn.itemMailIds,
        async (uids) => (await store.viewRows(uids)).origins
      )
      if (fromItems) {
        return fromItems
      }
    }
    if (!isBotGroupMemberSession(sessionId)) {
      return null
    }
    return await runtimeBotGroups(runtime).turnRequest(sessionId, turn)
  } catch (error) {
    console.warn('[bots] could not read the request a turn continues', error)
    return null
  }
}

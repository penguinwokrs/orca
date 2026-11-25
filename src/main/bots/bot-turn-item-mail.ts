// Item mail the running turn took when nothing else opened it: the owner's comment or Needs you
// answer on an item, or another chat's change to it. Such a turn is read from the turn before it,
// as a worker's report is, so its item mail is named beside that reading (bot-continued-request.ts).
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'
import { turnWindows, type BotActingTurn } from './bot-request-asker'

function itemMailIdsOf(body: AgentJournalItemBody): string[] {
  const mail = body.kind === 'message' ? body.from?.orchestration : undefined
  return mail?.message === 'mail-notice'
    ? mail.messages.flatMap((message) =>
        message.from === BOT_ITEM_MAIL_SENDER ? [message.messageId] : []
      )
    : []
}

/** `turn` as read from `items`, with the item mail of the newest turn when that turn was read from
 *  an older one; a newest turn a person or a request opened is its own, whatever mail it took. */
export function withNewestItemMail(
  turn: BotActingTurn,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): BotActingTurn {
  const newest = turnWindows(items, submissions, null)[0] ?? []
  if (newest.some((item) => item.itemId === turn.rootItemId)) {
    return turn
  }
  const itemMailIds = newest.flatMap((item) => itemMailIdsOf(item.body))
  return itemMailIds.length > 0 ? { ...turn, itemMailIds } : turn
}

import { afterEach, expect, it } from 'vitest'
import type { BotItemOrigin } from '../../shared/bots/bot-items'
import type { BotItemBotActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const BOT: BotItemBotActor = { kind: 'bot', botId: 'bot', chatId: 'home' }
const ORIGIN: BotItemOrigin = {
  rootKey: 'orca_session_id:home:item-1',
  kind: 'owner',
  at: 1000,
  request: 'Build a board'
}

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

function add(
  store: BotItemsStore,
  title: string,
  origin?: BotItemOrigin,
  fromItem?: { uid: string; number: number }
): string {
  return store.add(
    {
      ownerBotId: BOT.botId,
      chatId: BOT.chatId,
      source: { kind: 'home', title: null },
      title,
      status: 'planned',
      links: [],
      ...(origin ? { origin } : {}),
      ...(fromItem ? { fromItem } : {})
    },
    BOT
  ).uid
}

it("keeps an item's origin on its made event and lists a request's items by its key", () => {
  const store = BotItemsStore.open(':memory:')
  stores.push(store)
  const first = add(store, 'Build the plugin', ORIGIN)
  const second = add(store, 'File the issue', ORIGIN, { uid: first, number: 1 })
  const other = add(store, 'Unrelated', { ...ORIGIN, rootKey: 'orca_session_id:home:item-2' })
  // An item made before Orca recorded origins has none, and still reads and lists.
  const old = add(store, 'Made before origins')

  const rows = store.viewRows([first, second, other, old])
  expect(rows.origins).toEqual({
    [first]: ORIGIN,
    [second]: ORIGIN,
    [other]: { ...ORIGIN, rootKey: 'orca_session_id:home:item-2' }
  })
  expect(rows.fromItems).toEqual({ [second]: { uid: first, number: 1 } })
  expect(store.events(first, 0, 1)[0]?.data.origin).toEqual(ORIGIN)

  // Later events never move an item out of its request.
  store.set(first, { status: 'working' }, BOT)
  const page = store.list({
    botId: BOT.botId,
    statuses: ['planned', 'working'],
    rootKey: ORIGIN.rootKey,
    limit: 10
  })
  expect(page.items.map((item) => item.uid).toSorted()).toEqual([first, second].toSorted())
  expect(page.counts).toEqual({ planned: 1, working: 1 })
  expect(
    store.list({ botId: BOT.botId, statuses: ['planned'], limit: 10 }).items.map((i) => i.uid)
  ).toContain(old)
})

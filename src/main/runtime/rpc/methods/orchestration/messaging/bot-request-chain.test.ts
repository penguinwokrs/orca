import { afterEach, beforeEach, expect, it } from 'vitest'
import type { BotActingTurn } from '../../../../../bots/bot-request-asker'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { testOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { botRequestChain, botTurnRequestOrigin } from './bot-request-chain'

const HOME = 'orca_session_id:home'
const HELPER = 'orca_session_id:helper'

let db: OrchestrationDb
let runId = ''
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  runId = db.createRun({
    objective: 'asker',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: testOrcaSessionId('00000000-0000-4000-8000-00000000a5c1')
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

/** A handoff as the send path admits it, under the chain key its sending turn had. */
function handoff(rootKey: string, request: string | null): string {
  const record: BotRequestRecord = {
    fromBotId: 'coordinator',
    fromBotName: 'Coordinator',
    toBotId: 'helper',
    toBotName: 'Helper',
    purpose: 'handoff',
    depth: 1,
    askers: [{ kind: 'owner' }],
    request,
    conversation: null
  }
  const admitted = db.admitBotRequest({
    rootKey,
    fromBotId: 'coordinator',
    toBotId: 'helper',
    purpose: 'handoff',
    depth: 1,
    record: JSON.stringify(record),
    message: { from: `run:${runId}`, to: HELPER, subject: 'Do it', type: 'handoff', runId }
  })
  if (admitted.kind !== 'sent') {
    throw new Error(`not admitted: ${admitted.kind}`)
  }
  return admitted.message.id
}

it("records the chain key a send from the same turn records, across a bot's handoff", () => {
  const owner = turn({ rootItemId: 'item-1', request: 'Build a board', openedAt: 1000 })
  expect(botTurnRequestOrigin(db, HOME, owner)).toEqual({
    rootKey: 'orca_session_id:home:item-1',
    kind: 'owner',
    at: 1000,
    request: 'Build a board'
  })
  // The helper's turn, woken by the coordinator's handoff, keeps the owner's request and its key.
  const sent = handoff(botRequestChain(db, HOME, owner).rootKey!, 'Build a board')
  const woken = turn({
    rootItemId: 'item-9',
    actingOnRequestId: sent,
    requestIds: [sent],
    openedAt: 2000
  })
  expect(botTurnRequestOrigin(db, HELPER, woken)).toEqual({
    rootKey: 'orca_session_id:home:item-1',
    kind: 'bot',
    at: 2000,
    request: 'Build a board'
  })
  expect(botTurnRequestOrigin(db, HELPER, woken)?.rootKey).toBe(
    botRequestChain(db, HELPER, woken).rootKey
  )
  // A chat no message has opened a turn in names no request.
  expect(botTurnRequestOrigin(db, HOME, turn({}))).toBeNull()
})

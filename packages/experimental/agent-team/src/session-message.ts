/** Durable Session-message acceptance checks shared by provisioning and mailbox recovery. */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

type InboxProjection = Record<'next-turn' | 'next-step', UserMessage[]>

/** Fold the durable inbox suffix into the messages still awaiting a claim. */
function pendingInboxMessages(events: readonly SessionEvent[]): UserMessage[] {
  const inbox: InboxProjection = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const pending = inbox[event.data.target]
    pending.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
  }
  return [...inbox['next-turn'], ...inbox['next-step']]
}

/**
 * Test whether one message is model-visible or still durably pending.
 * @param events - one Session's non-inherited event suffix.
 * @param predicate - identity check for the accepted message.
 * @returns whether history or the current inbox contains a match.
 */
export function messageAccepted(
  events: readonly SessionEvent[],
  predicate: (message: UserMessage) => boolean,
): boolean {
  return events.some(event => event.type === 'user/message' && predicate(event.data))
    || pendingInboxMessages(events).some(predicate)
}

/**
 * The failure that ended a Session's first turn, if it ended in error.
 *
 * A child whose first request is refused — an effort its model does not
 * offer, an unreachable route — claims its initial prompt from the inbox and
 * then ends the turn without ever recording it as history. Reading only
 * acceptance, that looks like a prompt that was never delivered; this is the
 * reason it was not.
 * @param events - one Session's non-inherited event suffix.
 * @returns the recorded failure message, or undefined.
 */
export function firstTurnFailure(events: readonly SessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const reason = event.data.reason
    return reason.kind === 'error' ? reason.error.message : undefined
  }
  return undefined
}

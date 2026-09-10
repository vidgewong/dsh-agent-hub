/**
 * Plugin-owned durable agent inbox, reproduced from the official
 * `ReactLoopInbox` in `@deepseek-ai/dsh-agent-loop`.
 *
 * As of dsh 0.1.5 the host no longer exports a constructible `Inbox`: the
 * durable inbox moved into the loop package as the unexported `ReactLoopInbox`,
 * built over `ctx.sessionProjections`, and the public `Inbox` interface no
 * longer surfaces `claim`/`hasPending`. Our engines drive their own agent
 * loops without the official `AgentLoop`, so we reproduce the driver-owned
 * inbox here: same durable `agent/inbox/spliced` event vocabulary, same
 * projection fold, same command facade. It registers its projection unit on
 * construction, exactly as the official implementation does.
 *
 * @module dsh-omniloop/driver-core/inbox
 */

import { z } from 'zod'
import type { AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

/** Durable pending-input state folded from `agent/inbox/spliced` history. */
interface InboxProjectionState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    'omniloop:inbox': InboxProjectionState
  }
}

const INBOX_KEY = 'omniloop:inbox' as const

const inboxProjectionSchema = z
  .object({
    'next-turn': z.array(z.custom<UserMessage>()).readonly(),
    'next-step': z.array(z.custom<UserMessage>()).readonly(),
  })
  .readonly()

/** Standard fold that reconstructs pending input and rejects invalid durable splice history. */
const inboxProjectionDefinition = {
  key: INBOX_KEY,
  stateSchema: inboxProjectionSchema,
  init: (): InboxProjectionState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxProjectionState, event: { type: string; seq: number; data?: unknown }): InboxProjectionState {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data as {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
    }
    try {
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (
        !Number.isSafeInteger(splice.start) ||
        splice.start < 0 ||
        splice.start > inbox.length ||
        !Number.isSafeInteger(removedCount) ||
        removedCount < 0 ||
        splice.start + removedCount > inbox.length
      ) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      return splice.target === 'next-turn'
        ? { 'next-turn': next, 'next-step': state['next-step'] }
        : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  stateVersion: 1,
}

/**
 * Driver-owned durable inbox used by the plugin's engine agents. Registers its
 * projection unit on construction; the registration is an effect on the
 * registry's fiber and unwinds with it.
 */
export class PluginInbox {
  private readonly dispose: () => void

  constructor(
    private readonly projections: SessionProjectionRegistry,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {
    // `register` is typed against the host's own key union; our augmented key
    // is host-only (no wire), matching the host-only `register` overload.
    this.dispose = (this.projections.register as (definition: unknown) => () => void)(
      inboxProjectionDefinition,
    )
  }

  /** Release the projection registration. */
  release(): void {
    this.dispose()
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.current()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.current()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.current()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /** Append one message to a pending list. */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message])
  }

  /** Prepend one message to a pending list. */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /** Replace one pending message in place; returns whether it was still pending. */
  replace(messageId: string, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /** Remove one pending message; returns whether it was still pending. */
  remove(messageId: string): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /** Apply standard splice semantics and durably record the normalized result. */
  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const state = this.current()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart =
      offset < 0 ? Math.max(inbox.length + offset, 0) : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? ('canceled' as const) : undefined
    const splice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = (this.session.append as (type: string, data: unknown) => { data: { inserted: UserMessage[] } })(
      'agent/inbox/spliced',
      splice,
    )
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) this.dispatch.emit('agent/inbox/inserted', { message })
    return removed
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: string): { target: InboxTarget; index: number } | undefined {
    const state = this.current()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex((message) => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Read the current durable projection state. */
  private current(): InboxProjectionState {
    const state = this.projections.stateOf(this.session, INBOX_KEY)
    if (state === undefined) {
      throw new Error(
        `agent "${this.session.id}" cannot read inbox state: its projection registration is not active`,
      )
    }
    return state
  }
}

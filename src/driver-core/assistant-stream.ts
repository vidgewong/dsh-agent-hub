/**
 * Plugin-owned live assistant-stream publication, reproduced from the official
 * `AssistantStreamAttempt` in `@deepseek-ai/dsh-agent-loop`.
 *
 * As of dsh 0.1.5 the durable `assistant/chunk` event is gone. Streaming no
 * longer persists each delta as its own session event linked by
 * `sourceEventSeqs`; instead each attempt accumulates a compact
 * `AssistantStreamRecord[]` (via the exported `AssistantStreamAccumulator`)
 * embedded directly in the settling `assistant/message` / `assistant/attempt`
 * event, while transient live frames are published on `agent/assistant-stream`
 * for the web surface. Our engines drive their own loops, so we reproduce that
 * publication here: same frame vocabulary (`start`/`chunk`/`end`), same compact
 * accumulation, same attempt identity.
 *
 * @module dsh-omniloop/driver-core/assistant-stream
 */

import type { AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator, LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/** Durable settlement type an attempt can commit under. */
type SettleEventType = 'assistant/message' | 'assistant/attempt'

/**
 * One process-local assistant streaming attempt. Chunk frames are transient
 * (published on `agent/assistant-stream`); the compact stream is the durable
 * record embedded in the settling event.
 */
export class PluginAssistantStream {
  private readonly accumulator = new AssistantStreamAccumulator()
  private readonly attemptId: LlmAttemptId
  private index = 0
  private terminal = false

  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly nextRevision: () => number,
    private readonly turn: number,
    private readonly step: number,
    private readonly dispatch: AgentEventDispatch,
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`)
  }

  /** Whether this attempt has emitted its terminal frame. */
  get ended(): boolean {
    return this.terminal
  }

  /** Publish the opening marker before the first delivered chunk. */
  start(): void {
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'start',
        attemptId: this.attemptId,
        revision: this.nextRevision(),
        turn: this.turn,
        step: this.step,
      },
    })
  }

  /** Snapshot one chunk once, feed durable compaction, and publish it live. */
  push(chunk: StreamChunk): void {
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'chunk',
        attemptId: this.attemptId,
        revision: this.nextRevision(),
        index: this.index++,
        time: timed.time,
        chunk: timed.chunk,
      },
    })
  }

  /** The compact stream for the final durable event. */
  get stream(): AssistantStreamRecord[] {
    return [...this.accumulator.snapshot()]
  }

  /**
   * Publish terminal settlement after the matching durable event commits.
   * @param eventType - durable settlement type.
   * @param append - synchronous durable append returning its committed seq.
   */
  settle(eventType: SettleEventType, append: () => SessionSeq): SessionSeq {
    let seq: SessionSeq
    try {
      seq = append()
    } catch (error) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'end',
        attemptId: this.attemptId,
        revision: this.nextRevision(),
        index: this.index,
        outcome: { kind: 'committed', eventType, seq },
      },
    })
    return seq
  }

  /** Publish abandonment when no durable attempt event can be committed. */
  abandon(): void {
    if (this.terminal) return
    this.terminal = true
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'end',
        attemptId: this.attemptId,
        revision: this.nextRevision(),
        index: this.index,
        outcome: { kind: 'abandoned' },
      },
    })
  }
}

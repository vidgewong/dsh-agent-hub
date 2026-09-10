/**
 * Codex loop Agent: drives one session through turn and step boundaries by
 * spawning a `codex app-server` child process and speaking JSON-RPC over stdio.
 * Codex owns its prompt, tools, and sandbox; the durable session log remains
 * the source of truth and the thread input is a pure serialization of it.
 * The app-server streams token-level deltas via `item/agentMessage/delta` and
 * `item/reasoning/summaryTextDelta`, so the visible partial paints
 * progressively as the model generates — not all at once at the end. It offers
 * no interactive approval callback, so permissions are folded declaratively
 * into each thread's `sandboxMode`/`approvalPolicy`.
 *
 * @module dsh-omniloop/engine-codex/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
} from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { LlmError, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk, AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { PluginInbox } from '../driver-core/inbox.ts'
import { PluginAssistantStream } from '../driver-core/assistant-stream.ts'
import type { ResolvedConfig } from './types.ts'
import { serializeHistory } from '../driver-core/prompt.ts'
import { resolveSessionPermission, type CodexPermission } from './permission.ts'
import { AppServerClient } from './appserver/client.ts'
import { AppServerThread } from './appserver/thread.ts'
import { mapCommandExecution, mapFileChange, mapMcpToolCall, mapUsage } from './appserver/mapping.ts'
import type { ThreadStartParams, TurnInput } from './appserver/types.ts'
import {
  invokedSkillNames,
  isSkillName,
  renderSkillContent,
  type SkillDefinition,
  type SkillsService,
} from '../driver-core/skill-inject.ts'

/** Provider route label used for logged header snapshots and message provenance. */
const PROVIDER = 'codex'
/**
 * Model label logged when the deployment pins no model: Codex owns its model
 * natively, so the web session's advisory model selection is deliberately not
 * mirrored into the header (it never drives a query).
 */
const NATIVE_MODEL_LABEL = 'codex-native'

/* jscpd:ignore-start -- mirrors the Claude Code driver; the two engines share the default agent-loop driver's phase machine. */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }

/** An assistant message held until the step knows whether turn usage attaches to it. */
interface HeldMessage {
  readonly content: ContentBlock[]
  /** Compact embedded stream of the chunks that streamed this message's live partial. */
  readonly stream: AssistantStreamRecord[]
  /** The live streaming attempt to settle when this message commits. */
  readonly attempt: PluginAssistantStream | undefined
}

/** Drives one session through turn and step boundaries on Codex. */
export class CodexAgent implements Agent {
  readonly inbox: PluginInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false

  /** Attached-session-local attempt counter for embedded assistant streams. */
  private assistantAttemptCounter = 0
  /** Monotone revision for live assistant-stream frames within this lifecycle. */
  private assistantStreamRevision = 0

  /** Lazily created app-server client, reused across steps and released on scope teardown. */
  private appServer: AppServerClient | undefined

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly config: ResolvedConfig,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    const lastTurn = session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.inbox = new PluginInbox(this.ctx.sessionProjections, session, this.dispatch)
    this.scope.ctx.effect(() => () => this.inbox.release(), 'codex.inbox()')
    // Release the shared app-server client when the agent scope is unwound.
    this.scope.ctx.effect(() => () => {
      this.appServer?.dispose()
      this.appServer = undefined
    }, 'codex.appServerClient()')
  }

  /** Return the cached app-server client, spawning one on first use or after a dead process. */
  private async appServerClient(): Promise<AppServerClient> {
    if (this.appServer !== undefined && !this.appServer.closed) return this.appServer
    this.appServer = await AppServerClient.create()
    return this.appServer
  }

  /** Mint a fresh embedded assistant stream attempt for one durable message. */
  private newAssistantStream(turn: number, step: number): PluginAssistantStream {
    return new PluginAssistantStream(
      this.id, ++this.assistantAttemptCounter,
      () => ++this.assistantStreamRevision, turn, step, this.dispatch,
    )
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  /**
   * Queue a message for the next turn and wake the driver.
   * @param input - the user message to deliver.
   */
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  /**
   * Queue a message for the running step and wake the driver.
   * @param input - the user message to deliver.
   */
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  /**
   * Queue a message for the running step without waking the driver.
   * @param input - the user message to deliver.
   */
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  /**
   * Run a maintenance job while the agent is idle.
   * @param job - the maintenance operation, receiving the phase abort signal.
   * @returns the maintenance result.
   */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore start -- kick owns a running phase until this driver boundary */
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }      /* v8 ignore stop */
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore start -- private callers establish the running phase before proposing a step */
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)    /* v8 ignore stop */
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: claimed }),
    )
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    // Inject skill content for user-invoked skills.  The dsh-tool-skill
    // handler that normally does this lives on the agent-preset context
    // chain, which the Codex agent's context does not descend from, so we
    // replicate the gesture-scan and injection here.
    const injected = await this.injectSkills(decision.messages, signal)
    signal.throwIfAborted()
    return injected !== decision.messages
      ? { kind: 'enter', messages: [...injected] }
      : { ...decision }
  }

  /**
   * Scan the step's user messages for `/name` skill gestures, load each
   * matching skill, and inject the rendered skill content into the message
   * batch.  This mirrors what dsh-tool-skill does for the in-process engine.
   * @param messages - the current step's message batch.
   * @param signal - cancellation signal (aborted loads are silently dropped).
   * @returns the original batch when no skill was invoked, or an extended
   *   batch with injected skill-content messages appended.
   */
  private async injectSkills(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]> {
    const names = invokedSkillNames(messages)
    if (names.length === 0) return messages
    const skills = this.loopCtx.get('skills') as SkillsService | undefined
    if (skills === undefined) return messages
    const cwd = this.session.header.cwd
    const injections: UserMessage[] = []
    for (const name of names) {
      /* v8 ignore start -- SKILL_GESTURE only captures kebab-case names, so this guard never fires */
      /* v8 ignore next -- SKILL_GESTURE only captures kebab-case names, so this guard never fires */
      if (!isSkillName(name)) continue
      /* v8 ignore stop */
      let skill: SkillDefinition | undefined
      try {
        skill = await skills.get(name, { signal, scope: this, ...(cwd === undefined ? {} : { cwd }) })
      } catch {
        continue // load failure → silently skip
      }
      if (skill === undefined || !skill.invocation.userInvocable) continue
      if (signal.aborted) return messages
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source: { kind: 'skill-invocation', name, form: 'instructions' },
      }))
    }
    return injections.length > 0 ? [...messages, ...injections] : messages
  }

  /**
   * Resolve the declarative permission stance for one query. Deployment-pinned
   * fields win per field; anything unpinned follows the session's durable dsh
   * permission knobs, re-folded per query so mid-session preset switches take
   * effect on the next step.
   * @returns the permission fields of the query spec.
   */
  private queryPermission(): CodexPermission {
    const fold = resolveSessionPermission(this.session.snapshotEvents())
    return {
      sandboxMode: this.config.sandboxMode ?? fold.sandboxMode,
      approvalPolicy: this.config.approvalPolicy ?? fold.approvalPolicy,
    }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          const stepEnd = await this.step()
          if (turnEnds === null) turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /** Model label recorded in the request header for one lifecycle. */
  private modelLabel(): string {
    return this.config.model ?? NATIVE_MODEL_LABEL
  }

  /** Append the request header snapshot once per loop instance. */
  private assertRequestHeader(): void {
    if (this.requestHeaderLogged) return
    const header = canonicalHeader({
      config: { provider: PROVIDER, model: this.modelLabel() },
    })
    const baseline = this.session.requestHeader()
    this.session.append('request/header', {
      header,
      reason: baseline === undefined ? 'initial' : 'resume',
    })
    this.requestHeaderLogged = true
  }

  /** Run one Codex thread for the current step and map its transcript into the session log. */
  private async step(): Promise<StepEndReason | null> {
    /* v8 ignore start -- private callers establish the running phase before executing a step */
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)    /* v8 ignore stop */
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    const cwd = this.session.header.cwd
    if (cwd === undefined || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory — start the session with cwd metadata`)
    }
    const history: Message[] = this.session.deriveMessages()
    const prompt = serializeHistory(history)
    /* v8 ignore start -- a step only runs after claiming and durably appending at least one user message */
    if (prompt.length === 0) {
      throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`)
    }
    /* v8 ignore stop */
    this.assertRequestHeader()
    signal.throwIfAborted()

    const controller = new AbortController()
    const cancel = (): void => {
      /* v8 ignore start -- a phase signal fires once; the controller cannot already be aborted when its single listener runs */
      /* v8 ignore next -- a phase signal fires once; the controller cannot already be aborted when its single listener runs */
      if (!controller.signal.aborted) {
        /* v8 ignore next -- the phase signal aborts with AgentCancelCause values only, which the durable log can record */
        controller.abort(signal.reason instanceof Error ? signal.reason : new Error(`agent "${this.id}" query aborted`))
      }      /* v8 ignore stop */
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const permission = this.queryPermission()
      const client = await this.appServerClient()
      const threadParams: ThreadStartParams = {
          cwd,
          sandbox: permission.sandboxMode,
          approvalPolicy: permission.approvalPolicy,
          ...this.config.model === undefined ? {} : { model: this.config.model },
        }
        const thread = await AppServerThread.create(client, threadParams)
        const input: TurnInput[] = [{ type: 'text', text: prompt }]
        const events = thread.turn(input, {
          signal: controller.signal,
          params: {
            approvalPolicy: permission.approvalPolicy,
            ...this.config.model === undefined ? {} : { model: this.config.model },
          },
        })

        let finished = false
        /** Reasoning texts accumulated since the last flush, folded into the next agent message or flushed as a trailing reasoning message. */
        const pendingReasoning: string[] = []
        /** The assistant message being assembled; its chunks stream live as items complete. */
        let held: HeldMessage | undefined
        /** Whether a reasoning block has been started (block-start emitted). */
        let reasoningBlockStarted = false
        /** Whether a text block has been started (block-start emitted). */
        let textBlockStarted = false
        /** Block index for the current text block. */
        let textBlockIndex = 0

        /**
         * Live embedded assistant stream for the message currently accumulating.
         * Created lazily on the first streamed chunk and reset once its durable
         * message is held; its compact records embed in the settling event and
         * its transient frames drive the live partial.
         */
        let attempt: PluginAssistantStream | undefined
        /** Whether the current attempt has emitted its opening frame. */
        let attemptStarted = false

        /** Emit one live partial chunk into the current attempt. */
        const emitChunk = (chunk: StreamChunk): void => {
          attempt ??= this.newAssistantStream(turn, step)
          if (!attemptStarted) { attempt.start(); attemptStarted = true }
          attempt.push(chunk)
        }

        /** Append the held assistant message, optionally carrying the turn's usage. */
        const flushHeld = (usage?: TokenUsage): void => {
          if (held === undefined) return
          const message = held
          const append = (): SessionSeq => this.session.append('assistant/message', {
            turn,
            step,
            message: createAssistantMessage({
              content: message.content,
              source: { provider: PROVIDER, model: this.modelLabel() },
            }),
            stream: message.stream,
            ...usage === undefined ? {} : { usage },
          }, {
            surfaceOp: 'append',
          }).seq
          // Publish the terminal stream frame only after the durable message
          // commits; append() alone when no chunk ever streamed the message.
          if (message.attempt !== undefined && !message.attempt.ended) {
            message.attempt.settle('assistant/message', append)
          } else {
            append()
          }
          held = undefined
        }
        /** Capture and reset the live attempt for the message about to be held. */
        const captureAttempt = (): { stream: AssistantStreamRecord[]; attempt: PluginAssistantStream | undefined } => {
          const captured = { stream: attempt?.stream ?? [], attempt }
          attempt = undefined
          attemptStarted = false
          return captured
        }
        /** Flush accumulated reasoning as its own durable message; an agent message folds it instead. */
        const flushReasoning = (usage?: TokenUsage): void => {
          if (pendingReasoning.length === 0) return
          flushHeld()
          const captured = captureAttempt()
          held = {
            content: pendingReasoning.map(text => ({ type: 'reasoning' as const, text })),
            stream: captured.stream,
            attempt: captured.attempt,
          }
          pendingReasoning.length = 0
          flushHeld(usage)
        }

        signal.throwIfAborted()
        for await (const event of events) {
          signal.throwIfAborted()
          switch (event.kind) {
            case 'turn-started':
              break
            case 'item-started': {
              // item-started carries the item type; block-start is emitted on the first delta.
              if (event.itemType === 'agentMessage') {
                textBlockStarted = false
                textBlockIndex = pendingReasoning.length
              }
              break
            }
            case 'agent-delta': {
              // Token-level streaming of the agent's reply — live.
              if (!textBlockStarted) {
                textBlockStarted = true
                emitChunk({ type: 'block-start', index: textBlockIndex, blockType: 'text' })
              }
              emitChunk({ type: 'text-delta', index: textBlockIndex, text: event.delta })
              break
            }
            case 'reasoning-summary-delta':
            case 'reasoning-text-delta':
            case 'plan-delta': {
              // Token-level streaming of the model's thinking — live.
              const index = pendingReasoning.length
              if (!reasoningBlockStarted) {
                reasoningBlockStarted = true
                emitChunk({ type: 'block-start', index, blockType: 'reasoning' })
              }
              emitChunk({ type: 'reasoning-delta', index, text: event.delta })
              break
            }
            case 'item-completed': {
              const item = event.item
              if (item.type === 'reasoning') {
                // Reasoning item completed — accumulate for the fold.
                const summary = (item as { summary?: string[] }).summary
                const content = (item as { content?: string[] }).content
                const text = summary?.join('\n') ?? content?.join('\n') ?? ''
                pendingReasoning.push(text)
                reasoningBlockStarted = false
              } else if (item.type === 'agentMessage') {
                // Agent message completed — fold reasoning + text into one message.
                flushHeld()
                const captured = captureAttempt()
                held = {
                  content: [
                    ...pendingReasoning.map(text => ({ type: 'reasoning' as const, text })),
                    { type: 'text' as const, text: item.text ?? '' },
                  ],
                  stream: captured.stream,
                  attempt: captured.attempt,
                }
                pendingReasoning.length = 0
                reasoningBlockStarted = false
                textBlockStarted = false
              } else if (item.type === 'commandExecution') {
                flushReasoning()
                flushHeld()
                const activity = mapCommandExecution(item as { id: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string })
                this.session.append('tool/call', {
                  turn, step, callId: activity.call.callId, name: activity.call.name, arguments: activity.call.arguments,
                })
                this.session.append('tool/result', { turn, step, message: activity.result }, { surfaceOp: 'append' })
              } else if (item.type === 'fileChange') {
                flushReasoning()
                flushHeld()
                const activity = mapFileChange(item as { id: string; changes?: unknown[]; status?: string })
                this.session.append('tool/call', {
                  turn, step, callId: activity.call.callId, name: activity.call.name, arguments: activity.call.arguments,
                })
                this.session.append('tool/result', { turn, step, message: activity.result }, { surfaceOp: 'append' })
              } else if (item.type === 'mcpToolCall') {
                flushReasoning()
                flushHeld()
                const activity = mapMcpToolCall(item as { id: string; server?: string; tool?: string; arguments?: unknown; result?: { content?: unknown[] }; error?: { message?: string } })
                this.session.append('tool/call', {
                  turn, step, callId: activity.call.callId, name: activity.call.name, arguments: activity.call.arguments,
                })
                this.session.append('tool/result', { turn, step, message: activity.result }, { surfaceOp: 'append' })
              }
              break
            }
            case 'turn-completed': {
              const usage = event.turn.usage
                ? mapUsage(event.turn.usage)
                : undefined
              // Turn usage attaches to the step's final durable message: the
              // trailing reasoning-only message when thinking closed the turn,
              // otherwise the last held agent message.
              if (pendingReasoning.length > 0) flushReasoning(usage)
              else flushHeld(usage)
              finished = true
              break
            }
            case 'error':
              flushReasoning()
              flushHeld()
              throw new LlmError(event.error.message, 'CODEX_ERROR')
            /* v8 ignore next -- AppServerEvent is a closed union; no unknown kinds */
            default:
              break
          }
        }
        flushReasoning()
        flushHeld()
        if (!finished) {
          throw new LlmError(
            `agent "${this.id}": codex query ended without a completed turn`,
            'CODEX_NO_RESULT',
          )
        }
        return { kind: 'completed' }
    } finally {
      signal.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
/* jscpd:ignore-end */

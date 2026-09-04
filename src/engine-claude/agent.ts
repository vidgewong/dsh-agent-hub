/**
 * Claude Code loop Agent: drives one session through turn and step boundaries
 * with one Claude Agent SDK query per step. Claude Code owns its prompt,
 * tools, and permissions; the durable session log remains the source of truth
 * and the query prompt is a pure serialization of it.
 *
 * @module dsh-agent-hub/engine-claude/agent
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
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, LlmCallConfig, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { LlmError, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionId, canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { SDKResultError } from '@anthropic-ai/claude-agent-sdk'
import type { ResolvedConfig } from './types.ts'
import {
  mapAssistantMessage,
  mapStreamEvent,
  mapToolResults,
  maxChunkIndex,
  rebaseChunkIndices,
  type StreamToolCall,
} from './mapping.ts'
import { serializeHistory } from '../driver-core/prompt.ts'
import { CLAUDE_CODE_SDK, missingSdkError } from '../driver-core/missing-sdk.ts'
import { approvalReason, resolveSessionPermission } from './permission.ts'
import { DEFAULT_PERMISSION_MODE, claudeQueryOptions, type ClaudeCodeQuerySpec } from './sdk.ts'
import { deriveProviderEnv } from './provider-env.ts'
import {
  invokedSkillNames,
  isSkillName,
  renderSkillContent,
  type SkillDefinition,
  type SkillsService,
} from '../driver-core/skill-inject.ts'

/**
 * Engine label stamped on each assistant message's `source.provider`.
 *
 * This is provenance, not routing: it says which engine produced the message,
 * and nothing resolves it against `ctx.llm`. The *header*'s provider is a
 * different value entirely — see {@link ClaudeCodeAgent.assertRequestHeader}.
 */
const PROVIDER = 'claude-code'

/** The official SDK's `query`, resolved on first use. */
type OfficialQuery = typeof import('@anthropic-ai/claude-agent-sdk')['query']

/** Memoized module load, so a session's steps do not re-resolve the SDK. */
let claudeQueryPromise: Promise<OfficialQuery> | undefined

/**
 * Resolve the official SDK's `query` on first use.
 *
 * Deliberately dynamic. The SDK is an optional peer: a deployment that never
 * selects the Claude Code engine should not have to install it, and this module
 * is reached from the plugin's static import graph — a top-level import would
 * make a missing package fail the whole plugin tree at load time, taking every
 * other engine down with it. Importing here confines the failure to the engine
 * that actually needs it, and surfaces it as a turn error naming the fix.
 *
 * @returns the SDK's `query` function.
 * @throws when the optional peer is not installed.
 */
async function loadClaudeQuery(): Promise<OfficialQuery> {
  claudeQueryPromise ??= import('@anthropic-ai/claude-agent-sdk').then(
    (mod) => mod.query,
    (error: unknown) => {
      // Clear the slot so a later step retries rather than replaying a failure
      // the user may have fixed by installing the package in the meantime.
      claudeQueryPromise = undefined
      throw missingSdkError(CLAUDE_CODE_SDK, error)
    },
  )
  return claudeQueryPromise
}
/**
 * Model label logged when no layer named a model: Claude Code then owns its
 * model natively, and the header still has to say something.
 */
const NATIVE_MODEL_LABEL = 'claude-code-native'

/**
 * Provider label logged beside {@link NATIVE_MODEL_LABEL} when no layer named a
 * route either.
 *
 * A header must carry a provider, and every honest candidate is wrong here:
 * naming a real route would claim a backend the child was never pointed at, and
 * an empty string reads as a missing field. So the header names the engine, and
 * the composer stays blocked until a model is picked — which is correct, because
 * at this point dsh genuinely does not know where the turn went.
 */
const NATIVE_PROVIDER_LABEL = PROVIDER

/** Minimal shape of the approval service (inline to avoid a peer dep on @deepseek-ai/dsh-user-approval). */
interface ApprovalService {
  request(req: { agent: Agent; toolName: string; reason?: string; signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** Minimal shape of the default-model service (inline to avoid a peer dep on @deepseek-ai/dsh-agent-default-model). */
interface AgentDefaultModelService {
  currentSelection(): { provider: string; model: string }
}

/** Which layer chose the model the child runs. */
type ModelSource = 'selection' | 'session' | 'default' | 'config' | 'native'

/** The model one query runs on, and where the choice came from. */
interface ResolvedModel {
  /** Provider-owned model id, or undefined to leave the CLI on its own default. */
  model: string | undefined
  /** Registered provider route the id belongs to, when a selection named one. */
  provider: string | undefined
  source: ModelSource
}

/* jscpd:ignore-start -- mirrors default agent-loop driver; depending on agent-loop is forbidden. */
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

/** Map one SDK result failure subtype to a stable provider-neutral code. */
function failureCode(subtype: SDKResultError['subtype']): string {
  switch (subtype) {
    case 'error_during_execution':
    case 'error_max_turns':
    case 'error_max_budget_usd':
    case 'error_max_structured_output_retries':
      return `CLAUDE_CODE_${subtype.toUpperCase()}`
    default:
      return 'CLAUDE_CODE_ERROR'
  }
}

/**
 * Descriptor version stamped into every `subagent/descriptor` event. Matches
 * `@deepseek-ai/dsh-subagent/descriptor.SUBAGENT_DESCRIPTOR_VERSION` so the
 * native projection unit classifies these child sessions correctly.
 */
const SUBAGENT_DESCRIPTOR_VERSION = 3

/** Minimal session store shape (avoiding a peer dep on SessionStore). */
interface SessionStoreLike {
  prepare(id?: SessionId, options?: {
    meta?: {
      cwd?: string
      parentSession?: SessionId
      origin?: 'subagent'
      delegationDepth?: number
    }
  }): Session
  enter(session: Session): () => void
  announce(session: Session): void
}

/** Minimal agent registry shape used to publish subagent activity. */
interface AgentRegistryLike {
  enter(agent: Agent, owner: Agent | undefined): () => void
  announce(agent: Agent): void
}

/**
 * One SDK-driven subagent transcript materialised as a dsh child session. The
 * child session has `origin: 'subagent'` in its header and a
 * `subagent/descriptor` event, so `dsh-client-ui-subagent` discovers it through
 * the lineage breadcrumbs and can render its own trajectory in the right panel.
 *
 * Each instance maps one `parent_tool_use_id` to one child session. The parent
 * session sees only the Task tool call and its final result; the child session
 * stores the full subagent transcript (streaming chunks, assistant messages,
 * tool calls, and tool results).
 *
 * It is also a live {@link Agent} in the registry. The Host derives each
 * catalog row's `activity` from `ctx.agents.get(id)?.status`, so a child that
 * exists only as a Session always reads as inactive and the lineage renders a
 * settled green dot while the subagent is still working. Registering the child
 * makes `agent/status` transitions real, which is what drives the running
 * animation. The SDK owns the child's turn, so this agent is transcript-only:
 * it reports status and refuses input rather than driving a loop.
 */
class SubagentChildSession implements Agent {
  readonly session: Session
  readonly id: SessionId
  readonly options: AgentOptions
  readonly inbox: Inbox
  readonly scope: Scope
  readonly ctx: Context
  /** Detach the child session from the live store so it shows as inactive. */
  private readonly detach: () => void
  /** Remove the child agent from the registry once the subagent settles. */
  private detachAgent: (() => void) | undefined
  /** Fused dispatcher for this child's `agent/status` transitions. */
  private readonly dispatch: AgentEventDispatch
  /** Live status; `running` from creation until the subagent settles. */
  private currentStatus: AgentStatus = 'idle'
  /** dsh turn counter inside the child session. */
  turn = 0
  /** dsh step counter inside the current turn. */
  step = 0
  /** Whether the child's current step has already published its assistant/message. */
  stepFlushed = false
  /** Coalesced content blocks of the child's current API turn. */
  pendingContent: ContentBlock[] = []
  /** Latest usage for the pending API turn. */
  pendingUsage: TokenUsage | undefined
  /** Model id from the pending turn. */
  pendingModel: string | undefined
  /** `message.id` of the accumulating child API turn. */
  pendingMessageId: string | undefined
  /** Per-block-index tool identity for child stream events. */
  toolCalls = new Map<number, StreamToolCall>()
  /** Accumulated reasoning per rebased block index. */
  reasoningByIndex = new Map<number, string>()
  /** Chunk seqs for source linking. */
  chunkSeqs: SessionSeq[] = []
  /** Call ids published by the child, for result pairing. */
  ownCallIds = new Set<string>()
  /** Block-index rebase state. */
  blockOffset = 0
  maxSeenIndex = -1
  lastRawStart: number | undefined
  /** Whether the Task prompt has been seeded as the child's first user message. */
  private seeded = false

  constructor(
    loopCtx: Context,
    parentAgent: Agent,
    sessions: SessionStoreLike,
    agents: AgentRegistryLike | undefined,
    label: string | undefined,
    provider: string,
    /** Initial prompt text from the Task tool arguments. */
    prompt: string | undefined,
  ) {
    const parentHeader = parentAgent.session.header
    const childId = SessionId(randomUUID())
    this.id = childId
    this.options = parentAgent.options
    this.session = sessions.prepare(childId, {
      meta: {
        ...parentHeader.cwd === undefined ? {} : { cwd: parentHeader.cwd },
        parentSession: parentHeader.id,
        origin: 'subagent',
        delegationDepth: (parentHeader.delegationDepth ?? 0) + 1,
      },
    })
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(this.session, {
      inserted: () => undefined,
      discarded: () => undefined,
      claimed: () => undefined,
    })
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.detach = sessions.enter(this.session)
    // Append the descriptor so the projection unit classifies the child.
    // The type name is augmented by @deepseek-ai/dsh-subagent (an optional
    // peer); the cast avoids a hard dependency while the data matches the
    // descriptor schema the projection fold requires.
    const sessionAny = this.session as { append(type: string, data: unknown, options?: unknown): { seq: number } }
    sessionAny.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider,
      ...label === undefined ? {} : { label },
    })
    sessions.announce(this.session)

    // Enter the agent registry BEFORE flipping to `running`, so the Host's
    // `agent/status` frame lands on a session the client already knows and the
    // lineage row animates for the whole subagent, not just its tail.
    if (agents !== undefined) {
      this.detachAgent = agents.enter(this, parentAgent)
      agents.announce(this)
      this.setStatus('running')
    }

    // Log a request header so the session shows which model it ran on.
    this.session.append('request/header', {
      header: canonicalHeader({ config: { provider, model: NATIVE_MODEL_LABEL } }),
      reason: 'initial' as const,
    })

    // Append the Task prompt as the child's first user message so the
    // user can see what the subagent was asked to do.
    this.seedPrompt(prompt)
  }

  get status(): AgentStatus {
    return this.currentStatus
  }

  /** Publish a status transition; the Host turns this into a session-status frame. */
  private setStatus(next: AgentStatus): void {
    if (this.currentStatus === next) return
    this.currentStatus = next
    this.dispatch.emit('agent/status', { status: next })
  }

  // ---- Agent surface -----------------------------------------------------
  //
  // The SDK drives this transcript; nothing here accepts input or owns a turn.
  // The registry entry exists so the child reports live activity, so the input
  // paths are inert rather than half-implemented. Host routing already refuses
  // to deliver to an `origin: 'subagent'` session, so these are unreachable
  // through the API surface.

  /* v8 ignore start -- inert Agent surface; the SDK owns this transcript */
  send(): void {}
  followup(): void {}
  steer(): void {}
  inject(): void {}
  cancel(): void {}
  runMaintenance<T>(): Promise<T> {
    return Promise.reject(new Error(`subagent "${this.id}" does not run maintenance`))
  }
  whenIdle(): Promise<void> {
    return Promise.resolve()
  }
  /* v8 ignore stop */


  /**
   * Seed the Task prompt as the child's first user message. `task_started` is
   * not ordered against the first subagent frame, so a child may be created
   * before its prompt is known; `adopt` calls back here once it arrives. The
   * seed happens at most once.
   */
  seedPrompt(prompt: string | undefined): void {
    if (this.seeded) return
    if (prompt === undefined || prompt.length === 0) return
    this.seeded = true
    this.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }

  /** Open the first (or next) turn in the child session. */
  openTurn(): void {
    this.turn += 1
    this.step = 1
    this.session.append('turn/start', { turn: this.turn })
    this.session.append('step/start', { turn: this.turn, step: this.step })
    this.stepFlushed = false
    this.chunkSeqs = []
    this.toolCalls.clear()
    this.reasoningByIndex.clear()
    this.blockOffset = 0
    this.maxSeenIndex = -1
    this.lastRawStart = undefined
  }

  /** Roll to the next step within the current turn. */
  rollStep(): void {
    this.session.append('step/end', { turn: this.turn, step: this.step })
    this.step += 1
    this.session.append('step/start', { turn: this.turn, step: this.step })
    this.stepFlushed = false
    this.chunkSeqs = []
    this.toolCalls.clear()
    this.reasoningByIndex.clear()
    this.blockOffset = 0
    this.maxSeenIndex = -1
    this.lastRawStart = undefined
  }

  /** Flush coalesced assistant content. */
  flushAssistant(): void {
    if (this.pendingContent.length === 0) return
    const content = this.pendingContent
    const usage = this.pendingUsage
    const model = this.pendingModel ?? NATIVE_MODEL_LABEL
    this.pendingContent = []
    this.pendingUsage = undefined
    this.pendingModel = undefined
    this.reasoningByIndex.clear()
    this.session.append('assistant/message', {
      turn: this.turn,
      step: this.step,
      message: createAssistantMessage({
        content,
        source: { provider: PROVIDER, model },
      }),
      ...usage === undefined ? {} : { usage },
    }, {
      surfaceOp: 'append',
      ...this.chunkSeqs.length === 0 ? {} : { sourceEventSeqs: [...this.chunkSeqs] },
    })
    this.stepFlushed = true
  }

  /** Close the current turn and detach the child from the live session store. */
  closeTurn(): void {
    if (this.turn === 0) return
    this.flushAssistant()
    this.session.append('step/end', { turn: this.turn, step: this.step })
    this.session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
    // Mark the session as ended and detach it from the live store so the
    // UI shows it as inactive rather than perpetually running/green.
    this.session.append('session/end-seed', {})
    // Settle the status BEFORE unregistering: the Host reads `status` when it
    // builds the catalog, and `agent/disposed` fires on detach. Flipping first
    // means the last frame the client sees for this child is `running: false`,
    // so the row lands on the settled dot instead of animating forever.
    this.setStatus('idle')
    this.detachAgent?.()
    this.detachAgent = undefined
    void this.scope.dispose()
    this.detach()
    this.turn = 0 // prevent double-close
  }
}

/** Drives one session through turn and step boundaries on Claude Code. */
export class ClaudeCodeAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly config: ResolvedConfig,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
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
    // chain, which the Claude Code agent's context does not descend from,
    // so we replicate the gesture-scan and injection here.
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
   * Resolve the native permission handling for one query. A deployment-pinned
   * mode wins outright; otherwise the session's durable dsh permission knobs
   * decide per query (mid-session preset switches included): full access
   * bypasses native checks, an `ask` policy forwards each native permission
   * request to the dsh approval seam, and anything else fails closed with the
   * unattended deny-all stance.
   * @returns the permission fields of the query spec.
   */
  private queryPermission(): Pick<ClaudeCodeQuerySpec, 'permissionMode' | 'onToolPermission'> {
    if (this.config.permissionMode !== undefined) return { permissionMode: this.config.permissionMode }
    const permission = resolveSessionPermission(this.session.snapshotEvents())
    if (permission.kind === 'bypass') return { permissionMode: 'bypassPermissions' }
    if (permission.kind === 'ask') {
      const approval = this.loopCtx.get('approval') as ApprovalService | undefined
      if (approval !== undefined) {
        return {
          permissionMode: 'default',
          onToolPermission: async (toolName, input, signal) => {
            const outcome = await approval.request({
              agent: this,
              toolName,
              reason: approvalReason(toolName, input),
              signal,
            })
            return outcome === 'allowed-once' ? 'allow' : 'deny'
          },
        }
      }
    }
    return { permissionMode: DEFAULT_PERMISSION_MODE }
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
          // step() may have opened further steps for later SDK rounds; close
          // whichever one is actually open (phase.step), not the one this
          // iteration opened.
          this.session.append('step/end', { turn, step: phase.step })
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

  /**
   * Resolve the model one query runs on, per-session selection first.
   *
   * The layers, in precedence order:
   *
   *  1. **The `agent/request` waterfall.** This is the seam the dsh model
   *     picker actually drives. api-proxy installs `installModelSelection` on
   *     every agent's own context, which listens on `system-prompt/assemble`
   *     to *snapshot* the session's selection and on `agent/request` to *apply*
   *     the snapshot — two stages, so a mid-turn switch lands on a later step
   *     rather than splitting the prompt from the route. Both must be
   *     dispatched, and in that order: the request listener reads
   *     `selection.assembled`, which only the assemble listener writes, so
   *     dispatching the request waterfall alone yields nothing.
   *  2. `AgentOptions.model` — the create-time seed.
   *  3. `agentDefaultModel` — the global default.
   *  4. The deployment's pinned `config.model`.
   *  5. Nothing, leaving the CLI on its own model.
   *
   * Every layer is optional and every failure degrades to the next one: a
   * minimal profile mounts neither service, and a listener that throws must
   * cost this session its turn no more than a missing service does.
   *
   * @param signal - the step's cancellation signal, forwarded to prompt assembly.
   * @returns the chosen id (undefined leaves the CLI on its own default),
   * its provider route, and the layer that chose it.
   */
  private async resolveModel(signal: AbortSignal): Promise<ResolvedModel> {
    const selected = await this.selectionFromWaterfall(signal)
    if (selected !== undefined) return selected
    if (this.options.model !== undefined) {
      return { model: this.options.model, provider: this.options.provider, source: 'session' }
    }
    const defaults = this.loopCtx.get('agentDefaultModel') as AgentDefaultModelService | undefined
    if (defaults !== undefined) {
      try {
        const selection = defaults.currentSelection()
        if (selection.model !== '') {
          return { model: selection.model, provider: selection.provider, source: 'default' }
        }
      } catch (error: unknown) {
        this.ctx.logger.warn('claude-code: default model selection unavailable: %s', error)
      }
    }
    if (this.config.model !== undefined) {
      return { model: this.config.model, provider: undefined, source: 'config' }
    }
    return { model: undefined, provider: undefined, source: 'native' }
  }

  /**
   * Ask the host what this session is routed to, through the two waterfalls
   * that carry a per-session selection.
   *
   * The seed handed to `agent/request` is the same one the in-process loop
   * seeds with — the agent's own options — so a host that installs no listener
   * gets its own answer back and this returns undefined, leaving the layers
   * below untouched. A listener that replaces it wins.
   *
   * The assemble pass is dispatched for its *side effect* on the selection
   * state; its returned prompt is discarded, because Claude Code builds its own
   * prompt and dsh's assembly never reaches the child. That makes this a real
   * (if small) cost per step: the host's prompt providers run and their output
   * is dropped. It is the price of reaching a selection whose only publisher is
   * that listener pair.
   *
   * @param signal - the step's cancellation signal.
   * @returns the selection when a listener supplied one, else undefined.
   */
  private async selectionFromWaterfall(signal: AbortSignal): Promise<ResolvedModel | undefined> {
    const phase = this.phase
    /* v8 ignore start -- step() is the sole caller and establishes the running phase before resolving */
    /* v8 ignore next -- step() is the sole caller and establishes the running phase before resolving */
    if (phase.kind !== 'running') return undefined
    /* v8 ignore stop */
    const { turn, step } = phase
    const seed: LlmCallConfig = {
      provider: this.options.provider ?? '',
      model: this.options.model ?? '',
    }
    try {
      const systemPrompt = this.loopCtx.get('systemPrompt')
      if (systemPrompt !== undefined) {
        await systemPrompt.assemble(assembleContextFor(this, signal))
      }
      const proposed = await this.dispatch.waterfall(
        'agent/request',
        { turn, step, signal },
        () => Promise.resolve(seed),
      )
      if (proposed.model === '' || proposed.provider === '') return undefined
      if (proposed.provider === seed.provider && proposed.model === seed.model) return undefined
      return { model: proposed.model, provider: proposed.provider, source: 'selection' }
    } catch (error: unknown) {
      // A host listener is not this engine's to trust with the turn. Degrading
      // costs the session its per-session selection; propagating would cost it
      // the turn, on a path a minimal profile does not even have.
      this.ctx.logger.warn('claude-code: per-session model selection unavailable: %s', error)
      return undefined
    }
  }

  /**
   * Append the request header, and re-append it whenever the route changes.
   *
   * The provider written here is the **real** dsh route (`copilot-proxy`,
   * `amazon-bedrock`, …), not this engine's name. That is not cosmetic:
   * api-proxy re-reads this field on every read as "the model this session is
   * on", resolves it against `ctx.llm.listProviders()`, and locks the composer
   * when the name is not a registered provider — so writing the engine name
   * here made every session demand a fresh model pick after each turn. The
   * engine that ran the turn is recorded in the `*.loop-engine.json` sidecar,
   * which is where per-session engine provenance already lives.
   *
   * Re-logging on change mirrors the in-process loop: the header is the log's
   * record of what each request ran under, so a mid-session model switch has to
   * produce a new snapshot or the log misattributes every later turn.
   *
   * @param selected - the model resolved for the step about to run.
   */
  private noteRequestHeader(selected: ResolvedModel): void {
    const header = canonicalHeader({
      config: {
        provider: selected.provider ?? NATIVE_PROVIDER_LABEL,
        model: selected.model ?? NATIVE_MODEL_LABEL,
      },
    })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
      })
      this.requestHeaderLogged = true
      return
    }
    if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }
  }

  /** Run one Claude Code query for the current step and map its transcript into the session log. */
  private async step(): Promise<StepEndReason | null> {
    /* v8 ignore start -- private callers establish the running phase before executing a step */
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)    /* v8 ignore stop */
    const { turn, abort: { signal } } = this.phase
    // One SDK query can contain several assistant↔tool rounds. Each round is
    // mapped onto its OWN dsh step so the client trajectory (which groups nodes
    // by `turn:step` and anchors the assistant node to that step's last
    // assistant/message seq) interleaves each assistant message with the tool
    // calls it issued, instead of piling every tool call above one collapsed
    // assistant node. `step` is therefore mutable here, advanced by rollStep at
    // each round boundary; turn() closes whichever step this leaves open.
    let step = this.phase.step
    const phase = this.phase
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
    // Resolve the route BEFORE the header is written: the header records the
    // route this step runs on, so a resolution that happened after it would
    // log the previous step's answer.
    const selected = await this.resolveModel(signal)
    signal.throwIfAborted()
    this.noteRequestHeader(selected)
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
    const diagnostics: string[] = []

    // ---- Subagent child sessions ------------------------------------------
    //
    // SDK messages with `parent_tool_use_id !== null` are frames from a Task
    // tool's subagent. Instead of inlining them into the parent transcript
    // (which interleaves concurrent subagents and has no navigation), each
    // distinct `parent_tool_use_id` gets its own child session with
    // `origin: 'subagent'`. The `dsh-client-ui-subagent` package discovers
    // these through `listChildren(parentSessionId)` and renders them as
    // navigable entries in the header lineage breadcrumbs, each with its own
    // trajectory in the right panel — matching the native DeepSeek Loop.
    const sessionStore = this.loopCtx.get('sessions') as SessionStoreLike | undefined
    // The registry is what makes a child read as live: the Host derives each
    // catalog row's activity from `agents.get(id)?.status`. Absent, the child
    // still records its transcript but renders as already settled.
    const agentRegistry = this.loopCtx.get('agents') as AgentRegistryLike | undefined
    /** Per-parent_tool_use_id child sessions for subagent transcripts. */
    const childSessions = new Map<string, SubagentChildSession>()
    /** Per-tool_use_id Task metadata captured from task_started system messages. */
    const taskMeta = new Map<string, { description?: string; prompt?: string }>()
    /** tool_use_ids the SDK marked ambient; these never get a child session. */
    const skippedTasks = new Set<string>()
    /** Warn at most once per query when no session store is in scope. */
    let warnedNoStore = false

    /**
     * Get or create the child session for a given parent_tool_use_id.
     * The first frame for a tool id creates the session and opens its first turn.
     */
    const getChildSession = (parentToolUseId: string): SubagentChildSession | undefined => {
      if (sessionStore === undefined) {
        if (!warnedNoStore) {
          warnedNoStore = true
          diagnostics.push(
            `agent "${this.id}": no session store in scope; subagent transcripts were dropped`,
          )
        }
        return undefined
      }
      // Ambient/housekeeping tasks: the SDK asks consumers to keep these out
      // of the transcript, so they get no child session and no breadcrumb.
      if (skippedTasks.has(parentToolUseId)) return undefined
      let child = childSessions.get(parentToolUseId)
      if (child === undefined) {
        // `task_started` is not ordered against the first subagent frame. When
        // it has not landed yet the child opens without a label or seed prompt
        // rather than showing a raw tool id; the prompt is backfilled below.
        const meta = taskMeta.get(parentToolUseId)
        child = new SubagentChildSession(
          this.loopCtx,
          this,
          sessionStore,
          agentRegistry,
          meta?.description,
          PROVIDER,
          meta?.prompt,
        )
        childSessions.set(parentToolUseId, child)
        child.openTurn()
      }
      return child
    }

    try {
      // The route the selection names is dsh's own; derive the child's provider
      // environment from it rather than from whatever shell launched the host,
      // which a desktop-launched dsh does not have. Passed as `providerEnv` so
      // it displaces inheritance outright instead of merging with a stale
      // backend that would out-rank it; the deployment's `env` still layers on
      // top. When the route cannot be derived this is undefined and the child
      // environment is re-inherited exactly as before.
      const derived = await deriveProviderEnv(this.loopCtx, selected.provider)
      if (derived !== undefined) diagnostics.push(derived.diagnostic)
      const options = claudeQueryOptions({
        cwd,
        ...this.queryPermission(),
        env: this.config.env,
        ...derived === undefined ? {} : { providerEnv: derived.env },
        backend: this.config.backend,
        disposeGraceMs: this.config.disposeGraceMs,
        ...selected.model === undefined ? {} : { model: selected.model },
        ...selected.provider === undefined ? {} : { provider: selected.provider },
        ...this.config.maxTurns === undefined ? {} : { maxTurns: this.config.maxTurns },
        spawn: spec => this.loopCtx.subprocess.spawn(spec),
        onUnattended: (line) => { diagnostics.push(line) },
      }, controller)
      const officialQuery = await loadClaudeQuery()
      const query = officialQuery({ prompt, options })
      let finished = false
      /** Seq numbers of the `assistant/chunk` events that streamed the current step, for replay linking. */
      const chunkSeqs: SessionSeq[] = []
      /** Per-raw-block-index tool identity, seeded by `mapStreamEvent` at a tool `content_block_start`. */
      const toolCalls = new Map<number, StreamToolCall>()
      /** Accumulated reasoning per rebased block index, for the durable-message fallback below. */
      const reasoningByIndex = new Map<number, string>()

      // ---- One API turn, one dsh step, one assistant/message ----------------
      //
      // The CLI splits ONE model turn across several SDK `assistant` messages
      // that share a `message.id` — typically thinking, then narration text,
      // then the `tool_use`. The dsh client projects a step's assistant node
      // with LAST-WINS semantics (`blocks: toAssistantBlocks(message.content)`),
      // so appending each fragment separately made the trailing tool_use-only
      // fragment erase the narration; and because a tool-call-only node is
      // filtered out by `hasVisibleContent`, the step lost its anchor entirely
      // and every tool node piled above some later surviving assistant node.
      //
      // So fragments are COALESCED into one buffer keyed by `message.id` and
      // flushed as a single `assistant/message` immediately before the
      // `tool/call` events of that same API turn — keeping the assistant seq
      // below its tools, which is exactly the order the trajectory renders by.
      // A new `message.id`, or a second flush inside one step, rolls the step.

      /** Coalesced content blocks of the API turn currently accumulating. */
      let pendingContent: ContentBlock[] = []
      /** Latest provider-reported accounting seen for the accumulating turn. */
      let pendingUsage: TokenUsage | undefined
      /** Model id reported by the accumulating turn's fragments. */
      let pendingModel: string | undefined
      /** `message.id` of the accumulating API turn; a change starts a new one. */
      let pendingMessageId: string | undefined
      /** Whether this dsh step already appended its one `assistant/message`. */
      let stepFlushed = false
      /** Top-level call ids appended this query; nested results are filtered against it. */
      const ownCallIds = new Set<string>()

      // ---- Streamed block-index rebasing ------------------------------------
      //
      // The client addresses live blocks by `blocks[chunk.index]`. Each SDK
      // assistant fragment restarts `content_block` indices at 0, so without a
      // rebase the tool fragment's index 0 overwrites the narration that
      // streamed at index 0 a moment earlier — the partial visibly loses its
      // text mid-stream. `blockOffset` shifts each fragment past the previous
      // one within the same dsh step.
      /** Amount added to raw block indices of the fragment being streamed. */
      let blockOffset = 0
      /** Highest rebased index appended in this step, the base for the next fragment. */
      let maxSeenIndex = -1
      /** Last raw index opened by a `content_block_start`; a non-increase marks a restart. */
      let lastRawStart: number | undefined

      /**
       * Close the current dsh step and open the next one at an API-turn boundary.
       * turn() closes whichever step this leaves open (it reads `phase.step`).
       */
      const rollStep = (): void => {
        this.session.append('step/end', { turn, step })
        step += 1
        phase.step = step
        this.session.append('step/start', { turn, step })
        stepFlushed = false
        chunkSeqs.length = 0
        toolCalls.clear()
        reasoningByIndex.clear()
        blockOffset = 0
        maxSeenIndex = -1
        lastRawStart = undefined
      }

      /**
       * Append the coalesced API turn as this step's single `assistant/message`.
       * A no-op when nothing accumulated, so it is safe to call at every
       * boundary.
       */
      const flushAssistant = (): void => {
        if (pendingContent.length === 0) return
        const content = pendingContent
        const usage = pendingUsage
        const model = pendingModel ?? NATIVE_MODEL_LABEL
        pendingContent = []
        pendingUsage = undefined
        pendingModel = undefined
        reasoningByIndex.clear()
        this.session.append('assistant/message', {
          turn,
          step,
          message: createAssistantMessage({
            content,
            source: { provider: PROVIDER, model },
          }),
          ...usage === undefined ? {} : { usage },
        }, {
          surfaceOp: 'append',
          // Link the durable message to the chunks that streamed it, so replay
          // can reconstruct the partial exactly as shown.
          ...chunkSeqs.length === 0 ? {} : { sourceEventSeqs: [...chunkSeqs] },
        })
        stepFlushed = true
      }

      /** Reasoning captured from stream deltas, as content blocks in index order. */
      const streamedReasoning = (): ContentBlock[] => [...reasoningByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => ({ type: 'reasoning' as const, text }))

      signal.throwIfAborted()

      for await (const message of query) {
        signal.throwIfAborted()
        switch (message.type) {
          case 'stream_event': {
            // Subagent (Task) frames carry a parent tool id — route them to
            // their own child session so the UI renders them as a navigable
            // subagent, not as interleaved content in the parent transcript.
            if (message.parent_tool_use_id !== null) {
              const child = getChildSession(message.parent_tool_use_id)
              if (child !== undefined) {
                const event = message.event
                if (event.type === 'content_block_start') {
                  if (child.lastRawStart !== undefined && event.index <= child.lastRawStart) {
                    child.blockOffset = child.maxSeenIndex + 1
                  }
                  child.lastRawStart = event.index
                }
                const chunks = rebaseChunkIndices(mapStreamEvent(event, child.toolCalls), child.blockOffset)
                const highest = maxChunkIndex(chunks)
                if (highest !== undefined && highest > child.maxSeenIndex) child.maxSeenIndex = highest
                for (const chunk of chunks) {
                  child.chunkSeqs.push(child.session.append('assistant/chunk', { turn: child.turn, step: child.step, chunk }).seq)
                  if (chunk.type === 'reasoning-delta') {
                    child.reasoningByIndex.set(chunk.index, (child.reasoningByIndex.get(chunk.index) ?? '') + chunk.text)
                  }
                }
              }
              break
            }
            const event = message.event
            if (event.type === 'content_block_start') {
              // A fragment boundary shows up as a block index that does not
              // advance. Rebase past everything this step already streamed.
              if (lastRawStart !== undefined && event.index <= lastRawStart) {
                blockOffset = maxSeenIndex + 1
              }
              lastRawStart = event.index
            }
            const chunks = rebaseChunkIndices(mapStreamEvent(event, toolCalls), blockOffset)
            const highest = maxChunkIndex(chunks)
            if (highest !== undefined && highest > maxSeenIndex) maxSeenIndex = highest
            for (const chunk of chunks) {
              chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
              if (chunk.type === 'reasoning-delta') {
                reasoningByIndex.set(chunk.index, (reasoningByIndex.get(chunk.index) ?? '') + chunk.text)
              }
            }
            break
          }
          case 'assistant': {
            // Route subagent narration and tool calls to the child session.
            if (message.parent_tool_use_id !== null) {
              const child = getChildSession(message.parent_tool_use_id)
              if (child !== undefined) {
                const mapped = mapAssistantMessage(message.message)
                const messageId = message.message.id
                const reasoningOnlyPending = child.pendingContent.length > 0
                  && child.pendingContent.every(block => block.type === 'reasoning')
                if (child.pendingMessageId !== undefined && messageId !== child.pendingMessageId && !reasoningOnlyPending) {
                  child.flushAssistant()
                }
                if (child.stepFlushed) child.rollStep()
                child.pendingMessageId = messageId
                let content = mapped.content
                const haveReasoning = child.pendingContent.some(block => block.type === 'reasoning')
                  || content.some(block => block.type === 'reasoning')
                if (child.reasoningByIndex.size > 0 && !haveReasoning) {
                  content = [...[...child.reasoningByIndex.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([, text]) => ({ type: 'reasoning' as const, text })), ...content]
                }
                if (content.some(block => block.type === 'reasoning')) child.reasoningByIndex.clear()
                child.pendingContent = [...child.pendingContent, ...content]
                if (mapped.usage !== undefined) child.pendingUsage = mapped.usage
                child.pendingModel = mapped.model
                if (mapped.toolCalls.length > 0) {
                  child.flushAssistant()
                  for (const call of mapped.toolCalls) {
                    child.ownCallIds.add(String(call.callId))
                    child.session.append('tool/call', {
                      turn: child.turn, step: child.step, callId: call.callId, name: call.name, arguments: call.arguments,
                    })
                  }
                }
              }
              break
            }
            const mapped = mapAssistantMessage(message.message)
            const messageId = message.message.id
            // A new API turn: close the coalesced one, and roll the step when
            // this one already published its assistant message. A purely
            // reasoning buffer is NOT closed here — providers that split
            // thinking into its own message give that message its own id, and
            // publishing the thinking alone would let the next message's
            // last-wins projection erase it. It folds into the next turn instead.
            const reasoningOnlyPending = pendingContent.length > 0
              && pendingContent.every(block => block.type === 'reasoning')
            if (pendingMessageId !== undefined && messageId !== pendingMessageId && !reasoningOnlyPending) {
              flushAssistant()
            }
            if (stepFlushed) rollStep()
            pendingMessageId = messageId
            // Thinking fallback: some providers stream thinking deltas but omit
            // thinking blocks from the assistant message. Retain the streamed
            // reasoning so it survives the step's projection.
            let content = mapped.content
            const haveReasoning = pendingContent.some(block => block.type === 'reasoning')
              || content.some(block => block.type === 'reasoning')
            if (reasoningByIndex.size > 0 && !haveReasoning) {
              content = [...streamedReasoning(), ...content]
            }
            if (content.some(block => block.type === 'reasoning')) reasoningByIndex.clear()
            pendingContent = [...pendingContent, ...content]
            if (mapped.usage !== undefined) pendingUsage = mapped.usage
            pendingModel = mapped.model
            if (mapped.toolCalls.length > 0) {
              // Publish the coalesced turn BEFORE its calls so the assistant
              // node's anchor seq stays below the tool nodes it issued.
              flushAssistant()
              for (const call of mapped.toolCalls) {
                ownCallIds.add(String(call.callId))
                this.session.append('tool/call', {
                  turn, step, callId: call.callId, name: call.name, arguments: call.arguments,
                })
              }
            }
            break
          }
          case 'user': {
            // Route subagent tool results to the child session. A `user`
            // message's `parent_tool_use_id` is set for EVERY tool result
            // (not just subagent ones), so we check whether a child session
            // exists for it — only then is it a subagent result.
            if (message.parent_tool_use_id !== null) {
              const child = childSessions.get(message.parent_tool_use_id)
              if (child !== undefined) {
                for (const result of mapToolResults(message.message)) {
                  if (!child.ownCallIds.has(String(result.source.callId))) continue
                  child.session.append('tool/result', { turn: child.turn, step: child.step, message: result }, { surfaceOp: 'append' })
                }
                break
              }
            }
            for (const result of mapToolResults(message.message)) {
              // Only results for calls this query actually published: a nested
              // subagent's tool results go to their child session above.
              if (!ownCallIds.has(String(result.source.callId))) continue
              this.session.append('tool/result', { turn, step, message: result }, { surfaceOp: 'append' })
            }
            break
          }
          case 'result': {
            // Close all child sessions before settling the parent query.
            for (const child of childSessions.values()) child.closeTurn()
            // A query that ended mid-coalescing (trailing text, or thinking that
            // never got a following fragment) publishes it here.
            if (pendingContent.length === 0 && reasoningByIndex.size > 0) {
              pendingContent = streamedReasoning()
            }
            if (pendingContent.length > 0 && stepFlushed) rollStep()
            flushAssistant()
            pendingMessageId = undefined
            if (message.subtype === 'success') {
              finished = true
            } else {
              const summary = message.errors[0] ?? `claude code query failed (${message.subtype})`
              throw new LlmError(summary, failureCode(message.subtype))
            }
            break
          }
          default:
            // Capture task_started metadata so the child session gets the
            // initial prompt and description. Other system/transport messages
            // (init, status, permission, control) are not transcribed.
            if (
              'subtype' in message
              && (message as { subtype?: string }).subtype === 'task_started'
            ) {
              const task = message as {
                tool_use_id?: string
                description?: string
                prompt?: string
                skip_transcript?: boolean
              }
              if (task.tool_use_id !== undefined) {
                // Ambient/housekeeping tasks must stay out of the transcript.
                if (task.skip_transcript === true) {
                  skippedTasks.add(task.tool_use_id)
                  break
                }
                taskMeta.set(task.tool_use_id, {
                  ...task.description === undefined ? {} : { description: task.description },
                  ...task.prompt === undefined ? {} : { prompt: task.prompt },
                })
                // The frames for this task may have arrived first; backfill the
                // prompt into the already-open child rather than losing it.
                childSessions.get(task.tool_use_id)?.seedPrompt(task.prompt)
              }
            }
            break
        }
      }
      if (!finished) {
        throw new LlmError(
          `agent "${this.id}": claude-code query ended without a result message`,
          'CLAUDE_CODE_NO_RESULT',
        )
      }
      return { kind: 'completed' }
    } finally {
      // Close any child sessions that were still open (error/abort path).
      for (const child of childSessions.values()) child.closeTurn()
      signal.removeEventListener('abort', cancel)
      controller.abort()
      for (const line of diagnostics) this.ctx.logger.warn('%s', line)
    }
  }
}
/* jscpd:ignore-end */

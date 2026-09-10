/**
 * Per-session engine routing: the single AgentFactory slot owner, plus the
 * service shadows that let every engine keep its unmodified registration calls
 * while its three siblings are mounted alongside it.
 *
 * The harness admits exactly one AgentFactory (`ctx.agents.setFactory` throws
 * on a second registration), which historically forced the engine to be a
 * process-wide choice. This module inverts that: one {@link LoopEngineRouter}
 * occupies the slot for the life of the process and dispatches each call to
 * the engine that owns the session, so four engines coexist and a session's
 * engine is fixed at creation.
 *
 * The engines themselves are untouched. Each is a `Service` whose constructor
 * runs `ctx.effect(() => ctx.agents.setFactory(this))`; mounting one through a
 * context whose `agents` member is {@link shadowAgents} redirects that call
 * into router registration instead. `ctx.isolate('agents')` cannot do this —
 * a second `AgentRegistry` calls `ctx.accessor('agent', …)`, which is not
 * isolate-scoped, and the duplicate declaration fails the fiber — so the shadow
 * wraps the *same* registry and overrides exactly one method.
 *
 * {@link shadowSystemPrompt} resolves the second collision the same way, for
 * the prompt variables every engine constructor registers under the same names.
 *
 * @module dsh-omniloop/router
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentFactory,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { LoopEngineId } from './settings.ts'

/**
 * The subset of the agent registry the shadow must reproduce. Only
 * `setFactory` is intercepted; everything else forwards to the real service.
 */
interface AgentsLike {
  setFactory(factory: AgentFactory): () => void
}

/**
 * Wrap the real `agents` service so `setFactory` registers with the router
 * instead of the harness slot.
 *
 * Every other member forwards to the real registry. Methods are bound to the
 * target rather than the proxy: `AgentRegistry` keeps its state in private
 * fields, and an unbound method invoked with the proxy as receiver would trip
 * the brand check on those fields.
 *
 * @param agents - the real `ctx.agents` service.
 * @param capture - receives the factory an engine tries to register; its return is handed back as the disposer.
 * @returns a stand-in service to install via `ctx.extend({ agents })`.
 */
export function shadowAgents<T extends AgentsLike>(
  agents: T,
  capture: (factory: AgentFactory) => () => void,
): T {
  return new Proxy(agents, {
    get(target, prop, receiver) {
      if (prop === 'setFactory') return capture
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Resolve the engine that owns a session being resumed. */
export type EngineResolver = (sessionId: string) => Promise<LoopEngineId> | LoopEngineId

/**
 * The subset of the system-prompt service the shadow must reproduce. Only
 * `variable` is intercepted; everything else forwards to the real service.
 */
interface SystemPromptLike {
  variable(name: string, provider: (context: any) => string | undefined): () => void
}

/**
 * Wrap the real `systemPrompt` service so a prompt-variable name that a sibling
 * engine already claimed is ignored instead of throwing.
 *
 * Every engine constructor registers `provider`, `model`, and `cwd` on its
 * mount context. That context carries no scope tag, so all three registrations
 * target the one global prompt layer and the second engine to mount dies with
 * `prompt variable "provider" is already registered`. Under the old design only
 * one engine was ever mounted, so the collision could not arise; hosting all
 * four makes it certain.
 *
 * Scoping the mount contexts would not help: an agent mints its own scope with
 * `createScope(loopCtx, this)` and no `parent`, so `scopeChainOf(agent)` is just
 * `[agent]` — a variable parked on an engine-level scope would be invisible to
 * that engine's own agents. Deduplicating on the global layer is therefore the
 * correct level.
 *
 * Collapsing the three registrations to one is sound because they are
 * byte-identical across the engines and engine-independent by construction:
 * each reads the *assembling* agent's own options (`context.agent?.options`) or
 * its session header, so whichever engine registered first serves every
 * engine's agents with that agent's own values.
 *
 * @param systemPrompt - the real `ctx.systemPrompt` service.
 * @param claim - decides whether this context may own `name`; false means a sibling already did.
 * @returns a stand-in service to install via `ctx.extend({ systemPrompt })`.
 */
export function shadowSystemPrompt<T extends SystemPromptLike>(
  systemPrompt: T,
  claim: (name: string) => boolean,
): T {
  return new Proxy(systemPrompt, {
    get(target, prop, receiver) {
      if (prop === 'variable') {
        return (name: string, provider: (context: any) => string | undefined): (() => void) => {
          if (!claim(name)) return () => {}
          return target.variable(name, provider)
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Compose extra per-agent registrations into the caller's setup callback. */
export type SetupDecorator = (engine: LoopEngineId, agentCtx: Context) => void

/**
 * How many unclaimed reservations the router keeps.
 *
 * A reservation is claimed by the very next `createAgent` for that id, so the
 * live population is normally zero or one. The bound only matters for the
 * degenerate case where a user picks engines repeatedly without ever letting a
 * session be created; the oldest entries are evicted first.
 */
const MAX_RESERVATIONS = 64

/** Wiring the router needs from the plugin that owns it. */
export interface RouterOptions {
  /**
   * The engine a new session gets when it carries no reservation: the profile
   * default from settings.
   */
  engineForNewSession(): LoopEngineId
  /**
   * Record a new session's engine durably, before the engine creates it.
   *
   * Takes the session's `meta` rather than its id alone: the persistence
   * backend keys a session's artifact directory by `cwd`, so a record written
   * without it lands in a directory no resume will look in.
   */
  remember(meta: { readonly id: string; readonly cwd?: string }, engine: LoopEngineId): Promise<void>
  /** Recover a persisted session's engine. */
  resolve: EngineResolver
  /**
   * Registers engine-specific per-agent contributions (skill providers) into
   * the agent's own scope layer. Invoked with the scope-tagged `agentCtx` the
   * engine passes to `setup`, so the harness's layered skill registry filters
   * them to that session automatically.
   */
  decorateSetup?: SetupDecorator
}

/**
 * The process's sole AgentFactory. Holds one candidate per engine and forwards
 * `createAgent` / `resume` to the right one.
 *
 * Forwarding is contract-compliant by construction: both factory methods are
 * per-call and take the caller's `ownerCtx`, which the contract requires the
 * implementation to attach lifecycle to ("it must not infer ownership from the
 * factory object's registration context"). The router passes it through
 * verbatim, so the engine owns the transaction exactly as if it had been
 * registered directly.
 */
export class LoopEngineRouter implements AgentFactory {
  private readonly engines = new Map<LoopEngineId, AgentFactory>()

  /**
   * Engines claimed for session ids that do not exist yet.
   *
   * Agent creation is eager — the harness calls `createAgent` when a session is
   * opened, not when its first prompt is sent — so a client that wants a
   * specific engine cannot ask for it after the fact. Instead it mints the
   * session id itself, reserves the engine here, and only then asks the host to
   * create that id. Insertion order is the eviction order (Map preserves it).
   */
  private readonly reservations = new Map<string, LoopEngineId>()

  constructor(private readonly options: RouterOptions) {}

  /**
   * Claim an engine for a session id the caller is about to create.
   *
   * The reservation is consumed by the first `createAgent` for that id, so it
   * cannot leak into a later session that happens to reuse the id.
   *
   * @param sessionId - id the caller will pass to session creation.
   * @param engine - engine that session must run on.
   */
  reserve(sessionId: string, engine: LoopEngineId): void {
    // Re-inserting moves the id to the end of the eviction order, which is what
    // a user changing their mind before creating should get.
    this.reservations.delete(sessionId)
    this.reservations.set(sessionId, engine)
    // A non-empty Map always yields a key, so the loop condition alone bounds
    // this; `next()` cannot report done while size exceeds the limit.
    for (const oldest of this.reservations.keys()) {
      if (this.reservations.size <= MAX_RESERVATIONS) break
      this.reservations.delete(oldest)
    }
  }

  /**
   * Take the engine a new session should run on: its reservation when it has
   * one, the profile default otherwise.
   */
  private claim(sessionId: string): LoopEngineId {
    const reserved = this.reservations.get(sessionId)
    if (reserved === undefined) return this.options.engineForNewSession()
    this.reservations.delete(sessionId)
    return reserved
  }

  /**
   * Register one engine's factory as a routing candidate.
   * @param engine - the engine id this factory implements.
   * @param factory - the engine's factory, captured from its `setFactory` call.
   * @returns a disposer that withdraws the candidate.
   */
  register(engine: LoopEngineId, factory: AgentFactory): () => void {
    this.engines.set(engine, factory)
    return () => {
      if (this.engines.get(engine) === factory) this.engines.delete(engine)
    }
  }

  /** The shadow to install on the context that mounts `engine`. */
  shadowFor<T extends AgentsLike>(engine: LoopEngineId, agents: T): T {
    return shadowAgents(agents, factory => this.register(engine, factory))
  }

  /**
   * Look up a mounted engine, failing loud when it is selected but absent.
   * A silent fallback would run the session on an engine that cannot read its
   * history, which is the exact defect per-session routing exists to remove.
   */
  private factoryFor(engine: LoopEngineId): AgentFactory {
    const factory = this.engines.get(engine)
    if (factory === undefined) {
      throw new Error(
        `loop-engine: engine "${engine}" is not mounted (mounted: ${[...this.engines.keys()].join(', ') || 'none'})`,
      )
    }
    return factory
  }

  /** Wrap the caller's setup so the engine's per-agent registrations land in the agent's scope. */
  private withSetup(engine: LoopEngineId, setup: AgentSetup | undefined): AgentSetup | undefined {
    const decorate = this.options.decorateSetup
    if (decorate === undefined) return setup
    return (agentCtx, agent) => {
      decorate(engine, agentCtx)
      return setup?.(agentCtx, agent)
    }
  }

  /**
   * Create a session on the engine it reserved, or on the profile default when
   * it made no reservation. The engine is recorded durably *before* delegation:
   * a crash between the two leaves an orphan record (harmless — no session ever
   * reads it), whereas the reverse order would leave a session whose engine
   * cannot be recovered.
   *
   * `options.meta.cwd` is forwarded to the record so the sidecar lands in the
   * same per-project directory the backend will write the session into.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const engine = this.claim(options.sessionId)
    const factory = this.factoryFor(engine)
    await this.options.remember(
      { id: options.sessionId, ...options.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd } },
      engine,
    )
    const setup = this.withSetup(engine, options.setup)
    return await factory.createAgent(ownerCtx, {
      ...options,
      ...setup === undefined ? {} : { setup },
    })
  }

  /** Resume a session on the engine that created it. */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const engine = await this.options.resolve(options.resumeSessionId)
    const factory = this.factoryFor(engine)
    const setup = this.withSetup(engine, options.setup)
    return await factory.resume(ownerCtx, {
      ...options,
      ...setup === undefined ? {} : { setup },
    })
  }
}

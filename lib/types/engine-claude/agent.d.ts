/**
 * Claude Code loop Agent: drives one session through turn and step boundaries
 * with one Claude Agent SDK query per step. Claude Code owns its prompt,
 * tools, and permissions; the durable session log remains the source of truth
 * and the query prompt is a pure serialization of it.
 *
 * @module dsh-agent-hub/engine-claude/agent
 */
import type { Agent, AgentCancelCause, AgentOptions, AgentStatus, CancelOptions, InboxTarget } from '@deepseek-ai/dsh-agent';
import { Inbox } from '@deepseek-ai/dsh-agent';
import type { Scope } from '@deepseek-ai/dsh-scope';
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './types.ts';
/** Drives one session through turn and step boundaries on Claude Code. */
export declare class ClaudeCodeAgent implements Agent {
    private loopCtx;
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    private readonly config;
    readonly inbox: Inbox;
    private phase;
    private activityDone;
    /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
    readonly scope: Scope;
    readonly ctx: Context;
    /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
    private readonly dispatch;
    /** Whether this loop instance has appended its initial/resume request anchor. */
    private requestHeaderLogged;
    constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, config: ResolvedConfig);
    get status(): AgentStatus;
    /** Commit a phase and publish its externally visible status transition. */
    private setPhase;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    /**
     * Queue a message for the next turn and wake the driver.
     * @param input - the user message to deliver.
     */
    followup(input: UserMessage): void;
    /**
     * Queue a message for the running step and wake the driver.
     * @param input - the user message to deliver.
     */
    steer(input: UserMessage): void;
    /**
     * Queue a message for the running step without waking the driver.
     * @param input - the user message to deliver.
     */
    inject(input: UserMessage): void;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    /**
     * Run a maintenance job while the agent is idle.
     * @param job - the maintenance operation, receiving the phase abort signal.
     * @returns the maintenance result.
     */
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
    /**
     * Start one driver, or latch its wake behind maintenance or an aborted
     * activity. A wake sent while idle always opens its turn boundary, even
     * when its message was cleared; only a latched replay is suppressed when
     * the queue no longer holds the wake.
     * @param wakeAfterAbort - the {@link send} classification, captured before
     *   the inbox insertion so a reentrant cancel cannot reclassify it.
     */
    private wakeDriver;
    whenIdle(): Promise<void>;
    /** Report one failure at its live boundary, then preserve it for driver containment. */
    private throwError;
    private kick;
    private preStep;
    /**
     * Scan the step's user messages for `/name` skill gestures, load each
     * matching skill, and inject the rendered skill content into the message
     * batch.  This mirrors what dsh-tool-skill does for the in-process engine.
     * @param messages - the current step's message batch.
     * @param signal - cancellation signal (aborted loads are silently dropped).
     * @returns the original batch when no skill was invoked, or an extended
     *   batch with injected skill-content messages appended.
     */
    private injectSkills;
    /**
     * Resolve the native permission handling for one query. A deployment-pinned
     * mode wins outright; otherwise the session's durable dsh permission knobs
     * decide per query (mid-session preset switches included): full access
     * bypasses native checks, an `ask` policy forwards each native permission
     * request to the dsh approval seam, and anything else fails closed with the
     * unattended deny-all stance.
     * @returns the permission fields of the query spec.
     */
    private queryPermission;
    /** Open one turn before claiming its first proposed step. */
    private turn;
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
    private resolveModel;
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
    private selectionFromWaterfall;
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
    private noteRequestHeader;
    /** Run one Claude Code query for the current step and map its transcript into the session log. */
    private step;
}
//# sourceMappingURL=agent.d.ts.map